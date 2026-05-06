/**
 * @format
 * EKS Pod Identity Stack — IAM-to-ServiceAccount associations.
 *
 * One IAM role per binding (least-privilege per purpose), each linked to a
 * Kubernetes ServiceAccount via `CfnPodIdentityAssociation`. Replaces IRSA.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 4
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';


import { type PodIdentityBinding } from '../../config/eks';
import { type Environment } from '../../config/environments';

export interface EksPodIdentityStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly bindings: readonly PodIdentityBinding[];
    readonly karpenterInterruptionQueueArn: string;
    readonly workerNodeRoleArn: string;
    readonly hostedZoneIds: readonly string[];
}

export class EksPodIdentityStack extends cdk.Stack {
    public readonly roles: Record<string, iam.Role> = {};

    constructor(scope: Construct, id: string, props: EksPodIdentityStackProps) {
        super(scope, id, props);

        // Foundational EKS managed addons live HERE — not in EksAddonsStack —
        // so a Helm-chart failure downstream cannot trigger a CFN rollback
        // that deletes the agent. Without the agent DaemonSet present on
        // every node, every PodIdentityAssociation downstream is a no-op:
        // workloads hit 169.254.170.23 and get `connection refused`,
        // CrashLoopBackOff, then Helm `wait: true` times out → CREATE_FAILED
        // → rollback → addon deleted → next deploy hits the same loop.
        new eks.CfnAddon(this, 'VpcCni', {
            clusterName: props.cluster.clusterName,
            addonName: 'vpc-cni',
            resolveConflicts: 'OVERWRITE',
        });

        new eks.CfnAddon(this, 'PodIdentityAgent', {
            clusterName: props.cluster.clusterName,
            addonName: 'eks-pod-identity-agent',
            resolveConflicts: 'OVERWRITE',
        });

        // CoreDNS — EKS auto-installs the Deployment without our system
        // toleration. Default scheduling fails on a single-pool cluster
        // where every node has `dedicated=system:NoSchedule`. Pending
        // CoreDNS → no cluster DNS → every Helm chart that resolves an
        // AWS endpoint at boot (Karpenter, ALB controller, ESO) fails
        // its API connectivity check and CrashLoops, which in turn
        // causes the Helm `wait: true` custom resource to time out and
        // rolls the addons stack back. Managed addon with explicit
        // tolerations side-steps the issue and stays put across stack
        // rollbacks because it lives here, not in EksAddonsStack.
        new eks.CfnAddon(this, 'CoreDns', {
            clusterName: props.cluster.clusterName,
            addonName: 'coredns',
            resolveConflicts: 'OVERWRITE',
            configurationValues: JSON.stringify({
                tolerations: [
                    { key: 'dedicated', value: 'system', effect: 'NoSchedule' },
                    { key: 'CriticalAddonsOnly', operator: 'Exists' },
                ],
            }),
        });

        // kube-proxy — same scheduling issue as CoreDNS would apply if
        // EKS shipped it as a Deployment, but it's a DaemonSet that
        // tolerates everything by default. Still pin via managed addon
        // so version is in lock-step with the cluster control plane
        // (kube-proxy/kubelet skew is the #1 EKS upgrade footgun).
        new eks.CfnAddon(this, 'KubeProxy', {
            clusterName: props.cluster.clusterName,
            addonName: 'kube-proxy',
            resolveConflicts: 'OVERWRITE',
        });

        const podIdentityPrincipal = new iam.ServicePrincipal('pods.eks.amazonaws.com');

        for (const b of props.bindings) {
            const role = new iam.Role(this, `Role-${b.purpose}`, {
                assumedBy: podIdentityPrincipal,
                description: `Pod Identity role for ${b.namespace}/${b.serviceAccount}`,
            });
            // EKS Pod Identity requires `sts:TagSession` on top of the default
            // `sts:AssumeRole` so the service can attach session tags
            // (eks-cluster-arn, kubernetes-namespace, etc). Without it, the
            // PodIdentityAssociation create call rejects the role with
            // "Trust policy of the role provided is invalid".
            role.assumeRolePolicy?.addStatements(
                new iam.PolicyStatement({
                    actions: ['sts:TagSession'],
                    principals: [podIdentityPrincipal],
                }),
            );
            this.attachPurposePolicies(role, b.purpose, props);
            this.roles[b.purpose] = role;

            new eks.CfnPodIdentityAssociation(this, `Assoc-${b.purpose}`, {
                clusterName: props.cluster.clusterName,
                namespace: b.namespace,
                serviceAccount: b.serviceAccount,
                roleArn: role.roleArn,
            });
        }
    }

    private attachPurposePolicies(
        role: iam.Role,
        purpose: PodIdentityBinding['purpose'],
        props: EksPodIdentityStackProps,
    ): void {
        switch (purpose) {
            case 'karpenter':
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'sqs:ReceiveMessage',
                            'sqs:DeleteMessage',
                            'sqs:GetQueueAttributes',
                        ],
                        resources: [props.karpenterInterruptionQueueArn],
                    }),
                );
                // EKS control-plane introspection — Karpenter calls
                // DescribeCluster at startup to resolve the cluster endpoint
                // and CA cert. Without this, the controller crashes with
                // 'failed to resolve cluster endpoint'.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: ['eks:DescribeCluster'],
                        resources: ['*'],
                    }),
                );
                // Karpenter v1 manages EC2 instance profiles for nodes it
                // launches — creates one per EC2NodeClass, attaches the
                // worker node role, deletes on NodePool teardown. All these
                // actions must succeed or Karpenter blocks scheduling.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'iam:CreateInstanceProfile',
                            'iam:DeleteInstanceProfile',
                            'iam:GetInstanceProfile',
                            'iam:ListInstanceProfiles',
                            'iam:TagInstanceProfile',
                            'iam:AddRoleToInstanceProfile',
                            'iam:RemoveRoleFromInstanceProfile',
                        ],
                        resources: ['*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'ec2:RunInstances',
                            'ec2:CreateTags',
                            'ec2:CreateLaunchTemplate',
                            'ec2:CreateFleet',
                            'ec2:DescribeInstances',
                            'ec2:DescribeImages',
                            'ec2:DescribeInstanceTypes',
                            'ec2:DescribeInstanceTypeOfferings',
                            'ec2:DescribeSubnets',
                            'ec2:DescribeSecurityGroups',
                            'ec2:DescribeAvailabilityZones',
                            'ec2:DescribeSpotPriceHistory',
                            'ec2:DescribeLaunchTemplates',
                            'ec2:DescribeLaunchTemplateVersions',
                            'ec2:TerminateInstances',
                            'ec2:DeleteLaunchTemplate',
                            'pricing:GetProducts',
                        ],
                        resources: ['*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: ['iam:PassRole'],
                        resources: [props.workerNodeRoleArn],
                    }),
                );
                // Karpenter resolves AMI aliases (e.g. `al2023@latest`) by
                // reading EKS-published SSM parameters under
                // /aws/service/eks/optimized-ami/*. Without this, alias
                // discovery silently returns zero AMIs and EC2NodeClass
                // stays AMIsReady=Unknown ("DependenciesNotReady"), which
                // blocks every NodePool from provisioning.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: ['ssm:GetParameter'],
                        resources: [
                            `arn:aws:ssm:${cdk.Stack.of(this).region}::parameter/aws/service/eks/optimized-ami/*`,
                            `arn:aws:ssm:${cdk.Stack.of(this).region}::parameter/aws/service/bottlerocket/*`,
                        ],
                    }),
                );
                break;
            case 'alb-controller':
                // V1: coarse policy. Replace with vendored AWS-published JSON
                // before V2 ingress migration. Tracked in spec § 10.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'elasticloadbalancing:*',
                            'ec2:Describe*',
                            'acm:DescribeCertificate',
                            'iam:CreateServiceLinkedRole',
                            'wafv2:GetWebACL',
                            'wafv2:AssociateWebACL',
                        ],
                        resources: ['*'],
                    }),
                );
                break;
            case 'external-dns':
                if (props.hostedZoneIds.length > 0) {
                    role.addToPolicy(
                        new iam.PolicyStatement({
                            actions: ['route53:ChangeResourceRecordSets'],
                            resources: props.hostedZoneIds.map(
                                (z) => `arn:aws:route53:::hostedzone/${z}`,
                            ),
                        }),
                    );
                }
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: ['route53:ListHostedZones', 'route53:ListResourceRecordSets'],
                        resources: ['*'],
                    }),
                );
                break;
            case 'external-secrets':
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'ssm:GetParameter',
                            'ssm:GetParameters',
                            'ssm:GetParametersByPath',
                            'secretsmanager:GetSecretValue',
                            'secretsmanager:DescribeSecret',
                            'kms:Decrypt',
                        ],
                        resources: ['*'],
                    }),
                );
                break;
            case 'ebs-csi':
                role.addManagedPolicy(
                    iam.ManagedPolicy.fromAwsManagedPolicyName(
                        'service-role/AmazonEBSCSIDriverPolicy',
                    ),
                );
                break;
        }
    }
}
