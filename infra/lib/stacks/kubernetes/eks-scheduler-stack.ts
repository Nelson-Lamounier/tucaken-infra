/**
 * @format
 * EKS Scheduler Stack — dev-only EventBridge Scheduler for auto start/stop.
 *
 * Provisions two Lambda functions (scale-up, scale-down) invoked by
 * EventBridge Scheduler on Europe/Dublin cron schedules:
 *   - Scale-up:   04:00 daily  → MNG minSize=1, desiredSize=1 (landing
 *                                 zone only); Karpenter→1; ArgoCD×7→1;
 *                                 WAF IP sync (async)
 *   - Scale-down: 23:00 daily  → Karpenter→0; ArgoCD×7→0; terminate
 *                                 ALL Karpenter EC2s (tag-key
 *                                 eks-cluster-pool, every pool);
 *                                 MNG minSize=0, desiredSize=0
 *                                 (ESO not patched — out of RBAC scope;
 *                                 dies with its node, reconciled by ArgoCD)
 *
 * Scale-down pre-zeros Karpenter and ArgoCD via the K8s API before draining
 * the MNG so no orphaned nodes or reconciliation loops survive shutdown.
 * Scale-up restores only Karpenter and ArgoCD explicitly; ESO and all other
 * workloads recover through ArgoCD reconciliation once ArgoCD is back.
 *
 * Only instantiated for Environment.DEVELOPMENT (factory gate).
 *
 * NOTE: both schedules are currently created in the DISABLED state. The live
 * production app runs on the development account, so an active nightly stop
 * would take prod offline 23:00-04:00. The stack (Lambdas, IAM, schedules)
 * stays provisioned; nothing fires. Re-arm by setting state to 'ENABLED' on
 * both CfnSchedules once prod has its own account. See the disable rationale
 * at the two CfnSchedule definitions below.
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
    /**
     * Name of the WAF ip-sync Lambda (from EksPublicWafStack.ipSyncFunctionName).
     * When set, ScaleUpFn invokes it after scaling the MNG so the WAF IP
     * allowlist is refreshed from SSM on every cluster start.
     */
    readonly wafIpSyncFunctionName?: string;
}

export class EksSchedulerStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksSchedulerStackProps) {
        super(scope, id, props);

