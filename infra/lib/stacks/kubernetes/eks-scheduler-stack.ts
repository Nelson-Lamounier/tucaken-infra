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
                actions: ['eks:ListNodegroups', 'eks:DescribeCluster'],
                resources: [cluster.clusterArn],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'eks:UpdateNodegroupConfig',
                    'eks:DescribeNodegroup',
                ],
                // nodegroup ARN format: arn:partition:eks:region:account:nodegroup/cluster-name/ng-name/id
                // NOT under the cluster ARN — different resource namespace
                resources: [
                    `arn:${cdk.Aws.PARTITION}:eks:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:nodegroup/${cluster.clusterName}/*/*`,
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
        // eks:UpdateNodegroupConfig/DescribeNodegroup require nodegroup/*/*  (wildcard over ng-name + uuid).
        NagSuppressions.addResourceSuppressions(lambdaRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'ec2:DescribeInstances has no resource-level restriction in IAM. ' +
                        'ec2:TerminateInstances is tag-conditioned to eks-cluster-pool=workloads-default. ' +
                        'eks nodegroup actions scoped to nodegroup/<cluster>/*/* (uuid not known at synth time).',
                appliesTo: [
                    'Resource::*',
                    { regex: '/^Resource::.*:nodegroup\\/.*\\/\\*\\/\\*/' },
                ],
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
import boto3, base64, json, ssl, tempfile, urllib.request, os, logging
from botocore.signers import RequestSigner

log = logging.getLogger()
log.setLevel(logging.INFO)

def get_bearer_token(cluster_id, region):
    """Generate EKS auth token (equivalent to: aws eks get-token --cluster-name X)."""
    session = boto3.session.Session()
    client = session.client('sts', region_name=region)
    signer = RequestSigner(
        client.meta.service_model.service_id,
        region, 'sts', 'v4',
        session.get_credentials(), session.events,
    )
    signed_url = signer.generate_presigned_url(
        {
            'method': 'GET',
            'url': f'https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
            'body': {},
            'headers': {'x-k8s-aws-id': cluster_id},
            'context': {},
        },
        region_name=region, expires_in=60, operation_name='',
    )
    return 'k8s-aws-v1.' + base64.urlsafe_b64encode(signed_url.encode()).decode().rstrip('=')

def handler(event, context):
    region = os.environ['AWS_REGION']
    cluster_name = os.environ['CLUSTER_NAME']
    ng_name = os.environ['NODEGROUP_NAME']
    eks = boto3.client('eks', region_name=region)

    eks.update_nodegroup_config(
        clusterName=cluster_name,
        nodegroupName=ng_name,
        scalingConfig={'minSize': 2, 'desiredSize': 2},
    )
    log.info('Scaled MNG to 2')

    # Restore Karpenter to 2 replicas. dev-shutdown scales it to 0 after
    # clearing NodeClaim finalizers; without this patch the controller stays
    # down and no workload nodes are ever provisioned after cluster start.
    cluster_info = eks.describe_cluster(name=cluster_name)['cluster']
    endpoint = cluster_info['endpoint']
    ca_data = base64.b64decode(cluster_info['certificateAuthority']['data'])
    token = get_bearer_token(cluster_name, region)

    with tempfile.NamedTemporaryFile(delete=False, suffix='.crt') as f:
        f.write(ca_data)
        ca_file = f.name

    ctx = ssl.create_default_context(cafile=ca_file)
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/merge-patch+json',
    }

    def patch_replicas(namespace, deployment, replicas):
        url = f'{endpoint}/apis/apps/v1/namespaces/{namespace}/deployments/{deployment}'
        req = urllib.request.Request(
            url,
            data=json.dumps({'spec': {'replicas': replicas}}).encode(),
            method='PATCH',
            headers=headers,
        )
        with urllib.request.urlopen(req, context=ctx) as resp:
            log.info('Patched %s/%s to %d replicas: %s', namespace, deployment, replicas, resp.status)

    def ensure_argocd_secret():
        # argocd-secret is Helm-managed with helm.sh/resource-policy:keep.
        # helm upgrade (not fresh install) skips recreating deleted keep-annotated
        # resources — argocd-server and argocd-dex-server crash on startup without it.
        url = f'{endpoint}/api/v1/namespaces/argocd/secrets/argocd-secret'
        try:
            urllib.request.urlopen(
                urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'}),
                context=ctx,
            )
            log.info('argocd-secret present')
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            log.info('argocd-secret missing -- creating with random secretkey')
            body = json.dumps({
                'apiVersion': 'v1', 'kind': 'Secret',
                'metadata': {'name': 'argocd-secret', 'namespace': 'argocd'},
                'type': 'Opaque',
                'data': {'server.secretkey': base64.b64encode(os.urandom(32)).decode()},
            }).encode()
            with urllib.request.urlopen(
                urllib.request.Request(
                    f'{endpoint}/api/v1/namespaces/argocd/secrets',
                    data=body, method='POST',
                    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
                ),
                context=ctx,
            ) as r:
                log.info('Created argocd-secret: %s', r.status)

    # Restore Karpenter — dev-shutdown scales it to 0 after clearing NodeClaim
    # finalizers. Without this, no workload nodes are ever provisioned.
    patch_replicas('karpenter', 'karpenter', 2)

    # Ensure argocd-secret exists before scaling ArgoCD back up.
    # helm upgrade skips keep-annotated resources when the release already exists,
    # leaving argocd-server/dex-server in CrashLoopBackOff on restore.
    ensure_argocd_secret()


    # Restore ArgoCD — dev-shutdown scales all argocd Deployments to 0 to
    # prevent automated sync from re-provisioning workloads during shutdown.
    argocd_deployments = [
        'argocd-applicationset-controller', 'argocd-dex-server', 'argocd-image-updater',
        'argocd-notifications-controller', 'argocd-redis', 'argocd-repo-server', 'argocd-server',
    ]
    for deploy in argocd_deployments:
        patch_replicas('argocd', deploy, 1)

    return {'status': 'scaled-up', 'karpenter-replicas': 2, 'argocd-restored': argocd_deployments}
`),
        });

        const scaleDownFn = new lambda.Function(this, 'ScaleDownFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, base64, json, ssl, tempfile, urllib.request, os, logging
from botocore.signers import RequestSigner

log = logging.getLogger()
log.setLevel(logging.INFO)

def get_bearer_token(cluster_id, region):
    session = boto3.session.Session()
    client = session.client('sts', region_name=region)
    signer = RequestSigner(
        client.meta.service_model.service_id,
        region, 'sts', 'v4',
        session.get_credentials(), session.events,
    )
    signed_url = signer.generate_presigned_url(
        {
            'method': 'GET',
            'url': f'https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
            'body': {},
            'headers': {'x-k8s-aws-id': cluster_id},
            'context': {},
        },
        region_name=region, expires_in=60, operation_name='',
    )
    return 'k8s-aws-v1.' + base64.urlsafe_b64encode(signed_url.encode()).decode().rstrip('=')

def handler(event, context):
    region = os.environ['AWS_REGION']
    cluster_name = os.environ['CLUSTER_NAME']
    eks_client = boto3.client('eks', region_name=region)
    ec2 = boto3.client('ec2', region_name=region)

    # Scale ArgoCD and Karpenter deployments to 0 BEFORE cutting nodes.
    # Karpenter at 0 prevents it from replacing the Karpenter EC2 nodes we
    # are about to terminate. ArgoCD at 0 prevents automated sync from
    # re-provisioning workloads during the drain window.
    # Wrapped in try/except so a K8s API hiccup does not block the MNG scale-down.
    try:
        cluster_info = eks_client.describe_cluster(name=cluster_name)['cluster']
        endpoint = cluster_info['endpoint']
        ca_data = base64.b64decode(cluster_info['certificateAuthority']['data'])
        token = get_bearer_token(cluster_name, region)

        with tempfile.NamedTemporaryFile(delete=False, suffix='.crt') as f:
            f.write(ca_data)
            ca_file = f.name

        ctx = ssl.create_default_context(cafile=ca_file)
        patch_headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/merge-patch+json',
        }

        def patch_replicas(namespace, deployment, replicas):
            url = f'{endpoint}/apis/apps/v1/namespaces/{namespace}/deployments/{deployment}'
            req = urllib.request.Request(
                url,
                data=json.dumps({'spec': {'replicas': replicas}}).encode(),
                method='PATCH',
                headers=patch_headers,
            )
            with urllib.request.urlopen(req, context=ctx) as resp:
                log.info('Patched %s/%s to %d replicas: %s', namespace, deployment, replicas, resp.status)

        patch_replicas('karpenter', 'karpenter', 0)
        for deploy in [
            'argocd-applicationset-controller', 'argocd-dex-server', 'argocd-image-updater',
            'argocd-notifications-controller', 'argocd-redis', 'argocd-repo-server', 'argocd-server',
        ]:
            patch_replicas('argocd', deploy, 0)
        log.info('Pre-shutdown K8s scale-down complete')
    except Exception as e:
        log.warning('K8s pre-shutdown scale failed (proceeding with MNG scale-down): %s', e)

    eks_client.update_nodegroup_config(
        clusterName=cluster_name,
        nodegroupName=os.environ['NODEGROUP_NAME'],
        scalingConfig={'minSize': 0, 'desiredSize': 0},
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

        // Grant the Lambda role permission to PATCH deployments in the two
        // namespaces that dev-shutdown scales to zero: karpenter (controller
        // restore) and argocd (server + repo-server restore). Scoped to these
        // two namespaces only — AmazonEKSEditPolicy is least privilege for
        // scale-up without granting cluster-wide access.
        new eks.AccessEntry(this, 'SchedulerLambdaAccessEntry', {
            cluster,
            principal: lambdaRole.roleArn,
            accessPolicies: [
                eks.AccessPolicy.fromAccessPolicyName('AmazonEKSEditPolicy', {
                    accessScopeType: eks.AccessScopeType.NAMESPACE,
                    namespaces: ['karpenter', 'argocd'],
                }),
            ],
        });

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
