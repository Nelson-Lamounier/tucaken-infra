/**
 * @format
 * EksSchedulerStack unit tests — CDK assertions.
 * Validates Lambda runtime, EventBridge Scheduler timezone, and IAM scope.
 */
import { Match, Template } from 'aws-cdk-lib/assertions';

import { EksSchedulerStack } from '../../../../lib/stacks/kubernetes/eks-scheduler-stack';
import { TEST_ENV_EU, createMockEksCluster } from '../../../fixtures';

/** CDK renders single-action statements as a plain string, multi-action as an array. */
function hasAction(stmt: Record<string, unknown>, action: string): boolean {
    const a = stmt['Action'];
    return a === action || (Array.isArray(a) && (a as string[]).includes(action));
}

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

    it('should put eks:UpdateNodegroupConfig in a separate statement from eks:ListNodegroups', () => {
        // ListNodegroups scoped to cluster ARN; UpdateNodegroupConfig to nodegroup ARN —
        // they must NOT be in the same statement.
        const policies = template.findResources('AWS::IAM::Policy');
        const statements = Object.values(policies).flatMap(
            (p: Record<string, unknown>) =>
                ((p as any).Properties.PolicyDocument.Statement as Record<string, unknown>[]),
        );
        const listStmt = statements.find((s) => hasAction(s, 'eks:ListNodegroups'));
        const updateStmt = statements.find((s) => hasAction(s, 'eks:UpdateNodegroupConfig'));
        expect(listStmt).toBeDefined();
        expect(updateStmt).toBeDefined();
        // They are separate statements (different IAM resources)
        expect(listStmt).not.toStrictEqual(updateStmt);
        expect(hasAction(listStmt!, 'eks:UpdateNodegroupConfig')).toBe(false);
        expect(hasAction(updateStmt!, 'eks:ListNodegroups')).toBe(false);
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
