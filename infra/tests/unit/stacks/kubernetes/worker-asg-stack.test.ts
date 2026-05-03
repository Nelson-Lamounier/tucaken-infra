/**
 * @format
 * Kubernetes Worker ASG Stack Unit Tests
 *
 * Tests for the parameterised {@link KubernetesWorkerAsgStack}, which replaces
 * the three named legacy worker stacks (AppWorker, MonitoringWorker, ArgocdWorker)
 * with two pool types:
 *
 *   - `general`:    t3.small On-Demand (ArgoCD cannot tolerate Spot interruptions), min=1/max=4. No taint.
 *   - `monitoring`: t3.medium Spot, min=1/max=2. `dedicated=monitoring:NoSchedule` taint.
 *
 * Test matrix:
 *   - Launch Template creation (both pools)
 *   - Spot instance configuration (L1 escape hatch)
 *   - ASG capacity defaults per pool type
 *   - Cluster Autoscaler tags
 *   - User Data (16 KB limit + required env var exports + bootstrap SSM publish)
 *   - IAM policies (core + monitoring-only conditionals)
 *   - SNS topic + SSM parameter (monitoring pool only)
 *   - Stack outputs (AsgName, InstanceRoleArn, MonitoringAlertsTopicArn)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import {
    KubernetesWorkerAsgStack,
    KubernetesWorkerAsgStackProps,
    WorkerPoolType,
} from '../../../../lib/stacks/kubernetes/worker-asg-stack';
import {
    TEST_ENV_EU,
    TEST_VPC_CONTEXT_KEY,
    TEST_VPC_CONTEXT,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Constants
// =============================================================================

/** AWS CloudFormation maximum user data size in bytes */
const CF_USER_DATA_MAX_BYTES = 16_384;

/** Cross-account DNS role ARN for testing */
const TEST_CROSS_ACCOUNT_DNS_ROLE_ARN = 'arn:aws:iam::999999999999:role/Route53DnsValidationRole';

/** Notification email for monitoring pool */
const TEST_NOTIFICATION_EMAIL = 'ops@example.com';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a {@link KubernetesWorkerAsgStack} with test-friendly defaults.
 *
 * @param poolType - Pool type under test (`general` | `monitoring`)
 * @param overrides - Optional prop overrides
 */
