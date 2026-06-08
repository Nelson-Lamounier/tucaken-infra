/**
 * @format
 * Kubernetes Base Stack — Long-Lived Infrastructure
 *
 * Contains the rarely-changing "base" infrastructure for the Kubernetes
 * cluster. Decoupled from the compute/runtime layer so that changes to
 * AMIs, manifests, boot scripts, or SSM documents do NOT trigger a
 * CloudFormation update on these resources.
 *
 * Resources Created:
 *   - VPC Lookup (Shared VPC from deploy-shared workflow)
 *   - Security Groups ×4 (config-driven via SecurityGroupConstruct):
 *       • Cluster Base — intra-cluster communication (etcd, kubelet, VXLAN, etc.)
 *       • Control Plane — K8s API server access from VPC
 *       • Ingress — Traefik HTTP/HTTPS (CloudFront prefix list + admin IPs from SSM)
 *       • Monitoring — Prometheus, Node Exporter, Loki, Tempo
 *   - KMS Key (CloudWatch log group encryption, auto-rotation enabled)
 *   - Elastic IP (shared by Next.js CloudFront and SSM access)
 *   - Route 53 Private Hosted Zone (k8s.internal — stable API server DNS)
 *   - S3 Bucket (k8s scripts & manifests — synced by CI pipeline)
 *   - SSM Parameters ×12 (cross-stack discovery via SsmParameterStoreConstruct)
 *
 * Lifecycle: Only re-deployed when hardware specs, networking rules,
 * or storage configuration changes. Typically stable for weeks/months.
 *
 * @example
 * ```typescript
 * const baseStack = new KubernetesBaseStack(app, 'K8s-Base-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     configs: getK8sConfigs(Environment.DEVELOPMENT),
 *     namePrefix: 'k8s-development',
 *     ssmPrefix: '/k8s/development',
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';


import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import {
    K8sConfigs,
    TRAEFIK_HTTP_PORT,
    TRAEFIK_HTTPS_PORT,
} from '../../config/kubernetes';
import { k8sSsmPaths } from '../../config/ssm-paths';
import { SecurityGroupConstruct, SsmParameterStoreConstruct } from '../../constructs';
import { S3BucketConstruct } from '../../constructs/storage';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesBaseStack.
 *
 * Minimal configuration for the long-lived infrastructure layer.
 * Does NOT include any application-tier or runtime configuration.
 */
export interface KubernetesBaseStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration (resolved from config layer) */
    readonly configs: K8sConfigs;

    /** Name prefix for resources @default 'k8s' */
    readonly namePrefix?: string;

    /** SSM parameter prefix for storing cluster info */
    readonly ssmPrefix: string;

    /**
     * VPC Name tag for synth-time lookup via Vpc.fromLookup().
     * @default 'shared-vpc-{environment}'
     */
    readonly vpcName?: string;
}

// =============================================================================
// STACK
// =============================================================================

/** Internal domain name for the private hosted zone. */
const K8S_INTERNAL_DOMAIN = 'k8s.internal';

/** DNS name for the Kubernetes API server (stable endpoint). */
const K8S_API_DNS_NAME = `k8s-api.${K8S_INTERNAL_DOMAIN}`;

/**
 * Kubernetes Base Stack — Long-Lived Infrastructure.
 *
 * Provisions VPC lookup, 4 config-driven Security Groups, KMS Key,
 * EBS Volume, DLM snapshot policy, Elastic IP, Route 53 private hosted
 * zone (k8s.internal), S3 scripts bucket, and 12 SSM parameters for
 * cross-stack discovery. These resources rarely change and are decoupled
 * from the runtime compute stack.
 *
 * Security Groups are created via a data-driven loop using
 * {@link SecurityGroupConstruct.fromK8sRules}. Runtime-dependent rules
 * (CloudFront prefix list, admin IPs from SSM) are added imperatively
 * after the loop.
 */
export class KubernetesBaseStack extends cdk.Stack {
    /** The looked-up VPC */
    public readonly vpc: ec2.IVpc;

    /**
     * Base security group — intra-cluster communication (all nodes).
     * Explicit port rules for kubeadm: etcd, kubelet, VXLAN, Calico BGP, NodePorts.
     * Backward-compatible: this was previously the single shared SG.
     */
    public readonly securityGroup: ec2.SecurityGroup;

    /** Control plane SG — K8s API server access from VPC (SSM port-forwarding) */
    public readonly controlPlaneSg: ec2.SecurityGroup;

    /** Ingress SG — Traefik HTTP/HTTPS from anywhere (CloudFront + ops) */
    public readonly ingressSg: ec2.SecurityGroup;

    /** Monitoring SG — Prometheus, Node Exporter, Loki, Tempo from VPC */
    public readonly monitoringSg: ec2.SecurityGroup;