        const { cluster } = props;

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
                    // Any Karpenter-managed node, regardless of pool. Every
                    // EC2NodeClass sets eks-cluster-pool (workloads-default,
                    // system, …); StringLike '*' requires the tag present
                    // but matches any value — still scoped to Karpenter
                    // instances only, never MNG or unrelated EC2.
                    StringLike: {
                        'ec2:ResourceTag/eks-cluster-pool': '*',
                    },
                },
            }),
        );

        if (props.wafIpSyncFunctionName) {
            lambdaRole.addToPolicy(
                new iam.PolicyStatement({
                    actions: ['lambda:InvokeFunction'],
                    resources: [
                        `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${props.wafIpSyncFunctionName}`,
                    ],
                }),
            );
        }

        // DescribeInstances requires * — no resource-level restriction exists for Describe APIs.
        // eks:UpdateNodegroupConfig/DescribeNodegroup require nodegroup/*/*  (wildcard over ng-name + uuid).
        NagSuppressions.addResourceSuppressions(lambdaRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'ec2:DescribeInstances has no resource-level restriction in IAM. ' +
                        'ec2:TerminateInstances is tag-conditioned to any eks-cluster-pool value (Karpenter nodes only). ' +
                        'eks nodegroup actions scoped to nodegroup/<cluster>/*/* (uuid not known at synth time). ' +
                        'eks:ListNodegroups and eks:DescribeCluster are scoped to the cluster ARN.',
                appliesTo: [
                    'Resource::*',
                    { regex: String.raw`/^Resource::.*:nodegroup\/.*\/\*\/\*/` },
                ],
            },
        ], true);

        // ScaleUpFn patches karpenter/karpenter and argocd/* via the K8s API.
        // ScaleDownFn does the same in reverse before draining the MNG.
        // ESO is NOT patched: its Deployment retains replicas=1 from Helm and
        // ArgoCD reconciles it automatically once ArgoCD itself is restored.
        // Construct ID matches the deployed CloudFormation logical ID
        // (SchedulerLambdaAccessEntry5BC0BF2A) — do not rename.
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

        // NODEGROUP_NAME is intentionally NOT passed: the MNG nodegroup name
        // changes on every instance-type replacement, and any env/SSM value
        // is baked at deploy time → goes stale the moment the MNG is
        // replaced. Both Lambdas discover it at runtime via eks:ListNodegroups
        // (IAM already scoped to the cluster ARN below).
        const commonEnv: Record<string, string> = {
            CLUSTER_NAME: cluster.clusterName,
        };
        if (props.wafIpSyncFunctionName) {
            commonEnv['WAF_IP_SYNC_FUNCTION'] = props.wafIpSyncFunctionName;
        }

        const scaleUpFn = new lambda.Function(this, 'ScaleUpFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(1),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, os, logging, ssl, json, base64, tempfile, urllib.request
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest

log = logging.getLogger()
log.setLevel(logging.INFO)

ARGOCD_DEPLOYMENTS = [
    'argocd-applicationset-controller',
    'argocd-dex-server',
    'argocd-image-updater',
    'argocd-notifications-controller',
    'argocd-redis',
    'argocd-repo-server',
    'argocd-server',
]

def _bearer_token(cluster_name, region):
    # EKS expects a *presigned* STS GetCallerIdentity URL — the signature
    # must be in the query string (SigV4QueryAuth), NOT an Authorization
    # header (SigV4Auth). With header signing req.url has no signature, so
    # the API server's STS verification returns HTTP 401.
    session = boto3.session.Session()
    creds = session.get_credentials().get_frozen_credentials()
    url = f'https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15'
    req = AWSRequest(method='GET', url=url, headers={'x-k8s-aws-id': cluster_name})
    SigV4QueryAuth(creds, 'sts', region, expires=60).add_auth(req)
    return 'k8s-aws-v1.' + base64.urlsafe_b64encode(
        req.url.encode('utf-8')).decode('utf-8').rstrip('=')

def _patch_replicas(endpoint, ca_data, token, namespace, deployment, replicas):
    ca_bytes = base64.b64decode(ca_data)
    with tempfile.NamedTemporaryFile(delete=False, suffix='.crt') as f:
        f.write(ca_bytes)
        ca_file = f.name
    try:
        url = f'{endpoint}/apis/apps/v1/namespaces/{namespace}/deployments/{deployment}/scale'
        body = json.dumps({'spec': {'replicas': replicas}}).encode()
        req = urllib.request.Request(url, data=body, method='PATCH')
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Content-Type', 'application/merge-patch+json')
        ctx = ssl.create_default_context(cafile=ca_file)
        with urllib.request.urlopen(req, context=ctx) as resp:
            log.info('Patched %s/%s to %d replicas (HTTP %s)', namespace, deployment, replicas, resp.status)
    finally:
        import os as _os; _os.unlink(ca_file)

def _system_nodegroup(eks_client, cluster_name):
    # Resolve the system MNG name at runtime. It changes on every
    # instance-type replacement, so a deploy-time-baked value goes stale.
    names = eks_client.list_nodegroups(clusterName=cluster_name)['nodegroups']
    if not names:
        raise RuntimeError('no nodegroups for cluster ' + cluster_name)
    for n in names:
        if n.startswith('SystemMng'):
            return n
    return names[0]

def handler(event, context):
    region = os.environ['AWS_REGION']
    cluster_name = os.environ['CLUSTER_NAME']

    eks_client = boto3.client('eks', region_name=region)
    eks_client.update_nodegroup_config(
        clusterName=cluster_name,
        nodegroupName=_system_nodegroup(eks_client, cluster_name),
        scalingConfig={'minSize': 1, 'desiredSize': 1},
    )
    log.info('Scaled MNG to 1')

    cluster_info = eks_client.describe_cluster(name=cluster_name)['cluster']
    endpoint = cluster_info['endpoint']
    ca_data = cluster_info['certificateAuthority']['data']
    token = _bearer_token(cluster_name, region)

    # 1 replica: dev cluster is down ~17h/day and the t3.medium landing
    # zone has no room for a 2nd anti-affinity replica. Karpenter's 2nd pod
    # is only a leader-election standby — single replica is fully functional.
    _patch_replicas(endpoint, ca_data, token, 'karpenter', 'karpenter', 1)

    def _ensure_argocd_secret():
        # argocd-secret is Helm-managed with helm.sh/resource-policy:keep.
        # helm upgrade (not fresh install) skips recreating deleted
        # keep-annotated resources — argocd-server and argocd-dex-server
        # CrashLoopBackOff on restore without it.
        ca_bytes = base64.b64decode(ca_data)
        with tempfile.NamedTemporaryFile(delete=False, suffix='.crt') as f:
            f.write(ca_bytes)
            ca_file = f.name
        try:
            ctx = ssl.create_default_context(cafile=ca_file)
            url = f'{endpoint}/api/v1/namespaces/argocd/secrets/argocd-secret'
            try:
                with urllib.request.urlopen(
                    urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'}),
                    context=ctx,
                ):
                    log.info('argocd-secret present')
                    return
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
            log.info('argocd-secret missing — creating with random secretkey')
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
        finally:
            import os as _os; _os.unlink(ca_file)

    # helm upgrade skips keep-annotated resources when the release already
    # exists, leaving argocd-server/dex in CrashLoopBackOff on restore.
    _ensure_argocd_secret()

    for deploy in ARGOCD_DEPLOYMENTS:
        _patch_replicas(endpoint, ca_data, token, 'argocd', deploy, 1)

    waf_fn = os.environ.get('WAF_IP_SYNC_FUNCTION')
    if waf_fn:
        lam = boto3.client('lambda', region_name=region)
        lam.invoke(FunctionName=waf_fn, InvocationType='Event')
        log.info('Triggered WAF IP sync: %s', waf_fn)

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
import boto3, os, logging, ssl, json, base64, tempfile, urllib.request
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest

log = logging.getLogger()
log.setLevel(logging.INFO)

ARGOCD_DEPLOYMENTS = [
    'argocd-applicationset-controller',
    'argocd-dex-server',
    'argocd-image-updater',
    'argocd-notifications-controller',
    'argocd-redis',
    'argocd-repo-server',
    'argocd-server',
]

def _bearer_token(cluster_name, region):
    # EKS expects a *presigned* STS GetCallerIdentity URL — the signature
    # must be in the query string (SigV4QueryAuth), NOT an Authorization
    # header (SigV4Auth). With header signing req.url has no signature, so
    # the API server's STS verification returns HTTP 401.
    session = boto3.session.Session()
    creds = session.get_credentials().get_frozen_credentials()
    url = f'https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15'
    req = AWSRequest(method='GET', url=url, headers={'x-k8s-aws-id': cluster_name})
    SigV4QueryAuth(creds, 'sts', region, expires=60).add_auth(req)
    return 'k8s-aws-v1.' + base64.urlsafe_b64encode(
        req.url.encode('utf-8')).decode('utf-8').rstrip('=')

def _patch_replicas(endpoint, ca_data, token, namespace, deployment, replicas):
    ca_bytes = base64.b64decode(ca_data)
    with tempfile.NamedTemporaryFile(delete=False, suffix='.crt') as f:
        f.write(ca_bytes)
        ca_file = f.name
    try:
        url = f'{endpoint}/apis/apps/v1/namespaces/{namespace}/deployments/{deployment}/scale'
        body = json.dumps({'spec': {'replicas': replicas}}).encode()
        req = urllib.request.Request(url, data=body, method='PATCH')
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Content-Type', 'application/merge-patch+json')
        ctx = ssl.create_default_context(cafile=ca_file)
        with urllib.request.urlopen(req, context=ctx) as resp:
            log.info('Patched %s/%s to %d replicas (HTTP %s)', namespace, deployment, replicas, resp.status)
    finally:
        import os as _os; _os.unlink(ca_file)

def _system_nodegroup(eks_client, cluster_name):
    # Resolve the system MNG name at runtime. It changes on every
    # instance-type replacement, so a deploy-time-baked value goes stale.
    names = eks_client.list_nodegroups(clusterName=cluster_name)['nodegroups']
    if not names:
        raise RuntimeError('no nodegroups for cluster ' + cluster_name)
    for n in names:
        if n.startswith('SystemMng'):
            return n
    return names[0]

def handler(event, context):
    region = os.environ['AWS_REGION']
    cluster_name = os.environ['CLUSTER_NAME']

    eks_client = boto3.client('eks', region_name=region)
    cluster_info = eks_client.describe_cluster(name=cluster_name)['cluster']
    endpoint = cluster_info['endpoint']
    ca_data = cluster_info['certificateAuthority']['data']
    token = _bearer_token(cluster_name, region)

    # ESO is deliberately NOT patched here: the Lambda's EKS AccessEntry is
    # scoped to karpenter + argocd only (least privilege; enforced by test).
    # ESO pods terminate with their nodes seconds later anyway, and ArgoCD
    # reconciles ESO back on the next start — so explicit scale-down would
    # only save a few seconds of Secrets Manager polling at the cost of
    # widening the Lambda's cluster RBAC. Not worth it.
    _patch_replicas(endpoint, ca_data, token, 'karpenter', 'karpenter', 0)

    for deploy in ARGOCD_DEPLOYMENTS:
        _patch_replicas(endpoint, ca_data, token, 'argocd', deploy, 0)

    log.info('Pre-shutdown K8s scale-down complete')

    # Terminate Karpenter EC2s across EVERY pool. Filter on the tag KEY
    # eks-cluster-pool (set by every EC2NodeClass: workloads-default,
    # system, any future pool) — a per-value filter misses the system
    # spot node and leaks cost. Karpenter is already at 0 replicas so it
    # cannot re-provision; orphaned NodeClaims are GC'd on next start.
    ec2 = boto3.client('ec2', region_name=region)
    resp = ec2.describe_instances(
        Filters=[
            {'Name': 'tag-key', 'Values': ['eks-cluster-pool']},
            {'Name': 'instance-state-name', 'Values': ['running', 'pending']},
        ]
    )
    ids = [i['InstanceId'] for r in resp['Reservations'] for i in r['Instances']]
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        log.info('Terminated Karpenter EC2s (all pools): %s', ids)
    else:
        log.info('No Karpenter EC2s to terminate')

    eks_client.update_nodegroup_config(
        clusterName=cluster_name,
        nodegroupName=_system_nodegroup(eks_client, cluster_name),
        scalingConfig={'minSize': 0, 'desiredSize': 0},
    )
    log.info('Scaled MNG to 0')
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

        // DISABLED: the live production app currently runs on the development
        // account, so the nightly cluster stop/start would take prod offline
        // 23:00-04:00 Europe/Dublin. Both schedules stay provisioned (Lambdas,
        // IAM, EventBridge) but do not fire. To re-arm the cost-saver once prod
        // moves to its own account, set state back to 'ENABLED' and redeploy.
        new scheduler.CfnSchedule(this, 'ScaleUpSchedule', {
            scheduleExpression: 'cron(0 4 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            state: 'DISABLED',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleUpFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });

        new scheduler.CfnSchedule(this, 'ScaleDownSchedule', {
            scheduleExpression: 'cron(0 23 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            state: 'DISABLED',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleDownFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });
    }
}
