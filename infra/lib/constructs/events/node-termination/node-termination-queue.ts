/**
 * @format
 * Node Termination Handler (NTH) — SQS Queue + Event Plumbing
 *
 * Centralises the AWS-side wiring needed for `aws-node-termination-handler`
 * (queue mode, the production-hardened pattern). NTH polls a single SQS
 * queue for every event that should trigger a Kubernetes drain:
 *
 *   1. ASG `INSTANCE_TERMINATING` lifecycle hook events (the action-gating
 *      path — ASG waits up to `heartbeatTimeout` for NTH to call
 *      CompleteLifecycleAction before terminating the instance).
 *   2. EC2 Spot Instance Interruption Warning (~2 min notice from EC2).
 *   3. EC2 Instance Rebalance Recommendation (proactive scale-out signal).
 *   4. AWS Health scheduled instance events (retirement, host maintenance).
 *
 * Coexistence with the existing ops-alerts pipeline (kubernetes-bootstrap
 * `bootstrap-alarm.ts`):
 *   - That pipeline subscribes EventBridge rules for `EC2 Instance
 *     Launch/Terminate Successful` to an SNS topic → email. Those events
 *     fire AFTER the instance is gone, so they're useless to NTH.
 *   - The new EventBridge rules created here (Spot interrupt, rebalance,
 *     scheduled) target BOTH this SQS queue AND the existing ops SNS topic
 *     (when its ARN is provided), giving operators email visibility on
 *     drain-driving events without duplicating subscriptions.
 *   - Lifecycle-hook events do NOT route through SNS — latency-critical
 *     and the hook target must be a single ARN per hook.
 *
 * IAM model:
 *   - Exposed `nodePolicy` is a ManagedPolicy that the calling stack
 *     attaches to the worker node IAM role. This avoids an OIDC/IRSA
 *     setup (which kubeadm clusters don't have natively) by inheriting
 *     pod permissions from the underlying node. Permissions are scoped
 *     to the specific queue ARN and ASG ARNs — over-permission risk is
 *     limited to "spam complete-lifecycle-action against your own ASGs".
 *
 * Operational alarms:
 *   - DLQ depth > 0 → ops SNS (drain failed five times; manual triage).
 *   - Main-queue oldest-message age > 5 min → ops SNS (NTH is not
 *     consuming, possibly pod down or token expired).
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as hooktargets from 'aws-cdk-lib/aws-autoscaling-hooktargets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';


import { Construct } from 'constructs';

export interface NodeTerminationHandlerQueueProps {
    /**
     * Resource-name prefix (e.g. `k8s-development`). Drives queue / DLQ /
     * EventBridge rule / IAM policy names.
     */
    readonly namePrefix: string;

    /**
     * ARNs of the AutoScalingGroups whose lifecycle hooks will publish to
     * this queue. Used to scope `autoscaling:CompleteLifecycleAction` IAM
     * permissions on the node policy.
     */
    readonly autoScalingGroupArns: string[];

    /**
     * Existing ops-alerts SNS topic (typically the bootstrap-alarm topic
     * from kubernetes-bootstrap). When provided:
     *   - Spot/Rebalance/Scheduled EventBridge rules add this topic as a
     *     second target so operators get email visibility on drain events.
     *   - Queue-health CloudWatch alarms (DLQ depth, message age) publish
     *     here.
     *
     * Optional. Omit during local synth or test.
     */
    readonly opsAlertsTopic?: sns.ITopic;
}

export class NodeTerminationHandlerQueue extends Construct {
    /** Main SQS queue NTH polls. */
    public readonly queue: sqs.Queue;

    /** Dead-letter queue. Messages land here after 5 failed receives. */
    public readonly deadLetterQueue: sqs.Queue;

    /**
     * Lifecycle-hook target. Pass to `autoScalingGroup.addLifecycleHook(...)`
     * via the `notificationTarget` prop. CDK will attach the IAM role and
     * permissions needed for the ASG to publish to this queue.
     */
    public readonly hookTarget: autoscaling.ILifecycleHookTarget;

    /**
     * IAM ManagedPolicy granting NTH the runtime permissions it needs.
     * Attach to the worker node IAM role (`asg.role.addManagedPolicy(...)`).
     */
    public readonly nodePolicy: iam.ManagedPolicy;

