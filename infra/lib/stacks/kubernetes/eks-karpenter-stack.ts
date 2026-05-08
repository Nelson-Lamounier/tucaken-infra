/**
 * @format
 * EKS Karpenter Stack — SQS interruption queue + EventBridge wiring +
 * NodePool/EC2NodeClass CRDs.
 *
 * The Karpenter Helm chart is installed by EksAddonsStack; this stack
 * supplies the runtime data plane (queue, CRDs).
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md §§ 3.2, 3.3
 */
import { NagSuppressions } from 'cdk-nag';

import * as eks from 'aws-cdk-lib/aws-eks';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { EksKarpenterNodePoolConfig } from '../../config/eks';
import { Environment } from '../../config/environments';

export interface EksKarpenterStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly workerNodeRole: iam.IRole;
    /**
     * SSM parameter path that holds the EKS workers security group ID.
     * Resolved at deploy time via SSM dynamic reference — avoids CFN
     * cross-stack exports (repo convention; see CLAUDE.md).
     */
    readonly workerSecurityGroupIdSsmPath: string;
    readonly subnetTagKey: string;
    readonly karpenter: EksKarpenterNodePoolConfig;
}

export class EksKarpenterStack extends cdk.Stack {
    public readonly interruptionQueue: sqs.Queue;

    constructor(scope: Construct, id: string, props: EksKarpenterStackProps) {
        super(scope, id, props);

        // Resolve the workers SG ID at deploy time from SSM. Avoids the
        // CFN cross-stack export that would otherwise tie EksKarpenter's
        // template to BaseStack's export name (CLAUDE.md convention).
        const workerSecurityGroupId = ssm.StringParameter.valueForStringParameter(
            this,
            props.workerSecurityGroupIdSsmPath,
        );

        this.interruptionQueue = new sqs.Queue(this, 'InterruptionQueue', {
            queueName: `${props.cluster.clusterName}-karpenter`,
            retentionPeriod: cdk.Duration.minutes(5),
            enforceSSL: true,
        });
        this.interruptionQueue.addToResourcePolicy(
            new iam.PolicyStatement({
                principals: [
                    new iam.ServicePrincipal('events.amazonaws.com'),
                    new iam.ServicePrincipal('sqs.amazonaws.com'),
                ],
                actions: ['sqs:SendMessage'],
                resources: [this.interruptionQueue.queueArn],
            }),
        );
        // Interruption messages are ephemeral signals consumed by Karpenter;
        // a DLQ adds operational complexity without recovery value (5-min TTL
        // means lost messages are stale by the time a DLQ would help).
        NagSuppressions.addResourceSuppressions(this.interruptionQueue, [
            {
                id: 'AwsSolutions-SQS3',
                reason: 'Karpenter interruption queue: 5-minute retention; DLQ adds no value for ephemeral signals.',
            },
        ]);

        const ruleSpecs: { id: string; source: string; detailType: string }[] = [
            { id: 'SpotInterruption', source: 'aws.ec2', detailType: 'EC2 Spot Instance Interruption Warning' },
            { id: 'ScheduledChange', source: 'aws.health', detailType: 'AWS Health Event' },
            { id: 'InstanceTerminating', source: 'aws.ec2', detailType: 'EC2 Instance State-change Notification' },
            { id: 'RebalanceRecommendation', source: 'aws.ec2', detailType: 'EC2 Instance Rebalance Recommendation' },
        ];
        for (const r of ruleSpecs) {
            new events.Rule(this, `Rule${r.id}`, {
                eventPattern: { source: [r.source], detailType: [r.detailType] },
                targets: [new eventsTargets.SqsQueue(this.interruptionQueue)],
            });
        }

        // Apply EC2NodeClass + NodePool as Kubernetes manifests.
        // Role name (not ARN) is required by Karpenter EC2NodeClass.spec.role.
        new eks.KubernetesManifest(this, 'EC2NodeClass', {
            cluster: props.cluster,
            manifest: [
                {
                    apiVersion: 'karpenter.k8s.aws/v1',
                    kind: 'EC2NodeClass',
                    metadata: { name: 'workloads-default-class' },
                    spec: {
                        // Karpenter v1 requires amiSelectorTerms. The AL2023
                        // alias resolves to the EKS-optimized AL2023 AMI for
                        // the cluster's Kubernetes version automatically.
                        amiFamily: 'AL2023',
                        amiSelectorTerms: [{ alias: 'al2023@latest' }],
                        role: cdk.Fn.select(1, cdk.Fn.split('/', props.workerNodeRole.roleArn)),
                        subnetSelectorTerms: [{ tags: { [props.subnetTagKey]: 'shared' } }],
                        // BOTH SGs attach to every Karpenter-launched node:
                        //   workerSecurityGroupId — custom `eks-workers-<env>`
                        //     SG (BaseStack), node-to-node + future ELB rules.
                        //   clusterSecurityGroup — EKS-auto-managed cluster
                        //     SG carrying the control-plane ↔ kubelet rules
                        //     EKS injects on cluster create. Without this,
                        //     new nodes register-fail (`NodeNotFound`)
                        //     because the API server can't reach them on
                        //     :10250.
                        securityGroupSelectorTerms: [
                            { id: workerSecurityGroupId },
                            { id: props.cluster.clusterSecurityGroupId },
                        ],
                        tags: { 'eks-cluster-pool': 'workloads-default' },
                    },
                },
            ],
        });

        new eks.KubernetesManifest(this, 'NodePool', {
            cluster: props.cluster,
            manifest: [
                {
                    apiVersion: 'karpenter.sh/v1',
                    kind: 'NodePool',
                    metadata: { name: 'workloads-default' },
                    spec: {
                        template: {
                            spec: {
                                nodeClassRef: {
                                    group: 'karpenter.k8s.aws',
                                    kind: 'EC2NodeClass',
                                    name: 'workloads-default-class',
                                },
                                requirements: [
                                    {
                                        key: 'karpenter.k8s.aws/instance-category',
                                        operator: 'In',
                                        values: [...props.karpenter.instanceCategory],
                                    },
                                    {
                                        key: 'karpenter.k8s.aws/instance-family',
                                        operator: 'In',
                                        values: [...props.karpenter.instanceFamily],
                                    },
                                    {
                                        key: 'karpenter.sh/capacity-type',
                                        operator: 'In',
                                        values: [...props.karpenter.capacityType],
                                    },
                                    {
                                        key: 'kubernetes.io/arch',
                                        operator: 'In',
                                        values: [...props.karpenter.architectures],
                                    },
                                    {
                                        key: 'karpenter.k8s.aws/instance-cpu',
                                        operator: 'Gt',
                                        values: [String(props.karpenter.cpuMin - 1)],
                                    },
                                    {
                                        key: 'karpenter.k8s.aws/instance-cpu',
                                        operator: 'Lt',
                                        values: [String(props.karpenter.cpuMax + 1)],
                                    },
                                ],
                                expireAfter: '720h',
                            },
                        },
                        disruption: { consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s' },
                        limits: { cpu: 100 },
                    },
                },
            ],
        });
    }
}
