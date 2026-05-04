/**
 * @format
 * Auto Scaling Group Construct
 *
 * Reusable Auto Scaling Group construct — a pure blueprint for ASG creation.
 * ONLY accepts LaunchTemplate from the stack. No internal resource creation.
 *
 * Features:
 * - Accepts LaunchTemplate from stack (required)
 * - CPU-based target tracking scaling policy
 * - Rolling update policy for safe deployments
 * - Health check grace period configuration
 * - SNS notification topic for scaling events (exposed for subscription)
 * - Termination lifecycle hook for EBS detach patterns
 *
 * Design Philosophy:
 * - Construct is a blueprint, not a configuration handler
 * - Stack creates LaunchTemplateConstruct → passes launchTemplate here
 * - Stack creates SecurityGroupConstruct → passes to LaunchTemplateConstruct
 * - This construct handles ASG-specific logic ONLY
 *
 * Naming convention:
 * The `namePrefix` prop is expected to be environment-aware (e.g.,
 * 'monitoring-development', 'nextjs-ecs-production'). It is used in the ASG name,
 * SNS topic name, and lifecycle hook name to prevent collision across environments.
 *
 * Tag strategy:
 * Only `Component: AutoScalingGroup` is applied here. Organizational tags
 * (Environment, Project, Owner, ManagedBy) come from TaggingAspect at app level.
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';



/**
 * Scaling policy configuration
 */
export interface ScalingPolicyConfiguration {
    /** Target CPU utilization percentage @default 70 */
    readonly targetCpuUtilization?: number;
    /** Cooldown period in seconds @default 300 */
    readonly cooldownSeconds?: number;
    /** Estimated instance warmup time in seconds @default 300 */
    readonly estimatedInstanceWarmupSeconds?: number;
}

/**
 * Rolling update configuration
 */
export interface RollingUpdateConfiguration {
    /** Maximum batch size for updates @default 1 */
    readonly maxBatchSize?: number;
    /** Minimum instances to keep in service @default minCapacity */
    readonly minInstancesInService?: number;
    /** Pause time between batches @default 5 minutes */
    readonly pauseTimeMinutes?: number;
}

/**
 * Props for AutoScalingGroupConstruct
 */
export interface AutoScalingGroupConstructProps {
    /** The VPC where the ASG will be launched */
    readonly vpc: ec2.IVpc;

    /**
     * Launch Template created and controlled by the stack (REQUIRED).
     * Stack creates LaunchTemplateConstruct and passes launchTemplate here.
     */
    readonly launchTemplate: ec2.ILaunchTemplate;

    /** Minimum capacity @default 1 */
    readonly minCapacity?: number;

    /** Maximum capacity @default 3 */
    readonly maxCapacity?: number;

    /**
     * Desired capacity.
     * CAUTION: Setting this will reset ASG size on every deployment (aws/aws-cdk#5215).
     * Leave undefined to let AWS use minCapacity and preserve manual scaling decisions.
     */
    readonly desiredCapacity?: number;

    /** Scaling policy configuration */
    readonly scalingPolicy?: ScalingPolicyConfiguration;

    /** Rolling update configuration */
    readonly rollingUpdate?: RollingUpdateConfiguration;

    /** Health check grace period in seconds @default 300 */
    readonly healthCheckGracePeriodSeconds?: number;

    /**
     * Use ELB-derived health checks instead of EC2-only checks.
     *
     * When `true`, the ASG terminates instances whose attached target groups
     * report Unhealthy — useful when kubelet/Traefik can fail without the
     * EC2 instance crashing. When `false` (default), only EC2 system status
     * checks drive replacement.
     *
     * Requires the ASG to be attached to at least one target group via
     * `attachToNetworkTargetGroup`. Pair with a generous
     * `healthCheckGracePeriodSeconds` (≥600s) to cover boot + kubeadm join
     * + CNI ready + system pods + ingress controller scheduled before the
     * first NLB probe lands.
     *
     * Recommended only on ingress-bearing pools (general). Leave `false` on
     * pools without NLB target attachments (monitoring), and on
     * single-instance ASGs where killing yourself defeats the point
     * (control-plane).
     *
     * @default false
     */
    readonly useElbHealthCheck?: boolean;

    /**
     * Name prefix for resources.
     * Expected to be environment-aware (e.g., 'monitoring-development').
     * @default 'monitoring'
     */
    readonly namePrefix?: string;