function createWorkerAsgStack(
    poolType: WorkerPoolType,
    overrides?: Partial<Omit<KubernetesWorkerAsgStackProps, 'vpcId'>> & { vpcId?: string },
): { stack: KubernetesWorkerAsgStack; template: Template; app: cdk.App } {
    const app = createTestApp();
    app.node.setContext(TEST_VPC_CONTEXT_KEY, TEST_VPC_CONTEXT);

    const stack = new KubernetesWorkerAsgStack(app, `Test${poolType}PoolStack`, {
        vpcId: 'vpc-12345',
        env: TEST_ENV_EU,
        targetEnvironment: Environment.DEVELOPMENT,
        poolType,
        controlPlaneSsmPrefix: '/k8s/development',
        clusterName: 'k8s-development',
        namePrefix: 'k8s-dev',
        crossAccountDnsRoleArn: TEST_CROSS_ACCOUNT_DNS_ROLE_ARN,
        ...(poolType === 'monitoring' ? { notificationEmail: TEST_NOTIFICATION_EMAIL } : {}),
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

/**
 * Extract the concatenated UserData string from a synthesised template.
 *
 * CloudFormation UserData is rendered as `Fn::Base64( Fn::Join('', [...]) )`.
 * This helper flattens the join array into inspectable string parts.
 */
function extractUserDataParts(template: Template): string[] {
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate');
    const ltResource = Object.values(launchTemplates)[0] as {
        Properties?: {
            LaunchTemplateData?: {
                UserData?: { 'Fn::Base64'?: { 'Fn::Join'?: [string, unknown[]] } };
            };
        };
    };

    const joinArgs = ltResource?.Properties?.LaunchTemplateData?.UserData?.['Fn::Base64']?.['Fn::Join'];
    if (!joinArgs || !Array.isArray(joinArgs[1])) {
        throw new Error('Could not find UserData Fn::Join in LaunchTemplate');
    }

    return joinArgs[1].map((part: unknown) => {
        if (typeof part === 'string') return part;
        return '<CFN_TOKEN>';
    });
}

// =============================================================================
// General Pool Tests
// =============================================================================

describe('KubernetesWorkerAsgStack — general pool', () => {

    // =========================================================================
    // Launch Template
    // =========================================================================
    describe('Launch Template', () => {
        const { template } = createWorkerAsgStack('general');

        it('should create a launch template', () => {
            template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
        });
    });

    // =========================================================================
    // Spot Instance Configuration
    // =========================================================================
    describe('Spot Instance Configuration', () => {
        describe('when useSpotInstances is true (default)', () => {
            const { template } = createWorkerAsgStack('general');

            it('should set InstanceMarketOptions.MarketType to spot', () => {
                template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                    LaunchTemplateData: Match.objectLike({
                        InstanceMarketOptions: {
                            MarketType: 'spot',
                            SpotOptions: { SpotInstanceType: 'one-time' },
                        },
                    }),
                });
            });
        });

        describe('when useSpotInstances is false', () => {
            const { template } = createWorkerAsgStack('general', { useSpotInstances: false });

            it('should NOT set InstanceMarketOptions', () => {
                template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                    LaunchTemplateData: Match.objectLike({
                        InstanceMarketOptions: Match.absent(),
                    }),
                });
            });
        });
    });

    // =========================================================================
    // Auto Scaling Group
    // =========================================================================
    describe('Auto Scaling Group', () => {
        const { template } = createWorkerAsgStack('general');

        it('should create an ASG', () => {
            template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
        });

        it('should use default maxCapacity=4 for general pool', () => {
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MaxSize: '4',
            });
        });

        it('should use minCapacity=1', () => {
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MinSize: '1',
            });
        });
    });

    // =========================================================================
    // Cluster Autoscaler Tags
    // =========================================================================
    describe('Cluster Autoscaler Tags', () => {
        const { template } = createWorkerAsgStack('general');

        it('should tag the ASG with k8s.io/cluster-autoscaler/enabled', () => {
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                Tags: Match.arrayWith([
                    Match.objectLike({
                        Key: 'k8s.io/cluster-autoscaler/enabled',
                        Value: 'true',
                    }),
                ]),
            });
        });

        it('should tag the ASG with the cluster name for CA discovery', () => {
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                Tags: Match.arrayWith([
                    Match.objectLike({
                        Key: 'k8s.io/cluster-autoscaler/k8s-development',
                        Value: 'owned',
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // User Data
    // =========================================================================
    describe('User Data', () => {
        const { template } = createWorkerAsgStack('general');
        const userDataParts = extractUserDataParts(template);
        const userDataContent = userDataParts.join('');
        const stringParts = userDataParts.filter((p): p is string => typeof p === 'string');
        const containsPattern = (pattern: string): boolean =>
            stringParts.some((p) => p.includes(pattern));

        it('should stay under the CloudFormation 16 KB user data limit', () => {
            const sizeBytes = Buffer.byteLength(userDataContent, 'utf-8');
            expect(sizeBytes).toBeLessThan(CF_USER_DATA_MAX_BYTES);
        });

        describe('required env var exports', () => {
            const requiredExports = [
                'STACK_NAME',
                'ASG_LOGICAL_ID',
                'AWS_REGION',
                'SSM_PREFIX',
                'NODE_POOL',
                'CLUSTER_NAME',
                'S3_BUCKET',
                'LOG_GROUP_NAME',
            ];

            it.each(requiredExports)('should export %s', (envVar) => {
                expect(containsPattern(`export ${envVar}=`)).toBe(true);
            });
        });

        it('should publish instance ID to SSM for pipeline SSM trigger', () => {
            expect(containsPattern('ssm put-parameter')).toBe(true);
            expect(containsPattern('general-pool-instance-id')).toBe(true);
        });

        it('should send cfn-signal for infrastructure readiness', () => {
            expect(containsPattern('cfn-signal --success true')).toBe(true);
        });

        // Ensure no heavy inline bootstrap commands — these belong in SSM Automation
        const heavyPatterns = [
            'kubeadm init',
            'kubeadm join',
            'docker pull',
            'containerd config',
            'kubectl apply',
            'calicoctl',
            'dnf install',
            'dnf update',
        ];

        it.each(heavyPatterns)(
            'should NOT contain heavy inline command: %s',
            (pattern) => {
                expect(containsPattern(pattern)).toBe(false);
            },
        );
    });

    // =========================================================================
    // IAM — Core Policies
    // =========================================================================
    describe('IAM Configuration', () => {
        const { template } = createWorkerAsgStack('general');

        it('should create at least one IAM role', () => {
            const roles = template.findResources('AWS::IAM::Role');
            expect(Object.keys(roles).length).toBeGreaterThanOrEqual(1);
        });

        it('should create an IAM instance profile', () => {
            const profiles = template.findResources('AWS::IAM::InstanceProfile');
            expect(Object.keys(profiles).length).toBeGreaterThanOrEqual(1);
        });

        it('should grant SSM GetParameter for kubeadm join parameters', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'ReadK8sJoinParams',
                            Action: 'ssm:GetParameter',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant kms:Decrypt for SSM SecureString parameters', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DecryptSsmSecureStrings',
                            Action: 'kms:Decrypt',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant ECR pull permissions including ListImages', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'EcrPullImages',
                            Effect: 'Allow',
                            Action: Match.arrayWith([
                                'ecr:ListImages',
                                'ecr:DescribeImages',
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('should grant SSM Automation execution permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'SsmAutomationExecution',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant EBS CSI driver volume lifecycle permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'EbsCsiDriverVolumeLifecycle',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant Cluster Autoscaler read-only describe permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'ClusterAutoscalerDescribe',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should NOT grant CA scale-write permissions (general nodes do not host CA)', () => {
            // ClusterAutoscalerScale (SetDesiredCapacity, TerminateInstanceInAutoScalingGroup)
            // must be absent — these are write permissions that widen blast radius on nodes
            // that will never schedule the Cluster Autoscaler Deployment.
            const policies = template.findResources('AWS::IAM::Policy');
            const hasScaleWrite = Object.values(policies).some((resource) => {
                const statements = (resource as {
                    Properties?: { PolicyDocument?: { Statement?: Array<{ Sid?: string }> } };
                }).Properties?.PolicyDocument?.Statement;
                return statements?.some((s) => s.Sid === 'ClusterAutoscalerScale');
            });
            expect(hasScaleWrite).toBe(false);
        });

        it('should grant CloudWatch read-only for Grafana', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CloudWatchGrafanaReadOnly',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant sts:AssumeRole for cross-account DNS role', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'AssumeRoute53DnsRole',
                            Action: 'sts:AssumeRole',
                            Effect: 'Allow',
                            Resource: TEST_CROSS_ACCOUNT_DNS_ROLE_ARN,
                        }),
                    ]),
                }),
            });
        });

        describe('when crossAccountDnsRoleArn is NOT provided', () => {
            const { template: noDnsTemplate } = createWorkerAsgStack('general', {
                crossAccountDnsRoleArn: undefined,
            });

            it('should NOT grant sts:AssumeRole', () => {
                const policies = noDnsTemplate.findResources('AWS::IAM::Policy');
                const hasAssumeRoute53 = Object.values(policies).some((resource) => {
                    const statements = (resource as {
                        Properties?: { PolicyDocument?: { Statement?: Array<{ Sid?: string }> } };
                    }).Properties?.PolicyDocument?.Statement;
                    return statements?.some((s) => s.Sid === 'AssumeRoute53DnsRole');
                });
                expect(hasAssumeRoute53).toBe(false);
            });
        });
    });

    // =========================================================================
    // No monitoring-only resources on general pool
    // =========================================================================
    describe('General pool — no monitoring-only resources', () => {
        const { template } = createWorkerAsgStack('general');

        it('should NOT create a monitoring-alerts SNS topic (only the ASG scaling topic)', () => {
            // AutoScalingGroupConstruct always creates 1 SNS topic (scaling notifications).
            // The monitoring pool adds a second topic (monitoring alerts). Verify the general
            // pool has exactly 1 — the scaling topic — and no monitoring-alerts topic.
            const topics = template.findResources('AWS::SNS::Topic');
            const topicNames = Object.values(topics).map((t) => {
                const resource = t as { Properties?: { TopicName?: string } };
                // eslint-disable-next-line jest/no-conditional-in-test
                return resource.Properties?.TopicName ?? '';
            });
            const hasMonitoringAlerts = topicNames.some((name) =>
                name.includes('monitoring-alerts'),
            );
            expect(hasMonitoringAlerts).toBe(false);
        });

        it('should NOT create an SNS email subscription', () => {
            template.resourceCountIs('AWS::SNS::Subscription', 0);
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createWorkerAsgStack('general');

        it('should export AsgName', () => {
            template.hasOutput('AsgName', {
                Description: 'general pool ASG name',
            });
        });

        it('should export InstanceRoleArn', () => {
            template.hasOutput('InstanceRoleArn', {
                Description: 'general pool IAM instance role ARN',
            });
        });

        it('should NOT export MonitoringAlertsTopicArn', () => {
            const outputs = template.findOutputs('MonitoringAlertsTopicArn');
            expect(Object.keys(outputs)).toHaveLength(0);
        });
    });
});