    /** KMS key for CloudWatch log group encryption */
    public readonly logGroupKmsKey: kms.Key;

    /** SSM Parameter Store for cluster resources */
    public readonly ssmParams: SsmParameterStoreConstruct;


    /** S3 bucket for k8s scripts and manifests */
    public readonly scriptsBucket: s3.IBucket;

    /** Route 53 private hosted zone for internal DNS discovery */
    public readonly hostedZone: route53.PrivateHostedZone;

    /** DNS name for the Kubernetes API server (stable endpoint) */
    public readonly apiDnsName: string;

    /** Elastic IP for stable external access */
    public readonly elasticIp: ec2.CfnEIP;

    constructor(scope: Construct, id: string, props: KubernetesBaseStackProps) {
        super(scope, id, props);

        const { configs, targetEnvironment } = props;
        const namePrefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // VPC Lookup
        // =====================================================================
        const vpcName = props.vpcName ?? `shared-vpc-${targetEnvironment}`;
        this.vpc = ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName });

        // EKS subnet discovery tags live in SharedVpcStack — see vpc-stack.ts.
        // Tagging on imported subnets here would be a no-op because cdk.Tags
        // does not propagate to ec2.Vpc.fromLookup() resources.

        // =====================================================================
        // Security Groups (config-driven via SecurityGroupConstruct)
        //
        // 3 SGs use the config layer's K8sSecurityGroupConfig, converted to
        // generic SecurityGroupRules via fromK8sRules(). The 4th (Ingress SG)
        // is created directly because its rules depend on runtime values.
        // =====================================================================
        const sgConfig = configs.securityGroups;
        const podCidr = configs.cluster.podNetworkCidr;

        // Config-driven SG definitions: key → { sgName suffix, description, config }
        const sgDefinitions = [
            { key: 'clusterBase',   id: 'ClusterBaseSg',   name: 'k8s-cluster',       desc: 'Shared Kubernetes cluster',       config: sgConfig.clusterBase },
            { key: 'controlPlane',  id: 'ControlPlaneSg',  name: 'k8s-control-plane', desc: 'K8s control plane - API server',   config: sgConfig.controlPlane },
            { key: 'ingress',       id: 'IngressSg',       name: 'k8s-ingress',       desc: 'K8s ingress - Traefik HTTP/HTTPS', config: sgConfig.ingress },
            { key: 'monitoring',    id: 'MonitoringSg',    name: 'k8s-monitoring',    desc: 'K8s monitoring - Prometheus/Loki', config: sgConfig.monitoring },
        ] as const;

        const sgMap = new Map<string, ec2.SecurityGroup>();

        for (const sg of sgDefinitions) {
            const construct = new SecurityGroupConstruct(this, sg.id, {
                vpc: this.vpc,
                securityGroupName: `${namePrefix}-${sg.name}`,
                description: `${sg.desc} (${targetEnvironment})`,
                allowAllOutbound: sg.config.allowAllOutbound,
                rules: SecurityGroupConstruct.fromK8sRules(sg.config.rules, this.vpc, podCidr),
            });
            sgMap.set(sg.key, construct.securityGroup);
        }

        this.securityGroup = sgMap.get('clusterBase')!;
        this.controlPlaneSg = sgMap.get('controlPlane')!;
        this.ingressSg = sgMap.get('ingress')!;
        this.monitoringSg = sgMap.get('monitoring')!;

        // -----------------------------------------------------------------
        // Ingress SG: runtime-dependent rules (not expressible in config)
        // -----------------------------------------------------------------

        // CloudFront origin-facing IPs (managed prefix list lookup)
        const cfPrefixListLookup = new cr.AwsCustomResource(
            this,
            'CloudFrontPrefixListLookup',
            {
                onCreate: {
                    service: '@aws-sdk/client-ec2',
                    action: 'DescribeManagedPrefixLists',
                    parameters: {
                        Filters: [{
                            Name: 'prefix-list-name',
                            Values: ['com.amazonaws.global.cloudfront.origin-facing'],
                        }],
                    },
                    physicalResourceId:
                        cr.PhysicalResourceId.of('cf-prefix-list-lookup'),
                },
                policy: cr.AwsCustomResourcePolicy.fromStatements([
                    new iam.PolicyStatement({
                        actions: ['ec2:DescribeManagedPrefixLists'],
                        resources: ['*'],
                    }),
                ]),
            },
        );
        const cfPrefixListId = cfPrefixListLookup.getResponseField(
            'PrefixLists.0.PrefixListId',
        );

        NagSuppressions.addResourceSuppressionsByPath(this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [{
                id: 'AwsSolutions-L1',
                reason: 'AwsCustomResource singleton Lambda runtime is managed by CDK - deploy-time only, reads prefix list ID',
            }],
        );
        NagSuppressions.addResourceSuppressions(cfPrefixListLookup, [{
            id: 'AwsSolutions-IAM5',
            reason: 'ec2:DescribeManagedPrefixLists requires wildcard resource - read-only API call',
        }], true);

        this.ingressSg.addIngressRule(
            ec2.Peer.prefixList(cfPrefixListId),
            ec2.Port.tcp(TRAEFIK_HTTP_PORT),
            'HTTP from CloudFront origin-facing IPs',
        );

        // Admin IPs → Traefik HTTPS (sourced from CDK context -c adminAllowedIps=...)
        // CI synth-validate passes a dummy; real deploys resolve from SSM before synth.
        const adminIpsRaw = this.node.tryGetContext('adminAllowedIps') as string | undefined;

        if (adminIpsRaw && adminIpsRaw !== 'NONE') {
            const adminIps = adminIpsRaw.split(',').map((ip) => ip.trim()).filter(Boolean);

            /**
             * Sanitise SG rule description to only contain characters from the
             * AWS-allowed set and stay under the 256-character limit.
             *
             * Allowed: a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*
             * @see https://docs.aws.amazon.com/ec2/latest/APIReference/API_IpPermission.html
             */
            const sanitiseDesc = (raw: string): string =>
                raw.replaceAll(/[^a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]/g, '-').slice(0, 255);

            for (const ip of adminIps) {
                const isIpv6 = ip.includes(':');
                const peer = isIpv6 ? ec2.Peer.ipv6(ip) : ec2.Peer.ipv4(ip);
                const label = isIpv6 ? 'IPv6' : 'IPv4';

                this.ingressSg.addIngressRule(
                    peer,
                    ec2.Port.tcp(TRAEFIK_HTTPS_PORT),
                    sanitiseDesc(`HTTPS from admin ${label} (${ip})`),
                );
            }
        }

        // =====================================================================
        // KMS Key for CloudWatch Log Group Encryption
        // =====================================================================
        this.logGroupKmsKey = new kms.Key(this, 'LogGroupKey', {
            alias: `${namePrefix}-log-group`,
            description: `KMS key for ${namePrefix} CloudWatch log group encryption`,
            enableKeyRotation: true,
            removalPolicy: configs.removalPolicy,
        });

        this.logGroupKmsKey.addToResourcePolicy(new iam.PolicyStatement({
            actions: [
                'kms:Encrypt*',
                'kms:Decrypt*',
                'kms:ReEncrypt*',
                'kms:GenerateDataKey*',
                'kms:Describe*',
            ],
            principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
            resources: ['*'],
            conditions: {
                ArnLike: {
                    'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
                },
            },
        }));


        // =====================================================================
        // Elastic IP (shared endpoint for Next.js CloudFront + SSM access)
        // =====================================================================
        this.elasticIp = new ec2.CfnEIP(this, 'K8sElasticIp', {
            domain: 'vpc',
            tags: [{
                key: 'Name',
                value: `${namePrefix}-k8s-eip`,
            }],
        });

        // =====================================================================
        // Route 53 Private Hosted Zone (stable API server DNS)
        //
        // Provides a DNS-based control plane endpoint so that workers
        // referencing k8s-api.k8s.internal survive control plane
        // re-provisioning without manual kubelet reconfiguration.
        // The control plane updates the A record at boot via IMDS.
        // =====================================================================
        this.hostedZone = new route53.PrivateHostedZone(this, 'K8sInternalZone', {
            zoneName: K8S_INTERNAL_DOMAIN,
            vpc: this.vpc,
            comment: `Internal DNS for ${namePrefix} Kubernetes API server discovery`,
        });
        this.apiDnsName = K8S_API_DNS_NAME;

        // Placeholder A record — seeded at Day-0 by CDK, then updated by the
        // control plane at boot via `aws route53 change-resource-record-sets`.
        //
        // IMPORTANT: The control plane is the authoritative owner of this record.
        // CDK only seeds it so Route53 has a valid entry before the first boot.
        // The IP here must match the current live value to avoid CF drift conflicts
        // (CF deletes the old value before creating the new one; if values differ,
        // the delete fails with "values provided do not match").
        //
        // Current control-plane private IP: 10.0.0.33 (updated after initial boot).
        // Update this value if the control plane instance is replaced.
        const cfnApiRecord = new route53.CfnRecordSet(this, 'K8sApiRecord', {
            hostedZoneId: this.hostedZone.hostedZoneId,
            name: `${K8S_API_DNS_NAME}.`,
            type: 'A',
            ttl: '30',
            resourceRecords: ['10.0.0.33'],
            comment: 'Kubernetes API server - owned by control plane, seeded by CDK',
        });
        // Suppress CDK's default DeletionPolicy of Delete on this record —
        // the control plane manages the actual value; CDK must not delete it.
        cfnApiRecord.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

        // =====================================================================
        // S3 Access Logs Bucket (AwsSolutions-S1)
        // =====================================================================
        const accessLogsBucketConstruct = new S3BucketConstruct(this, 'K8sScriptsAccessLogsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: `${namePrefix}-k8s-scripts-logs-${this.account}-${this.region}`,
                purpose: 'k8s-scripts-access-logs',
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: configs.removalPolicy,
                autoDeleteObjects: !configs.isProduction,
                lifecycleRules: [{
                    expiration: cdk.Duration.days(90),
                }],
            },
        });

        NagSuppressions.addResourceSuppressions(accessLogsBucketConstruct.bucket, [{
            id: 'AwsSolutions-S1',
            reason: 'Access logs bucket cannot log to itself - this is the terminal logging destination',
        }]);

        // =====================================================================
        // S3 Bucket for K8s Scripts & Manifests
        //
        // Lives in the base stack (not compute) for three reasons:
        //   1. Day-1 safety — CI sync uploads bootstrap scripts BEFORE the
        //      compute stack launches EC2 instances. Avoids chicken-and-egg.
        //   2. CI independence — script updates don't trigger ASG changes.
        //   3. Shared resource — both control plane and worker nodes read
        //      from this bucket at boot time.
        // =====================================================================
        const scriptsBucketConstruct = new S3BucketConstruct(this, 'K8sScriptsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: `${namePrefix}-k8s-scripts-${this.account}`,
                purpose: 'k8s-scripts-and-manifests',
                versioned: configs.isProduction,
                removalPolicy: configs.removalPolicy,
                autoDeleteObjects: !configs.isProduction,
                accessLogsBucket: accessLogsBucketConstruct.bucket,
                accessLogsPrefix: 'k8s-scripts-bucket/',
            },
        });
        this.scriptsBucket = scriptsBucketConstruct.bucket;

        // =====================================================================
        // SSM Parameters (centralized paths from ssm-paths.ts)
        // =====================================================================
        const ssmPaths = k8sSsmPaths(targetEnvironment);

        this.ssmParams = new SsmParameterStoreConstruct(this, 'SsmParams', {
            parameters: {
                [ssmPaths.vpcId]: this.vpc.vpcId,
                [ssmPaths.elasticIp]: this.elasticIp.ref,
                [ssmPaths.elasticIpAllocationId]: this.elasticIp.attrAllocationId,
                [ssmPaths.securityGroupId]: this.securityGroup.securityGroupId,
                [ssmPaths.controlPlaneSgId]: this.controlPlaneSg.securityGroupId,
                [ssmPaths.ingressSgId]: this.ingressSg.securityGroupId,
                [ssmPaths.monitoringSgId]: this.monitoringSg.securityGroupId,

                [ssmPaths.scriptsBucket]: this.scriptsBucket.bucketName,
                [ssmPaths.hostedZoneId]: this.hostedZone.hostedZoneId,
                [ssmPaths.apiDnsName]: K8S_API_DNS_NAME,
                [ssmPaths.kmsKeyArn]: this.logGroupKmsKey.keyArn,
            },
        });

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        const outputs: { id: string; value: string; description: string }[] = [
            { id: 'VpcId',                value: this.vpc.vpcId,                      description: 'Shared VPC ID' },
            { id: 'SecurityGroupId',      value: this.securityGroup.securityGroupId,   description: 'Kubernetes cluster security group ID' },
            { id: 'ElasticIpAddress',     value: this.elasticIp.ref,                   description: 'Kubernetes cluster Elastic IP address' },
            { id: 'ElasticIpAllocationId', value: this.elasticIp.attrAllocationId,     description: 'Kubernetes cluster Elastic IP allocation ID' },

            { id: 'HostedZoneId',         value: this.hostedZone.hostedZoneId,         description: 'Route 53 private hosted zone ID (k8s.internal)' },
            { id: 'ApiDnsName',           value: K8S_API_DNS_NAME,                     description: 'Stable DNS name for the Kubernetes API server' },
            { id: 'LogGroupKmsKeyArn',    value: this.logGroupKmsKey.keyArn,            description: 'KMS key ARN for CloudWatch log group encryption' },
            { id: 'ScriptsBucketName',    value: this.scriptsBucket.bucketName,         description: 'S3 bucket for k8s scripts and manifests' },
        ];

        this._emitOutputs(outputs);
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Emit CloudFormation stack outputs from a data-driven array.
     * Each entry creates one `CfnOutput` with value and description.
     */
    private _emitOutputs(
        outputs: { id: string; value: string; description: string }[],
    ): void {
        for (const output of outputs) {
            new cdk.CfnOutput(this, output.id, {
                value: output.value,
                description: output.description,
            });
        }
    }
}