    /**
     * Subnet selection.
     * @default PRIVATE_WITH_EGRESS — the secure default for ASGs. Use PUBLIC
     * only when you've explicitly evaluated the cost tradeoff (NAT Gateway
     * ~$30-90/mo) and accept the increased exposure.
     */
    readonly subnetSelection?: ec2.SubnetSelection;

    /** Whether to use signals for deployment validation @default true */
    readonly useSignals?: boolean;

    /** Signals timeout in minutes @default 10 */
    readonly signalsTimeoutMinutes?: number;

    /** Disable scaling policy @default false */
    readonly disableScalingPolicy?: boolean;

    /** Protect new instances from scale-in @default false */
    readonly newInstancesProtectedFromScaleIn?: boolean;

    /**
     * Human-friendly name for instances launched by this ASG.
     * Sets the EC2 `Name` tag (visible in AWS Console).
     * @default namePrefix
     */
    readonly instanceName?: string;

    /**
     * K8s bootstrap role for this ASG (e.g. 'control-plane', 'app-worker', 'mon-worker').
     * When set, tags the ASG with `k8s:bootstrap-role` and `k8s:ssm-prefix`
     * so the auto-bootstrap Lambda can map launched instances to the correct
     * SSM Automation document.
     */
    readonly bootstrapRole?: string;

    /**
     * SSM parameter prefix (e.g. '/k8s/development').
     * Required when `bootstrapRole` is set — used for the `k8s:ssm-prefix` tag.
     */
    readonly ssmPrefix?: string;

    /**
     * Enable termination lifecycle hook for EBS detach pattern.
     * When enabled, creates a lifecycle hook that pauses termination
     * and fires an EventBridge event for the EbsLifecycleStack Lambda.
     * @default false
     */
    readonly enableTerminationLifecycleHook?: boolean;

    /** Termination lifecycle hook timeout in seconds @default 300 (5 min) */
    readonly terminationLifecycleHookTimeoutSeconds?: number;

    /**
     * Kubernetes cluster identifier for AWS Cloud Controller Manager.
     * When set, tags all instances with `kubernetes.io/cluster/<id>=owned`.
     * The CCM Node Lifecycle Controller uses this tag to scope which
     * EC2 instances it manages — required for automatic node object
     * cleanup when instances are terminated.
     * @example 'k8s-dev'
     */
    readonly clusterIdentifier?: string;
}

/**
 * Reusable Auto Scaling Group construct.
 *
 * This is a pure blueprint that ONLY accepts a launch template from the stack.
 * The stack is responsible for creating:
 * 1. SecurityGroupConstruct → securityGroup
 * 2. LaunchTemplateConstruct (with securityGroup) → launchTemplate
 * 3. This construct (with launchTemplate)
 *
 * For IAM grants, use the LaunchTemplateConstruct's `instanceRole` or
 * `addToRolePolicy()` — this construct does not expose the role to avoid
 * two paths to the same role.
 *
 * @example
 * ```typescript
 * const asgConstruct = new AutoScalingGroupConstruct(this, 'ASG', {
 *     vpc,
 *     launchTemplate: ltConstruct.launchTemplate,
 *     minCapacity: 1,
 *     maxCapacity: 5,
 *     namePrefix: 'nextjs-ecs-development',
 *     subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
 * });
 *
 * // Subscribe to scaling notifications
 * new sns.Subscription(this, 'ScalingEmail', {
 *     topic: asgConstruct.notificationTopic,
 *     protocol: sns.SubscriptionProtocol.EMAIL,
 *     endpoint: 'ops@example.com',
 * });
 * ```
 */
export class AutoScalingGroupConstruct extends Construct {
    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /**
     * Concrete ASG name (e.g. `k8s-development-general-pool-asg`).
     *
     * Unlike `autoScalingGroup.autoScalingGroupName` (which CDK resolves as
     * `this.physicalName` — a token that becomes a CloudFormation Ref at synth),
     * this is a plain TypeScript string resolved at synth time.
     * Use this instead of `.autoScalingGroupName` when passing across stack
     * boundaries to avoid emitting Fn::ImportValue cross-stack exports.
     */
    public readonly concreteAsgName: string;

    /**
     * SNS topic for ASG scaling notifications (AwsSolutions-AS3).
     * Exposed so consuming stacks can add subscriptions (email, Lambda, etc.).
     * Without a subscription, scaling events go nowhere.
     */
    public readonly notificationTopic: sns.Topic;

