/**
 * @format
 * Kubernetes Worker ASG Stack — Generic, Parameterised Pool
 *
 * Replaces the three named worker stacks (AppWorker, MonitoringWorker, ArgocdWorker)
 * with two parameterised ASG pools driven by `WorkerPoolType`:
 *
 *   - `general`:    t3.small Spot, min=1/max=4. Hosts Next.js, start-admin, admin-api,
 *                   public-api, wiki-mcp, and system components (no taint — all pods accepted).
 *   - `monitoring`: t3.medium Spot, min=1/max=2. Hosts the observability stack
 *                   (Prometheus, Grafana, Loki, Tempo, Alloy) with a
 *                   `dedicated=monitoring:NoSchedule` taint applied by the
 *                   bootstrap script.
 *
 * Cluster Autoscaler Integration:
 *   ASGs are tagged with `k8s.io/cluster-autoscaler/enabled` and
 *   `k8s.io/cluster-autoscaler/<clusterName>: owned` so the Cluster Autoscaler
 *   can discover and scale each pool independently.
 *
 * Node Labels (applied by bootstrap script via kubeadm join `--node-labels`):
 *   - `node-pool=general`    (general pool)
 *   - `node-pool=monitoring` (monitoring pool)
 *
 * Migration Notes:
 *   - Deploy both pools alongside existing worker stacks (additive, zero-downtime).
 *   - Shift workloads via Helm nodeSelector updates, then drain old nodes.
 *   - The SSM bootstrap role tags (`k8s:bootstrap-role`) use `general-pool` and
 *     `monitoring-pool` — update trigger-bootstrap.ts accordingly.
 *
 * Resources Created:
 *   - Launch Template (Golden AMI from SSM, IMDSv2, GP3 root volume, Spot)
 *   - ASG (min/max/desired configurable, CA-discoverable tags)
 *   - IAM Role (SSM + CloudWatch + ECR + S3 + EBS CSI + CA permissions)
 *   - SNS Topic for monitoring alerts (monitoring pool ONLY)
 *   - SSM Parameter for alerts topic ARN (monitoring pool ONLY)
 *
 * Resources Consumed from KubernetesBaseStack via SSM:
 *   - VPC, Security Group, ingress SG, monitoring SG
 *   - NLB HTTP/HTTPS target group ARNs
 *   - KMS key ARN, scripts S3 bucket name
 *
 * @module worker-asg-stack
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment, shortEnv } from '../../config/environments';
import {
    AutoScalingGroupConstruct,
    LaunchTemplateConstruct,
    UserDataBuilder,
} from '../../constructs/index';

// =============================================================================
// POOL TYPE
// =============================================================================

/**
 * The type of worker pool.
 *
 * - `general`:    Hosts Next.js, start-admin, admin-api, public-api, wiki-mcp, system components.
 *                 No taint — accepts all pods without toleration.
 * - `monitoring`: Hosts Prometheus, Grafana, Loki, Tempo, Alloy, ArgoCD.
 *                 Tainted `dedicated=monitoring:NoSchedule` by bootstrap.
 */
export type WorkerPoolType = 'general' | 'monitoring';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesWorkerAsgStack.
 */
export interface KubernetesWorkerAsgStackProps extends cdk.StackProps {
    /** VPC ID from base stack (synth-time concrete string via Vpc.fromLookup) */
    readonly vpcId: string;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /**
     * Pool type — controls instance type, capacity, taints, and IAM policy set.
     * @see WorkerPoolType
     */
    readonly poolType: WorkerPoolType;

    /**
     * SSM parameter prefix for the control plane cluster.
     * Used to discover join token, CA hash, control plane endpoint, and
     * base infrastructure (security group, scripts bucket, KMS key, NLB TGs).
     * @example '/k8s/development'
     */
    readonly controlPlaneSsmPrefix: string;

