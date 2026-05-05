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

        const podIdentityPrincipal = new iam.ServicePrincipal('pods.eks.amazonaws.com');

        for (const b of props.bindings) {
            const role = new iam.Role(this, `Role-${b.purpose}`, {
                assumedBy: podIdentityPrincipal,
                description: `Pod Identity role for ${b.namespace}/${b.serviceAccount}`,
            });
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
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'ec2:RunInstances',
                            'ec2:CreateTags',
                            'ec2:CreateLaunchTemplate',
                            'ec2:DescribeInstances',
                            'ec2:DescribeImages',
                            'ec2:DescribeInstanceTypes',
                            'ec2:DescribeSubnets',
                            'ec2:DescribeSecurityGroups',
                            'ec2:DescribeAvailabilityZones',
                            'ec2:DescribeSpotPriceHistory',
                            'ec2:DescribeLaunchTemplates',
                            'ec2:TerminateInstances',
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
