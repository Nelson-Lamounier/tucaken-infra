/**
 * @format
 * EksSchedulerStack unit tests — CDK assertions.
 * Validates Lambda runtime, EventBridge Scheduler timezone, and IAM scope.
 */
import { Match, Template } from 'aws-cdk-lib/assertions';

import { EksSchedulerStack } from '../../../../lib/stacks/kubernetes/eks-scheduler-stack';
import { TEST_ENV_EU, createMockEksCluster } from '../../../fixtures';

function buildStack(): Template {
    const { app, cluster } = createMockEksCluster();

    const schedulerStack = new EksSchedulerStack(app, 'SchedulerStack', {
        env: TEST_ENV_EU,
        cluster,
        nodeGroupName: 'system-ng',
    });

    return Template.fromStack(schedulerStack);
}

describe('EksSchedulerStack', () => {
    let template: Template;

    beforeAll(() => {
        template = buildStack();
    });

    it('should create two Lambda functions with PYTHON_3_14 runtime', () => {
        template.resourceCountIs('AWS::Lambda::Function', 2);
        template.allResourcesProperties('AWS::Lambda::Function', {
            Runtime: 'python3.14',
        });
    });

    it('should create scale-up schedule with Europe/Dublin timezone at 4am', () => {
        template.hasResourceProperties('AWS::Scheduler::Schedule', {
            ScheduleExpression: 'cron(0 4 * * ? *)',
            ScheduleExpressionTimezone: 'Europe/Dublin',
        });
    });

    it('should create scale-down schedule with Europe/Dublin timezone at 11pm', () => {
        template.hasResourceProperties('AWS::Scheduler::Schedule', {
            ScheduleExpression: 'cron(0 23 * * ? *)',
            ScheduleExpressionTimezone: 'Europe/Dublin',
        });
    });

    it('should grant Lambda execution role eks:UpdateNodegroupConfig', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: Match.arrayWith(['eks:UpdateNodegroupConfig']),
                    }),
                ]),
            },
        });
    });

    it('should scope ec2:TerminateInstances to workload tag on Lambda execution role', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: 'ec2:TerminateInstances',
                        Condition: {
                            StringEquals: {
                                'ec2:ResourceTag/eks-cluster-pool': 'workloads-default',
                            },
                        },
                    }),
                ]),
            },
        });
    });
});