    /**
     * Kubernetes cluster name / identifier.
     * Used for:
     *   - `kubernetes.io/cluster/<name>: owned` tag (CCM Node Lifecycle Controller)
     *   - `k8s.io/cluster-autoscaler/<name>: owned` tag (Cluster Autoscaler)
     *   - User data `CLUSTER_NAME` env var
     * @example 'k8s-development'
     */
    readonly clusterName: string;

    /** EC2 instance type @default t3.small (general) | t3.medium (monitoring) */
    readonly instanceType?: ec2.InstanceType;

    /** Minimum ASG capacity @default 1 */
    readonly minCapacity?: number;

    /** Maximum ASG capacity @default 4 (general) | 2 (monitoring) */
    readonly maxCapacity?: number;

    /**
     * Whether to use EC2 Spot instances.
     * @default true — both pools use Spot for cost optimisation.
     *   BlueGreen rollout handles Next.js graceful handoff; ArgoCD tolerates interruptions.
     */
    readonly useSpotInstances?: boolean;

    /** Root EBS volume size in GB @default 30 */
    readonly rootVolumeSizeGb?: number;

    /** Whether to enable detailed CloudWatch monitoring @default false */
    readonly detailedMonitoring?: boolean;

    /** Whether to use CloudFormation signals for ASG deployment validation @default true */
    readonly useSignals?: boolean;

    /** Signals timeout in minutes @default 40 */
    readonly signalsTimeoutMinutes?: number;

    /** CloudWatch log group retention @default ONE_WEEK */
    readonly logRetention?: logs.RetentionDays;

    /**
     * Email address for SNS alert notifications.
     * Only used when poolType is `monitoring` — creates an email subscription
     * on the monitoring alerts SNS topic.
     */
    readonly notificationEmail?: string;

    /**
     * Cross-account IAM role ARN for cert-manager DNS-01 challenges.
     * cert-manager pods can be scheduled on any node and need to assume this
     * role to create TXT records in the root account's hosted zone.
     */
    readonly crossAccountDnsRoleArn?: string;

    /** Name prefix for AWS resources @default 'k8s' */
    readonly namePrefix?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Worker ASG Stack — Generic, Parameterised Pool.
 *
 * Creates one of two pool types:
 *   - `general`:    t3.small Spot, no taint, CA-discoverable (min=1, max=4).
 *   - `monitoring`: t3.medium Spot, tainted by bootstrap, CA-discoverable (min=1, max=2).
 *
 * Both pools include all IAM permissions required by any pod that may be
 * scheduled on them. Monitoring-only permissions (Steampipe ViewOnlyAccess,
 * CloudWatch read for Grafana, SNS alerts topic) are conditionally added for
 * the monitoring pool only.
 */
export class KubernetesWorkerAsgStack extends cdk.Stack {
    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM instance role */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    /**
     * SNS topic for monitoring alerts (Grafana → Email + SNS).
     * Only defined when `poolType === 'monitoring'`.
     */
    public readonly alertsTopic?: sns.Topic;

    constructor(scope: Construct, id: string, props: KubernetesWorkerAsgStackProps) {
        super(scope, id, props);

        const isMonitoringPool = props.poolType === 'monitoring';
        const namePrefix = props.namePrefix ?? 'k8s';
        const poolId = `${namePrefix}-${props.poolType}-pool`;

        // Default capacity by pool type
        const defaultMaxCapacity = isMonitoringPool ? 2 : 4;
        const defaultInstanceType = isMonitoringPool
            ? ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)
            : ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL);

        // Bootstrap role tag — maps to trigger-bootstrap.ts target tag value
        const bootstrapRole: string = `${props.poolType}-pool`;

