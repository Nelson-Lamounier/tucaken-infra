/**
 * @format
 * EKS Public WAF Stack — REGIONAL WebACL for the shared ALB.
 *
 * Provisions the host-scoped WAF defined in `EksPublicWafConstruct` and
 * publishes its ARN to SSM at `${ssmPrefix}/eks/waf-acl-arn`. Workload
 * Ingresses set `alb.ingress.kubernetes.io/wafv2-acl-arn: <arn>` to
 * attach the WebACL to the shared ALB. Plan 5b § 0.4.
 *
 * Allowlist CIDRs come from the operator at deploy time (synth-time
 * SSM lookup of two existing String parameters that already store the
 * operator's home IP — `/k8s/${env}/monitoring/allow-ipv4` and
 * `/k8s/${env}/monitoring/allow-ipv6` — historically used by the
 * kubeadm monitoring IngressRoute middleware. Same value, same purpose,
 * different consumer. Adding / removing IPs is a one-line SSM update
 * + redeploy of THIS stack only.
 *
 * Lives in eu-west-1 because REGIONAL WebACLs must share a region with
 * the ALB they attach to.
 */
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { EksPublicWafConstruct } from '../../constructs/security/eks-public-waf';

export interface EksPublicWafStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    /**
     * SSM String path holding the comma-separated IPv4 allowlist CIDRs
     * (e.g. `203.0.113.42/32`). Empty/missing → IPv4 allowlist disabled.
     * Maintain manually; ESO sync is out of scope for V1.
     */
    readonly allowlistIpv4SsmPath: string;
    /**
     * Optional SSM String path holding the comma-separated IPv6
     * allowlist CIDRs. Omit when no IPv6 entry is needed.
     */
    readonly allowlistIpv6SsmPath?: string;
    /** Hosts gated by the IP allowlist (e.g. admin.* and ops.*). */
    readonly allowlistedHosts: readonly string[];
    /** Hosts to rate limit (e.g. api.*). */
    readonly rateLimitedHosts: readonly string[];
    readonly rateLimitPerIp?: number;
    readonly ssmPrefix: string;
    readonly namePrefix?: string;
    /**
     * EKS cluster name. When provided, creates an IAM role + Pod Identity
     * association for the `waf-annotator` Service Account in the
     * `tucaken-app` namespace. The PostSync Job uses this role to read the
     * WAF ACL ARN from SSM and annotate the Ingress — keeping the
     * wafv2-acl-arn annotation current without hardcoding the ARN in git.
     */
    readonly clusterName?: string;
}

export class EksPublicWafStack extends cdk.Stack {
    public readonly webAclArn: string;
    /** IAM role ARN for the waf-annotator PostSync Job (set when clusterName is provided) */
    public readonly wafAnnotatorRoleArn?: string;