// =============================================================================
// Monitoring Pool Tests
// =============================================================================

describe('KubernetesWorkerAsgStack — monitoring pool', () => {

    // =========================================================================
    // Launch Template
    // =========================================================================
    describe('Launch Template', () => {
        const { template } = createWorkerAsgStack('monitoring');

        it('should create a launch template', () => {
            template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
        });
    });

    // =========================================================================
    // Auto Scaling Group
    // =========================================================================
    describe('Auto Scaling Group', () => {
        const { template } = createWorkerAsgStack('monitoring');

        it('should create an ASG', () => {
            template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
        });

        it('should use default maxCapacity=2 for monitoring pool', () => {
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MaxSize: '2',
            });
        });

        it('should use minCapacity=1', () => {
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MinSize: '1',
            });
        });
    });

    // =========================================================================
    // User Data
    // =========================================================================
    describe('User Data', () => {
        const { template } = createWorkerAsgStack('monitoring');
        const userDataParts = extractUserDataParts(template);
        const userDataContent = userDataParts.join('');
        const stringParts = userDataParts.filter((p): p is string => typeof p === 'string');
        const containsPattern = (pattern: string): boolean =>
            stringParts.some((p) => p.includes(pattern));

        it('should stay under the CloudFormation 16 KB user data limit', () => {
            const sizeBytes = Buffer.byteLength(userDataContent, 'utf-8');
            expect(sizeBytes).toBeLessThan(CF_USER_DATA_MAX_BYTES);
        });

        it('should publish instance ID with monitoring-pool bootstrap role key', () => {
            expect(containsPattern('ssm put-parameter')).toBe(true);
            expect(containsPattern('monitoring-pool-instance-id')).toBe(true);
        });

        it('should send cfn-signal for infrastructure readiness', () => {
            expect(containsPattern('cfn-signal --success true')).toBe(true);
        });
    });

    // =========================================================================
    // IAM — Monitoring-Only Policies
    // =========================================================================
    describe('IAM — monitoring-only policies', () => {
        const { template } = createWorkerAsgStack('monitoring');

        it('should attach ViewOnlyAccess managed policy for Steampipe', () => {
            // ManagedPolicyArns are rendered as Fn::Join tokens in synthesised templates.
            // We verify at least one policy references 'ViewOnlyAccess' anywhere in its structure.
            const roles = template.findResources('AWS::IAM::Role');
            const hasViewOnly = Object.values(roles).some((role) => {
                // eslint-disable-next-line jest/no-conditional-in-test
                const arns: unknown[] = (role as {
                    Properties?: { ManagedPolicyArns?: unknown[] };
                }).Properties?.ManagedPolicyArns ?? [];
                return arns.some((arn) => JSON.stringify(arn).includes('ViewOnlyAccess'));
            });
            expect(hasViewOnly).toBe(true);
        });

        it('should grant Steampipe CloudInventoryReadOnly supplemental actions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'SteampipeCloudInventoryReadOnly',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant SNS Publish for Grafana alerting contact point', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'SnsPublishAlerts',
                            Action: 'sns:Publish',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant Cluster Autoscaler WRITE permissions (monitoring pool hosts CA)', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'ClusterAutoscalerScale',
                            Effect: 'Allow',
                            Action: Match.arrayWith([
                                'autoscaling:SetDesiredCapacity',
                                'autoscaling:TerminateInstanceInAutoScalingGroup',
                            ]),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // SNS Topic — Monitoring Alerts
    // =========================================================================
    describe('SNS Monitoring Alerts', () => {
        const { template } = createWorkerAsgStack('monitoring');

        it('should create at least one SNS topic for alerts', () => {
            const topics = template.findResources('AWS::SNS::Topic');
            expect(Object.keys(topics).length).toBeGreaterThanOrEqual(1);
        });

        it('should create an email subscription when notificationEmail is provided', () => {
            template.hasResourceProperties('AWS::SNS::Subscription', {
                Protocol: 'email',
                Endpoint: TEST_NOTIFICATION_EMAIL,
            });
        });

        it('should create an email subscription from SSM ops-email fallback when notificationEmail is omitted', () => {
            // The stack always subscribes — either the explicit email prop or
            // the SSM-backed /ops-email fallback (added in fix: ami-refresh).
            const { template: noEmailTemplate } = createWorkerAsgStack('monitoring', {
                notificationEmail: undefined,
            });
            noEmailTemplate.resourceCountIs('AWS::SNS::Subscription', 1);
        });
    });

    // =========================================================================
    // SSM Parameter — Alerts Topic ARN
    // =========================================================================
    describe('SSM Parameter — alerts topic ARN', () => {
        const { template } = createWorkerAsgStack('monitoring');

        it('should publish the alerts topic ARN to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Description: Match.stringLikeRegexp('SNS topic ARN.*Grafana'),
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createWorkerAsgStack('monitoring');

        it('should export AsgName', () => {
            template.hasOutput('AsgName', {
                Description: 'monitoring pool ASG name',
            });
        });

        it('should export InstanceRoleArn', () => {
            template.hasOutput('InstanceRoleArn', {
                Description: 'monitoring pool IAM instance role ARN',
            });
        });

        it('should export MonitoringAlertsTopicArn', () => {
            template.hasOutput('MonitoringAlertsTopicArn', {
                Description: 'SNS topic ARN for Grafana monitoring alerts',
            });
        });
    });
});