        // =====================================================================
        // Resolve base infrastructure via SSM (no cross-stack Fn::ImportValue)
        // =====================================================================
        const ssmPrefix = props.controlPlaneSsmPrefix;

        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });

        const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'ClusterSg',
            ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/security-group-id`),
        );

        const ingressSg = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'IngressSg',
            ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/ingress-sg-id`),
        );

        const logGroupKmsKey = kms.Key.fromKeyArn(
            this, 'LogKmsKey',
            ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/kms-key-arn`),
        );

        const scriptsBucketName = ssm.StringParameter.valueForStringParameter(
            this, `${ssmPrefix}/scripts-bucket`,
        );
        const scriptsBucket = s3.Bucket.fromBucketName(this, 'ScriptsBucket', scriptsBucketName);

        // SSM paths for kubeadm join parameters
        const tokenSsmPath = `${ssmPrefix}/join-token`;
        const caHashSsmPath = `${ssmPrefix}/ca-hash`;
        const controlPlaneEndpointSsmPath = `${ssmPrefix}/control-plane-endpoint`;

        // NLB target groups — ALL worker ASGs register with both TGs for failover
        const nlbHttpTargetGroupArn = ssm.StringParameter.valueForStringParameter(
            this, `${ssmPrefix}/nlb-http-target-group-arn`,
        );
        const nlbHttpsTargetGroupArn = ssm.StringParameter.valueForStringParameter(
            this, `${ssmPrefix}/nlb-https-target-group-arn`,
        );
        const nlbHttpTg = elbv2.NetworkTargetGroup.fromTargetGroupAttributes(
            this, 'NlbHttpTg', { targetGroupArn: nlbHttpTargetGroupArn },
        );
        const nlbHttpsTg = elbv2.NetworkTargetGroup.fromTargetGroupAttributes(
            this, 'NlbHttpsTg', { targetGroupArn: nlbHttpsTargetGroupArn },
        );

        // Monitoring security group — only attached to monitoring pool nodes
        const additionalSgs: ec2.ISecurityGroup[] = [ingressSg];
        if (isMonitoringPool) {
            const monitoringSg = ec2.SecurityGroup.fromSecurityGroupId(
                this, 'MonitoringSg',
                ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/monitoring-sg-id`),
            );
            additionalSgs.push(monitoringSg);
        }

        // =====================================================================
        // User Data placeholder (commands added after ASG is created)
        // =====================================================================
        const userData = ec2.UserData.forLinux();

        // =====================================================================
        // Launch Template
        // =====================================================================
        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup,
            additionalSecurityGroups: additionalSgs,
            instanceType: props.instanceType ?? defaultInstanceType,
            volumeSizeGb: props.rootVolumeSizeGb ?? 30,
            detailedMonitoring: props.detailedMonitoring ?? false,
            userData,
            namePrefix: poolId,
            logGroupKmsKey,
            machineImage: ec2.MachineImage.fromSsmParameter(
                `${ssmPrefix}/golden-ami/latest`,
            ),
            // Required: Kubernetes pod overlay networking (Calico) uses pod IPs
            // that don't match ENI IPs — AWS drops this traffic unless disabled.
            disableSourceDestCheck: true,
        });

        // =====================================================================
        // Spot Instance Configuration
        //
        // Override the L1 CfnLaunchTemplate to set instanceMarketOptions.
        // CDK's L2 LaunchTemplate doesn't expose this field — use escape hatch.
        // =====================================================================
        if (props.useSpotInstances !== false) { // default true
            const cfnLt = launchTemplateConstruct.launchTemplate.node
                .defaultChild as ec2.CfnLaunchTemplate;
            cfnLt.addPropertyOverride('LaunchTemplateData.InstanceMarketOptions', {
                MarketType: 'spot',
                SpotOptions: { SpotInstanceType: 'one-time' },
            });
        }

        const logGroupName = launchTemplateConstruct.logGroup?.logGroupName
            ?? `/ec2/${poolId}/instances`;

        // =====================================================================
        // IAM Policies — Core (both pools)
        // =====================================================================

        // kubeadm join parameters (join-token is SecureString → needs kms:Decrypt)
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ReadK8sJoinParams',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${tokenSsmPath}`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter${caHashSsmPath}`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter${controlPlaneEndpointSsmPath}`,
            ],
        }));

        // KMS decrypt for SSM SecureString parameters (join-token)
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DecryptSsmSecureStrings',
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt'],
            resources: ['*'],
            conditions: {
                StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
            },
        }));

        // Boot script download from S3 + orchestrator fallback
        scriptsBucket.grantRead(launchTemplateConstruct.instanceRole);

        // ECR: pull images (includes ListImages/DescribeImages for ArgoCD Image Updater)
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EcrPullImages',
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
                'ecr:ListImages',
                'ecr:DescribeImages',
            ],
            resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/*`],
        }));

        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EcrAuthToken',
            effect: iam.Effect.ALLOW,
            actions: ['ecr:GetAuthorizationToken'],
            resources: ['*'],
        }));

        // SSM Automation: start bootstrap, poll execution, publish execution ID
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmAutomationExecution',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:StartAutomationExecution',
                'ssm:GetAutomationExecution',
                'ssm:DescribeAutomationStepExecutions',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:automation-definition/*`,
                `arn:aws:ssm:${this.region}:${this.account}:automation-execution/*`,
            ],
        }));

        // SSM PutParameter:
        //   1. bootstrap/*              — instance-id + execution-id for CI pipeline
        //      (written by user-data and trigger-bootstrap.ts)
        //   2. nodes/{poolType}/*       — instance-id → hostname mapping written by
        //      register_instance.py (Step 3b) after a successful kubeadm join.
        //      Without this, pool discovery via `aws ssm get-parameters-by-path
        //      --path {ssmPrefix}/nodes/{pool}` will never see this node.
        //      Scoped to this pool's own sub-path to minimise blast radius.
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmPublishBootstrapParams',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:PutParameter',
                'ssm:AddTagsToResource',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPrefix}/bootstrap/*`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPrefix}/nodes/${props.poolType}/*`,
            ],
        }));

        // iam:PassRole: required to pass the SSM Automation execution role
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'PassSsmAutomationRole',
            effect: iam.Effect.ALLOW,
            actions: ['iam:PassRole'],
            resources: [`arn:aws:iam::${this.account}:role/*-SsmAutomation-*`],
            conditions: {
                StringEquals: { 'iam:PassedToService': 'ssm.amazonaws.com' },
            },
        }));

        // EBS CSI Driver: volume lifecycle (CreateVolume, AttachVolume, etc.)
        // Required on all worker nodes — CSI node agent runs as a DaemonSet.
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EbsCsiDriverVolumeLifecycle',
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:CreateVolume',
                'ec2:DeleteVolume',
                'ec2:AttachVolume',
                'ec2:DetachVolume',
                'ec2:ModifyVolume',
                'ec2:DescribeVolumes',
                'ec2:DescribeVolumesModifications',
                'ec2:DescribeInstances',
                'ec2:DescribeAvailabilityZones',
                'ec2:CreateSnapshot',
                'ec2:DeleteSnapshot',
                'ec2:DescribeSnapshots',
                'ec2:CreateTags',
            ],
            resources: ['*'],
        }));

        // KMS for EBS CSI encrypted volumes
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EbsCsiDriverKms',
            effect: iam.Effect.ALLOW,
            actions: [
                'kms:Decrypt',
                'kms:Encrypt',
                'kms:ReEncrypt*',
                'kms:GenerateDataKey*',
                'kms:CreateGrant',
                'kms:DescribeKey',
            ],
            resources: ['*'],
            conditions: {
                StringEquals: { 'kms:ViaService': `ec2.${this.region}.amazonaws.com` },
            },
        }));

        // Cluster Autoscaler — READ permissions (both pools)
        //
        // Both pools need Describe* so nodes can report ASG membership to CA.
        // CA itself runs on the monitoring pool and issues API calls from there,
        // but the Describe* actions have no blast radius — safe to grant broadly.
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ClusterAutoscalerDescribe',
            effect: iam.Effect.ALLOW,
            actions: [
                'autoscaling:DescribeAutoScalingGroups',
                'autoscaling:DescribeAutoScalingInstances',
                'autoscaling:DescribeLaunchConfigurations',
                'autoscaling:DescribeScalingActivities',
                'ec2:DescribeLaunchTemplateVersions',
                'ec2:DescribeInstanceTypes',
                'ec2:DescribeImages',
            ],
            resources: ['*'],
        }));

        // Cluster Autoscaler — WRITE permissions (monitoring pool only)
        //
        // CA is deployed with nodeSelector node-pool=monitoring so it runs on the
        // stable monitoring pool and cannot be evicted by its own scale-down logic.
        // Only the monitoring-pool instance role needs SetDesiredCapacity —
        // granting it to general-pool nodes would widen the blast radius if a
        // compromised general-pool node attempted to manipulate ASG capacity.
        if (props.poolType === 'monitoring') {
            launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
                sid: 'ClusterAutoscalerScale',
                effect: iam.Effect.ALLOW,
                actions: [
                    'autoscaling:SetDesiredCapacity',
                    'autoscaling:TerminateInstanceInAutoScalingGroup',
                ],
                resources: ['*'],
            }));
        }

        // CloudWatch read-only: Grafana CloudWatch datasource + log shipping
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'CloudWatchGrafanaReadOnly',
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:DescribeLogGroups',
                'logs:GetLogEvents',
                'logs:FilterLogEvents',
                'logs:StartQuery',
                'logs:StopQuery',
                'logs:GetQueryResults',
                'logs:DescribeLogStreams',
                'cloudwatch:GetMetricData',
                'cloudwatch:ListMetrics',
            ],
            resources: ['*'],
        }));

        // DynamoDB read-only: Next.js article serving (general pool only)
        // Monitoring pool doesn't need this but including it is harmless and
        // prevents errors if a pod is rescheduled during a drain.
        const envAbbrev = shortEnv(props.targetEnvironment);
        const contentTableName = `bedrock-${envAbbrev}-ai-content`;
        const contentTableArn =
            `arn:aws:dynamodb:${this.region}:${this.account}:table/${contentTableName}`;

        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DynamoDBContentReadOnly',
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:GetItem',
                'dynamodb:BatchGetItem',
                'dynamodb:Query',
                'dynamodb:Scan',
            ],
            resources: [contentTableArn, `${contentTableArn}/index/*`],
        }));

        // S3 read-only: Next.js article MDX content fetching
        const contentBucketName = `bedrock-${envAbbrev}-kb-data`;
        const contentBucketArn = `arn:aws:s3:::${contentBucketName}`;

        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'S3ContentReadOnly',
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [contentBucketArn, `${contentBucketArn}/*`],
        }));

        // cert-manager DNS-01: assume cross-account Route 53 role
        if (props.crossAccountDnsRoleArn) {
            launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
                sid: 'AssumeRoute53DnsRole',
                effect: iam.Effect.ALLOW,
                actions: ['sts:AssumeRole'],
                resources: [props.crossAccountDnsRoleArn],
            }));
        }

        // =====================================================================
        // IAM Policies — Monitoring Pool Only
        // =====================================================================

        if (isMonitoringPool) {
            // ViewOnlyAccess: Steampipe cloud inventory queries
            launchTemplateConstruct.instanceRole.addManagedPolicy(
                iam.ManagedPolicy.fromAwsManagedPolicyName('job-function/ViewOnlyAccess'),
            );

            // Additional Steampipe actions not covered by ViewOnlyAccess
            launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
                sid: 'SteampipeCloudInventoryReadOnly',
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:GetEncryptionConfiguration',
                    's3:GetBucketPublicAccessBlock',
                    's3:GetBucketVersioning',
                    's3:GetBucketLogging',
                    's3:GetBucketTagging',
                    's3:GetBucketPolicy',
                    's3:GetBucketAcl',
                    's3:ListAllMyBuckets',
                    's3:GetBucketLocation',
                    'route53:ListHostedZones',
                    'route53:ListResourceRecordSets',
                    'route53:GetHostedZone',
                    'cloudfront:ListDistributions',
                    'cloudfront:GetDistribution',
                    'wafv2:ListWebACLs',
                    'wafv2:GetWebACL',
                    'wafv2:ListRuleGroups',
                    'logs:ListTagsForResource',
                ],
                resources: ['*'],
            }));
        }

        // =====================================================================
        // Auto Scaling Group
        // =====================================================================
        const asgConstruct = new AutoScalingGroupConstruct(this, 'WorkerAsg', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: props.minCapacity ?? 1,
            maxCapacity: props.maxCapacity ?? defaultMaxCapacity,
            // desiredCapacity intentionally omitted: CA manages scale after initial launch.
            // Setting it would reset capacity on every cdk deploy.
            // Disable CPU target tracking on the general pool.
            // Cluster Autoscaler owns scale decisions for the general pool;
            // CPU target tracking and CA conflict (both set desiredCapacity).
            // The monitoring pool retains target tracking (CA does not manage it).
            disableScalingPolicy: props.poolType === 'general',
            namePrefix: poolId,
            instanceName: `${namePrefix}-${props.poolType}-worker`,
            bootstrapRole,
            ssmPrefix,
            clusterIdentifier: props.clusterName,
            useSignals: props.useSignals ?? true,
            signalsTimeoutMinutes: props.signalsTimeoutMinutes ?? 40,
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
                availabilityZones: [`${this.region}a`],
            },
        });

        // =====================================================================
        // Cluster Autoscaler Tags
        //
        // The CA reads these tags from each ASG to determine whether it should
        // manage the group, and which cluster it belongs to.
        // These are separate from the CCM `kubernetes.io/cluster/*` tag handled
        // by AutoScalingGroupConstruct.clusterIdentifier.
        // =====================================================================
        cdk.Tags.of(asgConstruct.autoScalingGroup).add(
            'k8s.io/cluster-autoscaler/enabled', 'true',
            { applyToLaunchedInstances: false }, // tag on ASG, not instances
        );
        cdk.Tags.of(asgConstruct.autoScalingGroup).add(
            `k8s.io/cluster-autoscaler/${props.clusterName}`, 'owned',
            { applyToLaunchedInstances: false },
        );

        // =====================================================================
        // User Data — Infrastructure Readiness Stub
        //
        // Resolves the instance ID via IMDSv2, publishes it to SSM so the CI
        // pipeline can target SSM Automation, then sends cfn-signal.
        // The actual kubeadm join is performed by the SSM Automation document.
        // =====================================================================
        const asgCfnResource = asgConstruct.autoScalingGroup.node
            .defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        userData.addCommands(
            'set -euxo pipefail',
            '',
            'exec > >(tee /var/log/user-data.log) 2>&1',
            `echo "=== ${props.poolType}-pool worker user data started at $(date) ==="`,
        );

        new UserDataBuilder(userData, { skipPreamble: true })
            .addCustomScript(`
# ── Runtime values (CDK tokens resolved at synth time) ───────────────────────
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_POOL="${props.poolType}"
export CLUSTER_NAME="${props.clusterName}"
export S3_BUCKET="${scriptsBucketName}"
export LOG_GROUP_NAME="${logGroupName}"

# Persist env vars for SSM Automation to source later
cat > /etc/profile.d/k8s-env.sh << 'ENVEOF'
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_POOL="${props.poolType}"
export CLUSTER_NAME="${props.clusterName}"
export S3_BUCKET="${scriptsBucketName}"
export LOG_GROUP_NAME="${logGroupName}"
ENVEOF

# ── Resolve instance ID via IMDSv2 ──────────────────────────────────
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: \${TOKEN}" \\
  http://169.254.169.254/latest/meta-data/instance-id)

# Publish instance ID so the pipeline can target SSM Automation
aws ssm put-parameter \\
  --name "\${SSM_PREFIX}/bootstrap/${bootstrapRole}-instance-id" \\
  --value "\${INSTANCE_ID}" \\
  --type String \\
  --overwrite \\
  --region "\${AWS_REGION}" 2>/dev/null || true

echo "Infrastructure ready — instance \${INSTANCE_ID}"
echo "SSM Automation will be triggered by the CI pipeline"

# ── Signal CloudFormation: infrastructure ready ──────────────────────
/opt/aws/bin/cfn-signal --success true \\
  --stack "\${STACK_NAME}" \\
  --resource "\${ASG_LOGICAL_ID}" \\
  --region "\${AWS_REGION}" 2>/dev/null || true
`);

        // =====================================================================
        // SNS Topic — Monitoring Alerts (monitoring pool ONLY)
        // =====================================================================
        if (isMonitoringPool) {
            const alertsTopic = new sns.Topic(this, 'MonitoringAlertsTopic', {
                topicName: `${poolId}-monitoring-alerts`,
                displayName: 'Monitoring Alerts',
                enforceSSL: true,
                masterKey: kms.Alias.fromAliasName(this, 'SnsEncryptionKey', 'alias/aws/sns'),
            });

            if (props.notificationEmail) {
                alertsTopic.addSubscription(
                    new sns_subscriptions.EmailSubscription(props.notificationEmail),
                );
            }

            // Allow Grafana's SNS contact point to publish
            launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
                sid: 'SnsPublishAlerts',
                effect: iam.Effect.ALLOW,
                actions: ['sns:Publish'],
                resources: [alertsTopic.topicArn],
            }));

            // KMS for SNS encryption
            launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
                sid: 'KmsForSns',
                effect: iam.Effect.ALLOW,
                actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
                resources: ['*'],
                conditions: {
                    StringEquals: { 'kms:ViaService': `sns.${this.region}.amazonaws.com` },
                },
            }));

            // SSM parameter so bootstrap_argocd.py can discover the topic ARN
            // Suffix with "-pool" to distinguish from legacy MonitoringWorker stack
            new ssm.StringParameter(this, 'MonitoringAlertsTopicArnParam', {
                parameterName: `${ssmPrefix}/monitoring/alerts-topic-arn-pool`,
                stringValue: alertsTopic.topicArn,
                description: 'SNS topic ARN for Grafana monitoring alerts — used by ArgoCD bootstrap',
            });

            this.alertsTopic = alertsTopic;
        }

        // =====================================================================
        // NLB Target Registration
        // =====================================================================
        asgConstruct.autoScalingGroup.attachToNetworkTargetGroup(nlbHttpTg);
        asgConstruct.autoScalingGroup.attachToNetworkTargetGroup(nlbHttpsTg);

        // =====================================================================
        // Expose public properties
        // =====================================================================
        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'AsgName', {
            value: asgConstruct.autoScalingGroup.autoScalingGroupName,
            description: `${props.poolType} pool ASG name`,
        });

        new cdk.CfnOutput(this, 'InstanceRoleArn', {
            value: launchTemplateConstruct.instanceRole.roleArn,
            description: `${props.poolType} pool IAM instance role ARN`,
        });

        // Publish the instance role ARN to SSM so other stacks (e.g. AppIam)
        // can import it without a CloudFormation cross-stack export dependency.
        // Path: /k8s/{env}/{poolType}-instance-role-arn
        new ssm.StringParameter(this, 'InstanceRoleArnParam', {
            parameterName: `${props.controlPlaneSsmPrefix}/${props.poolType}-instance-role-arn`,
            stringValue: launchTemplateConstruct.instanceRole.roleArn,
            description: `${props.poolType} pool EC2 instance role ARN`,
            tier: ssm.ParameterTier.STANDARD,
        });

        if (isMonitoringPool && this.alertsTopic) {
            new cdk.CfnOutput(this, 'MonitoringAlertsTopicArn', {
                value: this.alertsTopic.topicArn,
                description: 'SNS topic ARN for Grafana monitoring alerts',
            });
        }
    }
}
