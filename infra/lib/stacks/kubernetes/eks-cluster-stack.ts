/**
 * @format
 * EKS Cluster Stack — managed control plane.
 *
 * Creates the EKS cluster, the cluster IAM role (CDK auto-generates), a KMS
 * envelope key for Kubernetes Secrets, and the CloudWatch log group for
 * control-plane logs. Does NOT create any node group; that is owned by
 * `EksSystemNodeGroupStack`.
 *
 * Subnets: PUBLIC only (V1 dev runs without NAT GW per cost guardrail).
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 3
 */
import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';
import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksClusterStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    /**
     * VPC name tag used for synth-time lookup via `Vpc.fromLookup()`.
     * @default `shared-vpc-${targetEnvironment}`
     */
    readonly vpcName?: string;
    readonly clusterName: string;
    readonly version: string;
}

export class EksClusterStack extends cdk.Stack {
    public readonly cluster: eks.Cluster;
    public readonly secretsKmsKey: kms.Key;
    /** Looked-up SharedVpc — exposed so sibling stacks can read `vpcId`. */
    public readonly vpc: ec2.IVpc;

    constructor(scope: Construct, id: string, props: EksClusterStackProps) {
        super(scope, id, props);

        const vpcName = props.vpcName ?? `shared-vpc-${props.targetEnvironment}`;
        this.vpc = ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName });

        this.secretsKmsKey = new kms.Key(this, 'SecretsKms', {
            alias: `alias/${props.clusterName}-secrets`,
            description: `EKS secrets envelope encryption — ${props.clusterName}`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.cluster = new eks.Cluster(this, 'Cluster', {
            clusterName: props.clusterName,
            version: eks.KubernetesVersion.of(props.version),
            vpc: this.vpc,
            vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
            defaultCapacity: 0,
            // Required for EKS Access Entries (EksAccessStack) to work.
            // CDK defaults to CONFIG_MAP (legacy aws-auth ConfigMap), which
            // silently no-ops AccessEntry resources.
            authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
            kubectlLayer: new KubectlV34Layer(this, 'KubectlLayer'),
            secretsEncryptionKey: this.secretsKmsKey,
            clusterLogging: [
                eks.ClusterLoggingTypes.API,
                eks.ClusterLoggingTypes.AUDIT,
                eks.ClusterLoggingTypes.AUTHENTICATOR,
                eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
                eks.ClusterLoggingTypes.SCHEDULER,
            ],
            outputClusterName: true,
            outputConfigCommand: true,
        });

        new logs.LogGroup(this, 'ControlPlaneLogs', {
            logGroupName: `/aws/eks/${props.clusterName}/cluster`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const platformRdsSecurityGroupId = ssm.StringParameter.valueForStringParameter(
            this,
            `/k8s/${props.targetEnvironment}/platform-rds/sg-id`,
        );

        new ec2.CfnSecurityGroupIngress(this, 'PlatformRdsIngressFromEksCluster', {
            groupId: platformRdsSecurityGroupId,
            ipProtocol: 'tcp',
            fromPort: 5432,
            toPort: 5432,
            sourceSecurityGroupId: this.cluster.clusterSecurityGroupId,
            description: 'PostgreSQL from EKS managed workload SG via PgBouncer',
        });

        cdk.Tags.of(this).add('eks-cluster', props.clusterName);

        // EKS API server is public — V1 dev runs without NAT GW (cost
        // guardrail) and GitHub Actions OIDC runners need API reachability
        // for `kubectl wait` during deploy. Mitigated by AWS Access Entries
        // (no aws-auth ConfigMap) and short-lived OIDC creds.
        NagSuppressions.addResourceSuppressions(this.cluster, [
            {
                id: 'AwsSolutions-EKS1',
                reason: 'Public API endpoint required for OIDC-based CI access without VPC connectivity; V1 dev runs without NAT GW per cost guardrail.',
            },
        ], true);

        // CDK-managed EKS cluster resource provider creates nested stacks
        // (ClusterResourceProvider, KubectlProvider) with framework Lambdas,
        // waiter state machines, and managed-policy attachments — all managed
        // by aws-cdk-lib. Suppress on the nested-stack paths via path-based
        // suppressions (addStackSuppressions does not traverse nested stacks).
        const stackName = cdk.Stack.of(this).stackName;
        const providerPaths = [
            `/${stackName}/@aws-cdk--aws-eks.ClusterResourceProvider`,
            `/${stackName}/@aws-cdk--aws-eks.KubectlProvider`,
        ];
        const providerSuppressions = [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'EKS cluster resource provider auto-generates wildcard policies for framework Lambdas; managed by aws-cdk-lib.',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'EKS cluster resource provider attaches AWS-managed policies to framework Lambda roles; managed by aws-cdk-lib.',
            },
            {
                id: 'AwsSolutions-L1',
                reason: 'EKS cluster resource provider Lambda runtimes are pinned by aws-cdk-lib.',
            },
            {
                id: 'AwsSolutions-SF1',
                reason: 'EKS cluster waiter state machine logging is managed by aws-cdk-lib.',
            },
            {
                id: 'AwsSolutions-SF2',
                reason: 'EKS cluster waiter state machine X-Ray tracing is managed by aws-cdk-lib.',
            },
        ];
        for (const p of providerPaths) {
            NagSuppressions.addResourceSuppressionsByPath(
                cdk.Stack.of(this),
                p,
                providerSuppressions,
                true,
            );
        }
    }
}
