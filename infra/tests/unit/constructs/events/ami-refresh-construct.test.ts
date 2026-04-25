import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AmiRefreshConstruct } from '../../../../lib/constructs/events/ami-refresh/ami-refresh-construct';

function buildTemplate(): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
  });
  new AmiRefreshConstruct(stack, 'AmiRefresh', {
    ssmPrefix: '/k8s/development',
    workerLtIds: ['lt-worker-111', 'lt-worker-222'],
    workerAsgNames: ['k8s-dev-general-asg', 'k8s-dev-monitoring-asg'],
    controlPlaneLtId: 'lt-cp-999',
    controlPlaneAsgName: 'k8s-dev-control-plane-asg',
  });
  return Template.fromStack(stack);
}

describe('AmiRefreshConstruct', () => {
  let template: Template;
  beforeAll(() => { template = buildTemplate(); });

  it('creates a Step Functions Standard state machine', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: Match.absent(),
    });
  });

  it('creates an EventBridge rule targeting the state machine', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.ssm'],
        'detail-type': ['Parameter Store Change'],
      },
    });
  });

  it('writes worker lt-ids SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/workers/lt-ids',
      Value: JSON.stringify(['lt-worker-111', 'lt-worker-222']),
    });
  });

  it('writes control-plane asg-name SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/control-plane/asg-name',
      Value: 'k8s-dev-control-plane-asg',
    });
  });

  it('creates three Lambda functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  it('Lambda role has ec2:CreateLaunchTemplateVersion permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ec2:CreateLaunchTemplateVersion']),
          }),
        ]),
      },
    });
  });

  it('Lambda role has autoscaling:StartInstanceRefresh permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['autoscaling:StartInstanceRefresh']),
          }),
        ]),
      },
    });
  });
});
