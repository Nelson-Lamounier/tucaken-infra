import * as path from 'path';

import { NagSuppressions } from 'cdk-nag';

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export interface AmiRefreshProps {
  readonly ssmPrefix: string;
  /** Concrete Launch Template names (not IDs) for all worker pools */
  readonly workerLtNames: string[];
  readonly workerAsgNames: string[];
  /** Concrete Launch Template name (not ID) for the control plane */
  readonly controlPlaneLtName: string;
  readonly controlPlaneAsgName: string;
  readonly pollInterval?: cdk.Duration;
}

export class AmiRefreshConstruct extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: AmiRefreshProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const poll = props.pollInterval ?? cdk.Duration.seconds(60);

    // SSM config parameters — read by Lambdas at runtime
    new ssm.StringParameter(this, 'WorkerLtNames', {
      parameterName: `${props.ssmPrefix}/ami-refresh/workers/lt-names`,
      stringValue: JSON.stringify(props.workerLtNames),
    });
    new ssm.StringParameter(this, 'WorkerAsgNames', {
      parameterName: `${props.ssmPrefix}/ami-refresh/workers/asg-names`,
      stringValue: JSON.stringify(props.workerAsgNames),
    });
    new ssm.StringParameter(this, 'ControlPlaneLtName', {
      parameterName: `${props.ssmPrefix}/ami-refresh/control-plane/lt-name`,
      stringValue: props.controlPlaneLtName,
    });
    new ssm.StringParameter(this, 'ControlPlaneAsgName', {
      parameterName: `${props.ssmPrefix}/ami-refresh/control-plane/asg-name`,
      stringValue: props.controlPlaneAsgName,
    });

    // Shared Lambda execution role
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'Ec2LaunchTemplate',
      actions: [
        'ec2:CreateLaunchTemplateVersion',
        'ec2:ModifyLaunchTemplate',
        'ec2:DescribeLaunchTemplateVersions',
      ],
      resources: [`arn:aws:ec2:${stack.region}:${stack.account}:launch-template/*`],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AsgRefresh',
      actions: ['autoscaling:StartInstanceRefresh', 'autoscaling:DescribeInstanceRefreshes'],
      resources: ['*'],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmRead',
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/ami-refresh/*`,
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/golden-ami/latest`,
      ],
    }));

    // Lambda functions
    const bundling: nodejs.BundlingOptions = { minify: true, sourceMap: false };
    const runtime = lambda.Runtime.NODEJS_22_X;

    const updateLtFn = new nodejs.NodejsFunction(this, 'UpdateLtFn', {
      entry: path.join(__dirname, 'handlers/update-launch-template.ts'),
      handler: 'handler',
      runtime,
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      role: lambdaRole,
      bundling,
    });
    NagSuppressions.addResourceSuppressions(updateLtFn, [{
      id: 'AwsSolutions-L1',
      reason: 'NODEJS_22_X is the latest Node.js runtime available in CDK; cdk-nag version-check is overly conservative',
    }]);

    const startRefreshFn = new nodejs.NodejsFunction(this, 'StartRefreshFn', {
      entry: path.join(__dirname, 'handlers/start-instance-refresh.ts'),
      handler: 'handler',
      runtime,
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      role: lambdaRole,
      bundling,
    });
    NagSuppressions.addResourceSuppressions(startRefreshFn, [{
      id: 'AwsSolutions-L1',
      reason: 'NODEJS_22_X is the latest Node.js runtime available in CDK; cdk-nag version-check is overly conservative',
    }]);

    const checkStatusFn = new nodejs.NodejsFunction(this, 'CheckStatusFn', {
      entry: path.join(__dirname, 'handlers/check-refresh-status.ts'),
      handler: 'handler',
      runtime,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      role: lambdaRole,
      bundling,
      environment: { MAX_WAIT_MINUTES: '40' },
    });
    NagSuppressions.addResourceSuppressions(checkStatusFn, [{
      id: 'AwsSolutions-L1',
      reason: 'NODEJS_22_X is the latest Node.js runtime available in CDK; cdk-nag version-check is overly conservative',
    }]);

    // State machine — terminal states
    const workerRefreshFailed = new sfn.Fail(this, 'WorkerRefreshFailed', {
      error: 'WorkerRefreshFailed',
      cause: 'Worker ASG instance refresh failed — check Lambda logs in CloudWatch',
    });
    const controlPlaneFailed = new sfn.Fail(this, 'ControlPlaneRefreshFailed', {
      error: 'ControlPlaneRefreshFailed',
      cause: 'Control plane ASG instance refresh failed — check Lambda logs in CloudWatch',
    });
    const amiRefreshComplete = new sfn.Succeed(this, 'AmiRefreshComplete');

    // Phase 1: Workers
    const updateWorkerTemplates = new sfnTasks.LambdaInvoke(this, 'UpdateWorkerTemplates', {
      lambdaFunction: updateLtFn,
      payload: sfn.TaskInput.fromObject({ 'paramName.$': '$.paramName', role: 'workers' }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    updateWorkerTemplates.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(30), backoffRate: 1.5 });
    updateWorkerTemplates.addCatch(workerRefreshFailed, { errors: ['States.ALL'], resultPath: sfn.JsonPath.DISCARD });

    const startWorkerRefresh = new sfnTasks.LambdaInvoke(this, 'StartWorkerRefresh', {
      lambdaFunction: startRefreshFn,
      payload: sfn.TaskInput.fromObject({ 'paramName.$': '$.paramName', role: 'workers' }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    startWorkerRefresh.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(30), backoffRate: 1.5 });
    startWorkerRefresh.addCatch(workerRefreshFailed, { errors: ['States.ALL'], resultPath: sfn.JsonPath.DISCARD });

    const waitForWorkerRefresh = new sfn.Wait(this, 'WaitForWorkerRefresh', {
      time: sfn.WaitTime.duration(poll),
    });

    const checkWorkerRefreshStatus = new sfnTasks.LambdaInvoke(this, 'CheckWorkerRefreshStatus', {
      lambdaFunction: checkStatusFn,
      payload: sfn.TaskInput.fromObject({ 'paramName.$': '$.paramName', role: 'workers' }),
      resultSelector: { 'status.$': '$.Payload.status', 'detail.$': '$.Payload.detail' },
      resultPath: '$.workerStatus',
    });
    checkWorkerRefreshStatus.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(30), backoffRate: 1.5 });
    checkWorkerRefreshStatus.addCatch(workerRefreshFailed, { errors: ['States.ALL'], resultPath: sfn.JsonPath.DISCARD });

    // Phase 2: Control Plane
    const updateControlPlaneTemplate = new sfnTasks.LambdaInvoke(this, 'UpdateControlPlaneTemplate', {
      lambdaFunction: updateLtFn,
      payload: sfn.TaskInput.fromObject({ 'paramName.$': '$.paramName', role: 'control-plane' }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    updateControlPlaneTemplate.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(30), backoffRate: 1.5 });
    updateControlPlaneTemplate.addCatch(controlPlaneFailed, { errors: ['States.ALL'], resultPath: sfn.JsonPath.DISCARD });

    const startControlPlaneRefresh = new sfnTasks.LambdaInvoke(this, 'StartControlPlaneRefresh', {
      lambdaFunction: startRefreshFn,
      payload: sfn.TaskInput.fromObject({ 'paramName.$': '$.paramName', role: 'control-plane' }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    startControlPlaneRefresh.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(30), backoffRate: 1.5 });
    startControlPlaneRefresh.addCatch(controlPlaneFailed, { errors: ['States.ALL'], resultPath: sfn.JsonPath.DISCARD });

    const waitForControlPlaneRefresh = new sfn.Wait(this, 'WaitForControlPlaneRefresh', {
      time: sfn.WaitTime.duration(poll),
    });

    const checkControlPlaneStatus = new sfnTasks.LambdaInvoke(this, 'CheckControlPlaneRefreshStatus', {
      lambdaFunction: checkStatusFn,
      payload: sfn.TaskInput.fromObject({ 'paramName.$': '$.paramName', role: 'control-plane' }),
      resultSelector: { 'status.$': '$.Payload.status', 'detail.$': '$.Payload.detail' },
      resultPath: '$.cpStatus',
    });
    checkControlPlaneStatus.addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(30), backoffRate: 1.5 });
    checkControlPlaneStatus.addCatch(controlPlaneFailed, { errors: ['States.ALL'], resultPath: sfn.JsonPath.DISCARD });

    // Choice states (poll loops)
    const workersHealthy = new sfn.Choice(this, 'WorkersHealthy')
      .when(sfn.Condition.stringEquals('$.workerStatus.status', 'COMPLETE'), updateControlPlaneTemplate)
      .when(sfn.Condition.stringEquals('$.workerStatus.status', 'FAILED'), workerRefreshFailed)
      .otherwise(waitForWorkerRefresh);

    const controlPlaneHealthy = new sfn.Choice(this, 'ControlPlaneHealthy')
      .when(sfn.Condition.stringEquals('$.cpStatus.status', 'COMPLETE'), amiRefreshComplete)
      .when(sfn.Condition.stringEquals('$.cpStatus.status', 'FAILED'), controlPlaneFailed)
      .otherwise(waitForControlPlaneRefresh);

    // Wire poll loops
    waitForWorkerRefresh.next(checkWorkerRefreshStatus);
    checkWorkerRefreshStatus.next(workersHealthy);
    waitForControlPlaneRefresh.next(checkControlPlaneStatus);
    checkControlPlaneStatus.next(controlPlaneHealthy);

    // Wire phase 2 chain
    updateControlPlaneTemplate
      .next(startControlPlaneRefresh)
      .next(waitForControlPlaneRefresh);

    // Full definition (starts at phase 1)
    const definition = updateWorkerTemplates
      .next(startWorkerRefresh)
      .next(waitForWorkerRefresh);

    // Logging
    const sfnLogGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName: `/aws/vendedlogs/states${props.ssmPrefix}-ami-refresh`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineType: sfn.StateMachineType.STANDARD,
      stateMachineName: `${props.ssmPrefix.replace(/\//g, '-').replace(/^-/, '')}-ami-refresh`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
      logs: { destination: sfnLogGroup, level: sfn.LogLevel.ALL, includeExecutionData: true },
    });

    // EventBridge rule
    new events.Rule(this, 'AmiSsmChangeRule', {
      description: 'Trigger AMI refresh state machine when golden-ami/latest SSM parameter updates',
      eventPattern: {
        source: ['aws.ssm'],
        detailType: ['Parameter Store Change'],
        detail: {
          name: [{ suffix: '/golden-ami/latest' }],
          operation: ['Update'],
        },
      },
      targets: [
        new targets.SfnStateMachine(this.stateMachine, {
          input: events.RuleTargetInput.fromObject({
            paramName: events.EventField.fromPath('$.detail.name'),
          }),
        }),
      ],
    });
  }
}