    constructor(scope: Construct, id: string, props: NodeTerminationHandlerQueueProps) {
        super(scope, id);

        // ------------------------------------------------------------------
        // Queues
        // ------------------------------------------------------------------
        // DLQ retention is generous — drain failures are rare but worth
        // keeping the message body around for post-mortem.
        this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
            queueName: `${props.namePrefix}-nth-dlq`,
            retentionPeriod: cdk.Duration.days(14),
            encryption: sqs.QueueEncryption.KMS_MANAGED,
            enforceSSL: true,
        });

        // Main queue:
        //  - retentionPeriod 5 min: NTH polls every few seconds; older
        //    messages mean NTH is broken, alarm fires, no point keeping
        //    stale lifecycle events around.
        //  - visibilityTimeout 60s: drain typically takes <30s; covers
        //    PDB-blocked retries without holding the message hostage.
        //  - maxReceiveCount 5: matches NTH default, generous for transient
        //    Kubernetes API blips.
        this.queue = new sqs.Queue(this, 'Queue', {
            queueName: `${props.namePrefix}-nth`,
            retentionPeriod: cdk.Duration.minutes(5),
            visibilityTimeout: cdk.Duration.seconds(60),
            encryption: sqs.QueueEncryption.KMS_MANAGED,
            enforceSSL: true,
            deadLetterQueue: {
                queue: this.deadLetterQueue,
                maxReceiveCount: 5,
            },
        });

        this.hookTarget = new hooktargets.QueueHook(this.queue);

        // ------------------------------------------------------------------
        // EventBridge rules — Spot interruption / rebalance / scheduled
        //
        // Each rule has up to two targets: the NTH queue (for action) and
        // the ops SNS topic (for visibility). The SNS topic is optional;
        // when absent the rule degrades to NTH-only.
        // ------------------------------------------------------------------
        const ruleTargets = (extra?: events.IRuleTarget): events.IRuleTarget[] => {
            const out: events.IRuleTarget[] = [new eventTargets.SqsQueue(this.queue)];
            if (props.opsAlertsTopic) {
                out.push(new eventTargets.SnsTopic(props.opsAlertsTopic));
            }
            if (extra) out.push(extra);
            return out;
        };

        new events.Rule(this, 'SpotInterruption', {
            ruleName: `${props.namePrefix}-nth-spot-interruption`,
            description: 'EC2 Spot interruption warnings → NTH drain + ops alert',
            eventPattern: {
                source: ['aws.ec2'],
                detailType: ['EC2 Spot Instance Interruption Warning'],
            },
            targets: ruleTargets(),
        });

        new events.Rule(this, 'SpotRebalance', {
            ruleName: `${props.namePrefix}-nth-spot-rebalance`,
            description: 'EC2 Spot rebalance recommendations → NTH proactive drain',
            eventPattern: {
                source: ['aws.ec2'],
                detailType: ['EC2 Instance Rebalance Recommendation'],
            },
            targets: ruleTargets(),
        });

        new events.Rule(this, 'ScheduledEvent', {
            ruleName: `${props.namePrefix}-nth-scheduled`,
            description: 'AWS Health scheduled instance events → NTH drain',
            eventPattern: {
                source: ['aws.health'],
                detailType: ['AWS Health Event'],
                detail: {
                    service: ['EC2'],
                    eventTypeCategory: ['scheduledChange'],
                },
            },
            targets: ruleTargets(),
        });

        // ------------------------------------------------------------------
        // Node IAM policy
        //
        // Attached by the calling stack to the worker node role. Pods on
        // those nodes (NTH DaemonSet) inherit these permissions via the
        // instance metadata service. This is the standard pattern for
        // kubeadm clusters that don't run an OIDC provider.
        //
        // Scope:
        //  - sqs:* on this queue ARN only
        //  - autoscaling:CompleteLifecycleAction on the listed ASG ARNs
        //  - ec2:DescribeInstances (resource-level not supported, but
        //    read-only and standard for any cluster controller)
        // ------------------------------------------------------------------
        this.nodePolicy = new iam.ManagedPolicy(this, 'NodePolicy', {
            managedPolicyName: `${props.namePrefix}-nth-node-policy`,
            description: 'Permissions required by aws-node-termination-handler',
            statements: [
                new iam.PolicyStatement({
                    sid: 'NthQueueAccess',
                    actions: [
                        'sqs:ReceiveMessage',
                        'sqs:DeleteMessage',
                        'sqs:GetQueueAttributes',
                        'sqs:GetQueueUrl',
                    ],
                    resources: [this.queue.queueArn],
                }),
                new iam.PolicyStatement({
                    sid: 'NthCompleteLifecycleAction',
                    actions: ['autoscaling:CompleteLifecycleAction'],
                    resources: props.autoScalingGroupArns,
                }),
                new iam.PolicyStatement({
                    sid: 'NthDescribeInstances',
                    actions: [
                        'ec2:DescribeInstances',
                        'autoscaling:DescribeAutoScalingInstances',
                        'autoscaling:DescribeTags',
                    ],
                    resources: ['*'],
                }),
            ],
        });

        // ------------------------------------------------------------------
        // Operational alarms (only when ops SNS is wired)
        // ------------------------------------------------------------------
        if (props.opsAlertsTopic) {
            const dlqDepthAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
                alarmName: `${props.namePrefix}-nth-dlq-non-empty`,
                alarmDescription:
                    'NTH dead-letter queue has messages — drain failed five times for at least one node. Manual triage required.',
                metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
                    period: cdk.Duration.minutes(5),
                    statistic: 'Maximum',
                }),
                threshold: 0,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                evaluationPeriods: 1,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            dlqDepthAlarm.addAlarmAction(new cwActions.SnsAction(props.opsAlertsTopic));

            const messageAgeAlarm = new cloudwatch.Alarm(this, 'OldestMessageAgeAlarm', {
                alarmName: `${props.namePrefix}-nth-queue-stale`,
                alarmDescription:
                    'NTH queue has messages older than 5 minutes — handler likely down. Drain events are queueing without action.',
                metric: this.queue.metricApproximateAgeOfOldestMessage({
                    period: cdk.Duration.minutes(1),
                    statistic: 'Maximum',
                }),
                threshold: cdk.Duration.minutes(5).toSeconds(),
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                evaluationPeriods: 5,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            messageAgeAlarm.addAlarmAction(new cwActions.SnsAction(props.opsAlertsTopic));
        }
    }
}