    constructor(scope: Construct, id: string, props: EksPublicWafStackProps) {
        super(scope, id, props);

        const namePrefix = props.namePrefix ?? 'eks-public';
        const envName = props.targetEnvironment;

        // Synth-time SSM lookups. Each parameter holds a comma-separated
        // CIDR list; an unset parameter (or CDK's first-synth
        // `dummy-value-for-` placeholder) is treated as empty.
        const splitCidrs = (raw: string | undefined): string[] =>
            raw && !raw.startsWith('dummy-value-for-')
                ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                : [];

        const allowlistedIpv4 = splitCidrs(
            ssm.StringParameter.valueFromLookup(this, props.allowlistIpv4SsmPath),
        );
        const allowlistedIpv6 = props.allowlistIpv6SsmPath
            ? splitCidrs(ssm.StringParameter.valueFromLookup(this, props.allowlistIpv6SsmPath))
            : [];

        const waf = new EksPublicWafConstruct(this, 'PublicWaf', {
            envName,
            namePrefix,
            allowlistedIpv4,
            allowlistedIpv6,
            allowlistedHosts: props.allowlistedHosts,
            rateLimitedHosts: props.rateLimitedHosts,
            rateLimitPerIp: props.rateLimitPerIp,
        });

        this.webAclArn = waf.webAclArn;

        new ssm.StringParameter(this, 'WebAclArnSsm', {
            parameterName: `${props.ssmPrefix}/eks/waf-acl-arn`,
            stringValue: this.webAclArn,
            description: 'REGIONAL WAFv2 WebACL ARN attached to the shared EKS ALB',
        });

        // =================================================================
        // IP SYNC LAMBDA
        // Reads IPv4/IPv6 CIDRs from SSM and updates both WAF IP sets.
        // Triggered by EventBridge whenever either SSM parameter changes —
        // update SSM once, WAF is updated within seconds, no CDK redeploy.
        // =================================================================
        if (waf.ipv4Set || waf.ipv6Set) {
            const syncFn = new lambda.Function(this, 'IpSyncFn', {
                functionName: `${namePrefix}-ip-sync-${envName}`,
                runtime: lambda.Runtime.PYTHON_3_12,
                handler: 'index.handler',
                timeout: cdk.Duration.seconds(30),
                code: lambda.Code.fromInline(`
import boto3, os, logging
log = logging.getLogger()
log.setLevel(logging.INFO)

def handler(event, context):
    region = os.environ['AWS_REGION']
    ssm  = boto3.client('ssm',   region_name=region)
    waf  = boto3.client('wafv2', region_name=region)

    def get_cidrs(path):
        if not path:
            return []
        try:
            val = ssm.get_parameter(Name=path)['Parameter']['Value'].strip()
            return [c.strip() for c in val.split(',') if c.strip()]
        except ssm.exceptions.ParameterNotFound:
            log.warning('SSM param not found: %s', path)
            return []

    def sync(set_id, set_name, cidrs):
        if not set_id or not cidrs:
            return
        resp  = waf.get_ip_set(Name=set_name, Scope='REGIONAL', Id=set_id)
        token = resp['LockToken']
        waf.update_ip_set(Name=set_name, Scope='REGIONAL', Id=set_id,
                          Addresses=cidrs, LockToken=token)
        log.info('Updated %s: %s', set_name, cidrs)

    sync(os.environ.get('IPV4_SET_ID'), os.environ.get('IPV4_SET_NAME'),
         get_cidrs(os.environ.get('IPV4_SSM_PATH')))
    sync(os.environ.get('IPV6_SET_ID'), os.environ.get('IPV6_SET_NAME'),
         get_cidrs(os.environ.get('IPV6_SSM_PATH')))
`),
                environment: {
                    IPV4_SSM_PATH:  props.allowlistIpv4SsmPath,
                    IPV6_SSM_PATH:  props.allowlistIpv6SsmPath ?? '',
                    IPV4_SET_ID:    waf.ipv4Set?.attrId   ?? '',
                    IPV4_SET_NAME:  waf.ipv4Set?.name     ?? '',
                    IPV6_SET_ID:    waf.ipv6Set?.attrId   ?? '',
                    IPV6_SET_NAME:  waf.ipv6Set?.name     ?? '',
                },
            });

            syncFn.addToRolePolicy(new iam.PolicyStatement({
                actions: [
                    'ssm:GetParameter',
                    'wafv2:GetIPSet',
                    'wafv2:UpdateIPSet',
                ],
                resources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter${props.allowlistIpv4SsmPath}`,
                    ...(props.allowlistIpv6SsmPath
                        ? [`arn:aws:ssm:${this.region}:${this.account}:parameter${props.allowlistIpv6SsmPath}`]
                        : []),
                    ...(waf.ipv4Set ? [waf.ipv4Set.attrArn] : []),
                    ...(waf.ipv6Set ? [waf.ipv6Set.attrArn] : []),
                ],
            }));

            // Fire when either allowlist SSM parameter is updated.
            // SSM Parameter Store emits "Parameter Store Change" events
            // natively to EventBridge — no CloudTrail required.
            const paramNames = [
                props.allowlistIpv4SsmPath,
                ...(props.allowlistIpv6SsmPath ? [props.allowlistIpv6SsmPath] : []),
            ];
            new events.Rule(this, 'IpSyncRule', {
                ruleName: `${namePrefix}-ip-sync-${envName}`,
                description: 'Trigger WAF IP set sync when allowlist SSM params change',
                eventPattern: {
                    source: ['aws.ssm'],
                    detailType: ['Parameter Store Change'],
                    detail: {
                        name: paramNames,
                        operation: ['Update', 'Create'],
                    },
                },
                targets: [new targets.LambdaFunction(syncFn)],
            });
        }

        // =================================================================
        // WAF ANNOTATOR IAM ROLE (Pod Identity)
        // Grants the waf-annotator PostSync Job permission to read the WAF
        // ACL ARN from SSM. The Job annotates the tucaken-app Ingress at
        // sync time so the ARN is never hardcoded in git.
        // =================================================================
        if (props.clusterName) {
            const annotatorRole = new iam.Role(this, 'WafAnnotatorRole', {
                roleName: `${namePrefix}-waf-annotator-${envName}`,
                description: 'Allows waf-annotator PostSync Job to read WAF ACL ARN from SSM',
                assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com'),
            });

            annotatorRole.addToPolicy(new iam.PolicyStatement({
                sid: 'ReadWafAclArn',
                actions: ['ssm:GetParameter'],
                resources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/eks/waf-acl-arn`,
                ],
            }));

            // Pod Identity association: tucaken-app/waf-annotator → role
            new (require('aws-cdk-lib/aws-eks').CfnPodIdentityAssociation)(this, 'WafAnnotatorPodIdentity', {
                clusterName: props.clusterName,
                namespace: 'tucaken-app',
                serviceAccount: 'waf-annotator',
                roleArn: annotatorRole.roleArn,
            });

            this.wafAnnotatorRoleArn = annotatorRole.roleArn;

            new ssm.StringParameter(this, 'WafAnnotatorRoleArnSsm', {
                parameterName: `${props.ssmPrefix}/eks/waf-annotator-role-arn`,
                stringValue: annotatorRole.roleArn,
                description: 'IAM role ARN for the tucaken-app waf-annotator PostSync Job',
            });
        }
    }
}
