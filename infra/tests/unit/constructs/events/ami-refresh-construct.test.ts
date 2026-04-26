import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { AmiRefreshConstruct } from '../../../../lib/constructs/events/ami-refresh/ami-refresh-construct';

function buildTemplate(): Template {
  const app = new cdk.App({
    context: { 'aws:cdk:bundling-stacks': [] },
  });
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
  });
  new AmiRefreshConstruct(stack, 'AmiRefresh', {
    ssmPrefix: '/k8s/development',
    workerLtNames: ['k8s-dev-general-lt', 'k8s-dev-monitoring-lt'],
    workerAsgNames: ['k8s-dev-general-asg', 'k8s-dev-monitoring-asg'],
    controlPlaneLtName: 'k8s-dev-control-plane-lt',
    controlPlaneAsgName: 'k8s-dev-control-plane-asg',
  });
  return Template.fromStack(stack);
}

describe('AmiRefreshConstruct', () => {
  let template: Template;
  beforeAll(() => { template = buildTemplate(); });

  it('should create a Standard Step Functions state machine with X-Ray tracing and ALL-level logging', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({
        Level: 'ALL',
        IncludeExecutionData: true,
      }),
    });
  });

  it('should create an EventBridge rule with correct SSM filter (suffix and operation)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.ssm'],
        'detail-type': ['Parameter Store Change'],
        detail: {
          name: [{ suffix: '/golden-ami/latest' }],
          operation: ['Update'],
        },
      },
    });
  });

  it('should write worker lt-names SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/workers/lt-names',
      Value: JSON.stringify(['k8s-dev-general-lt', 'k8s-dev-monitoring-lt']),
    });
  });

  it('should write worker asg-names SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/workers/asg-names',
      Value: JSON.stringify(['k8s-dev-general-asg', 'k8s-dev-monitoring-asg']),
    });
  });

  it('should write control-plane lt-name SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/control-plane/lt-name',
      Value: 'k8s-dev-control-plane-lt',
    });
  });

  it('should write control-plane asg-name SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/control-plane/asg-name',
      Value: 'k8s-dev-control-plane-asg',
    });
  });

  it('should create at least three Lambda functions (update-lt, start-refresh, check-status)', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(3);
  });

  it('should grant ec2:CreateLaunchTemplateVersion and ec2:ModifyLaunchTemplate permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ec2:CreateLaunchTemplateVersion',
              'ec2:ModifyLaunchTemplate',
            ]),
          }),
        ]),
      },
    });
  });

  it('should grant autoscaling:StartInstanceRefresh and autoscaling:DescribeInstanceRefreshes permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'autoscaling:StartInstanceRefresh',
              'autoscaling:DescribeInstanceRefreshes',
            ]),
          }),
        ]),
      },
    });
  });

  it('should grant ssm:GetParameter permission', () => {
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: {
        Roles: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp('AmiRefreshLambdaRole') })]),
      },
    });
    const actions = Object.values(policies).flatMap(
      (r: any) => (r.Properties.PolicyDocument.Statement as any[]).flatMap(
        (stmt: any) => ([] as string[]).concat(stmt.Action as string | string[]),
      ),
    );
    expect(actions).toContain('ssm:GetParameter');
  });
});