    constructor(scope: Construct, id: string, props: AutoScalingGroupConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix;
        const minCapacity = props.minCapacity ?? 1;
        const maxCapacity = props.maxCapacity ?? 2;
        // desiredCapacity is intentionally NOT defaulted - setting it causes ASG reset on every deploy
        const desiredCapacity = props.desiredCapacity; // undefined means AWS will use minCapacity
        const useSignals = props.useSignals ?? true;

        // =================================================================
        // INPUT VALIDATION
        // =================================================================
        if (minCapacity > maxCapacity) {
            throw new Error(
                `ASG capacity invalid: minCapacity (${minCapacity}) cannot exceed ` +
                `maxCapacity (${maxCapacity}). CloudFormation would fail with an opaque error.`,
            );
        }

        if (desiredCapacity !== undefined) {
            if (desiredCapacity < minCapacity || desiredCapacity > maxCapacity) {
                throw new Error(
                    `ASG desiredCapacity (${desiredCapacity}) must be between ` +
                    `minCapacity (${minCapacity}) and maxCapacity (${maxCapacity}).`,
                );
            }
        }

        // Rolling update configuration
        const rollingUpdate = props.rollingUpdate ?? {};
        const maxBatchSize = rollingUpdate.maxBatchSize ?? 1;
        const minInstancesInService = rollingUpdate.minInstancesInService ?? minCapacity;
        // When signals are enabled, CloudFormation uses PauseTime (not CreationPolicy timeout)
        // as the signal wait interval during rolling updates. Default PauseTime to match
        // the signals timeout so cfn-signal has enough time to arrive.
        const signalsTimeoutMinutes = props.signalsTimeoutMinutes ?? 10;
        const pauseTimeMinutes = rollingUpdate.pauseTimeMinutes ?? (useSignals ? signalsTimeoutMinutes : 5);

        // =================================================================
        // SNS Topic for Scaling Notifications (AwsSolutions-AS3)
        //
        // Exposed as a public property so consuming stacks can add
        // subscriptions. Without a subscription, events go nowhere.
        // =================================================================
        this.notificationTopic = new sns.Topic(this, 'ScalingNotifications', {
            topicName: `${namePrefix}-asg-scaling-notifications`,
            displayName: `${namePrefix} ASG Scaling Notifications`,
            enforceSSL: true,  // AwsSolutions-SNS3: Require SSL for publishers
            masterKey: kms.Alias.fromAliasName(this, 'SnsEncryptionKey', 'alias/aws/sns'),  // CKV_AWS_26
        });

        // =================================================================
        // AUTO SCALING GROUP
        // =================================================================
        this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'AutoScalingGroup', {
            autoScalingGroupName: `${namePrefix}-asg`,
            vpc: props.vpc,
            launchTemplate: props.launchTemplate,
            minCapacity,
            maxCapacity,
            // Only set desiredCapacity if explicitly provided - avoids resetting ASG on every deploy
            ...(desiredCapacity !== undefined && { desiredCapacity }),
            vpcSubnets: props.subnetSelection ?? {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            // Use healthChecks (new API) instead of deprecated healthCheck.
            // ELB mode adds target-group health to the replacement signal —
            // critical for catching kubelet/ingress failures that don't crash
            // the EC2 instance. Only enable on pools that actually attach to
            // a target group; otherwise the ASG has nothing to derive ELB
            // health from and falls back to EC2-only behaviour anyway.
            healthChecks: props.useElbHealthCheck
                ? autoscaling.HealthChecks.withAdditionalChecks({
                    gracePeriod: cdk.Duration.seconds(
                        props.healthCheckGracePeriodSeconds ?? 600,
                    ),
                    additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
                })
                : autoscaling.HealthChecks.ec2({
                    gracePeriod: cdk.Duration.seconds(
                        props.healthCheckGracePeriodSeconds ?? 300,
                    ),
                }),
            updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
                maxBatchSize,
                minInstancesInService,
                pauseTime: cdk.Duration.minutes(pauseTimeMinutes),
            }),
            signals: useSignals
                ? autoscaling.Signals.waitForMinCapacity({
                    timeout: cdk.Duration.minutes(props.signalsTimeoutMinutes ?? 10),
                })
                : undefined,
            newInstancesProtectedFromScaleIn: props.newInstancesProtectedFromScaleIn ?? false,
            // Notifications for all scaling events (required by AwsSolutions-AS3)
            notifications: [
                {
                    topic: this.notificationTopic,
                    scalingEvents: autoscaling.ScalingEvents.ALL,
                },
            ],
        });

        // Expose the concrete ASG name (synth-time string, not a CloudFormation token).
        // CDK's AutoScalingGroup.autoScalingGroupName is resolved as this.physicalName,
        // which becomes a CloudFormation Ref at synth even when an explicit name is set.
        // Build the string directly to avoid cross-stack Fn::ImportValue exports.
        this.concreteAsgName = `${namePrefix}-asg`;
        // Note: CloudFormation rejects $Latest/$Default as LT version in ASG resources.
        // The AMI refresh Lambda updates the ASG version via UpdateAutoScalingGroup API
        // (which does allow $Default), so no override is needed here.

        // Configure scaling policy (unless disabled)
        if (!props.disableScalingPolicy) {
            this.configureScalingPolicy(props.scalingPolicy);
        }

        // =================================================================
        // Termination Lifecycle Hook (for EBS detach pattern)
        //
        // defaultResult: CONTINUE means if the EBS-detach Lambda doesn't
        // complete the lifecycle action within the timeout, the instance
        // terminates anyway. This is acceptable because:
        //
        // - Persistent EBS volumes (e.g., from the storage stack) are attached
        //   AFTER instance launch with their own deleteOnTermination flag set
        //   at attach time — not the launch template's root volume setting.
        //   The root volume's deleteOnTermination: true only affects the
        //   ephemeral root volume, not the persistent data volume.
        //
        // - ABANDON would also continue termination. The semantic difference
        //   is minimal — both result in the instance being terminated.
        //   CONTINUE is preferred here because the operational intent is
        //   "proceed with the replacement" even if detach is slow.
        // =================================================================
        if (props.enableTerminationLifecycleHook) {
            this.autoScalingGroup.addLifecycleHook('TerminationHook', {
                lifecycleHookName: `${namePrefix}-ebs-detach-hook`,
                lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
                heartbeatTimeout: cdk.Duration.seconds(
                    props.terminationLifecycleHookTimeoutSeconds ?? 300,
                ),
                defaultResult: autoscaling.DefaultResult.CONTINUE,
                // No notification target - EventBridge captures the event automatically
            });
        }

        // Name tag: gives instances a clean name instead of CDK construct tree path
        // (e.g. 'k8s-dev-control-plane' instead of 'ControlPlane-development/LaunchTemplate/LaunchTemplate')
        cdk.Tags.of(this.autoScalingGroup).add('Name', props.instanceName ?? `${namePrefix}`, {
            applyToLaunchedInstances: true,
        });

        // Auto-bootstrap tags: the auto-bootstrap Lambda reads these to determine
        // which SSM Automation document to trigger on instance launch.
        if (props.bootstrapRole) {
            cdk.Tags.of(this.autoScalingGroup).add('k8s:bootstrap-role', props.bootstrapRole);
            if (props.ssmPrefix) {
                cdk.Tags.of(this.autoScalingGroup).add('k8s:ssm-prefix', props.ssmPrefix);
            }
        }

        // AWS Cloud Controller Manager tag: CCM uses this to scope which
        // EC2 instances it manages. Required for the Node Lifecycle Controller
        // to detect terminated instances and clean up K8s node objects.
        if (props.clusterIdentifier) {
            cdk.Tags.of(this.autoScalingGroup).add(
                `kubernetes.io/cluster/${props.clusterIdentifier}`,
                'owned',
                { applyToLaunchedInstances: true },
            );
        }

        // Tags: all 6 tags applied by TaggingAspect at stack level
    }

    /**
     * Configures target tracking scaling policy based on CPU utilization
     */
    private configureScalingPolicy(config?: ScalingPolicyConfiguration): void {
        const targetCpu = config?.targetCpuUtilization ?? 70;
        const cooldown = config?.cooldownSeconds ?? 300;
        const warmup = config?.estimatedInstanceWarmupSeconds ?? 300;

        this.autoScalingGroup.scaleOnCpuUtilization('CpuScalingPolicy', {
            targetUtilizationPercent: targetCpu,
            cooldown: cdk.Duration.seconds(cooldown),
            estimatedInstanceWarmup: cdk.Duration.seconds(warmup),
        });
    }

    /**
     * Adds a lifecycle hook to the Auto Scaling Group.
     *
     * @example
     * ```typescript
     * asg.addLifecycleHook('LaunchHook', {
     *     lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_LAUNCHING,
     *     heartbeatTimeout: cdk.Duration.minutes(5),
     *     defaultResult: autoscaling.DefaultResult.ABANDON,
     * });
     * ```
     */
    addLifecycleHook(
        id: string,
        props: autoscaling.BasicLifecycleHookProps,
    ): autoscaling.LifecycleHook {
        return this.autoScalingGroup.addLifecycleHook(id, props);
    }
}
