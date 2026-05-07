/**
 * @format
 * EKS Scheduler Stack — dev-only EventBridge Scheduler for auto start/stop.
 *
 * Provisions two Lambda functions (scale-up, scale-down) invoked by
 * EventBridge Scheduler on Europe/Dublin cron schedules:
 *   - Scale-up:   04:00 daily  → MNG minSize=3, desiredSize=3
 *   - Scale-down: 23:00 daily  → MNG minSize=0, desiredSize=0 + terminate
 *                                 any Karpenter workload EC2 instances
 *
 * Only instantiated for Environment.DEVELOPMENT (factory gate).
 *
 * @see docs/superpowers/specs/2026-05-07-eks-resource-optimisation-design.md §§ 3.4, 3.5
 */
import { NagSuppressions } from 'cdk-nag';

import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

export interface EksSchedulerStackProps extends cdk.StackProps {
    readonly cluster: eks.ICluster;
    /** CDK token for the system MNG node group name (from EksSystemNodeGroupStack.nodeGroup.nodegroupName). */
    readonly nodeGroupName: string;
}

export class EksSchedulerStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksSchedulerStackProps) {
        super(scope, id, props);

        const { cluster, nodeGroupName } = props;

        const lambdaRole = new iam.Role(this, 'SchedulerLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AWSLambdaBasicExecutionRole',
                ),
            ],
        });

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'eks:UpdateNodegroupConfig',
                    'eks:DescribeNodegroup',
                    'eks:ListNodegroups',
                ],
                resources: [
                    cluster.clusterArn,
                    `${cluster.clusterArn}/nodegroup/*`,
                ],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['ec2:DescribeInstances'],
                resources: ['*'],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['ec2:TerminateInstances'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'ec2:ResourceTag/eks-cluster-pool': 'workloads-default',
                    },
                },
            }),
        );

        // DescribeInstances requires * — no resource-level restriction exists for Describe APIs.
        NagSuppressions.addResourceSuppressions(lambdaRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'ec2:DescribeInstances has no resource-level restriction in IAM. ' +
                        'ec2:TerminateInstances is tag-conditioned to eks-cluster-pool=workloads-default.',
                appliesTo: ['Resource::*'],
            },
        ], true);

        const commonEnv = {
            CLUSTER_NAME: cluster.clusterName,
            NODEGROUP_NAME: nodeGroupName,
        };

        const scaleUpFn = new lambda.Function(this, 'ScaleUpFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(1),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, os, logging
log = logging.getLogger()
log.setLevel(logging.INFO)

def handler(event, context):
    region = os.environ['AWS_REGION']
    client = boto3.client('eks', region_name=region)
    client.update_nodegroup_config(
        clusterName=os.environ['CLUSTER_NAME'],
        nodegroupName=os.environ['NODEGROUP_NAME'],
        scalingConfig={'minSize': 3, 'desiredSize': 3, 'maxSize': 4},
    )
    log.info('Scaled MNG to 3')
    return {'status': 'scaled-up'}
`),
        });

        const scaleDownFn = new lambda.Function(this, 'ScaleDownFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, os, logging
log = logging.getLogger()
log.setLevel(logging.INFO)

def handler(event, context):
    region = os.environ['AWS_REGION']
    eks = boto3.client('eks', region_name=region)
    ec2 = boto3.client('ec2', region_name=region)
    eks.update_nodegroup_config(
        clusterName=os.environ['CLUSTER_NAME'],
        nodegroupName=os.environ['NODEGROUP_NAME'],
        scalingConfig={'minSize': 0, 'desiredSize': 0, 'maxSize': 4},
    )
    log.info('Scaled MNG to 0')
    resp = ec2.describe_instances(
        Filters=[
            {'Name': 'tag:eks-cluster-pool', 'Values': ['workloads-default']},
            {'Name': 'instance-state-name', 'Values': ['running']},
        ]
    )
    ids = [i['InstanceId'] for r in resp['Reservations'] for i in r['Instances']]
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        log.info('Terminated: %s', ids)
    return {'terminated': ids}
`),
        });

        const schedulerRole = new iam.Role(this, 'SchedulerRole', {
            assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
        });

        schedulerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['lambda:InvokeFunction'],
                resources: [scaleUpFn.functionArn, scaleDownFn.functionArn],
            }),
        );

        new scheduler.CfnSchedule(this, 'ScaleUpSchedule', {
            scheduleExpression: 'cron(0 4 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleUpFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });

        new scheduler.CfnSchedule(this, 'ScaleDownSchedule', {
            scheduleExpression: 'cron(0 23 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleDownFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });
    }
}
