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
import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksClusterStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly vpc: ec2.IVpc;
    readonly clusterName: string;
    readonly version: string;
}

export class EksClusterStack extends cdk.Stack {
    public readonly cluster: eks.Cluster;
    public readonly secretsKmsKey: kms.Key;

    constructor(scope: Construct, id: string, props: EksClusterStackProps) {
        super(scope, id, props);

        this.secretsKmsKey = new kms.Key(this, 'SecretsKms', {
            alias: `alias/${props.clusterName}-secrets`,
            description: `EKS secrets envelope encryption — ${props.clusterName}`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.cluster = new eks.Cluster(this, 'Cluster', {
            clusterName: props.clusterName,
            version: eks.KubernetesVersion.of(props.version),
            vpc: props.vpc,
            vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
            defaultCapacity: 0,
            kubectlLayer: new KubectlV30Layer(this, 'KubectlLayer'),
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

        cdk.Tags.of(this).add('eks-cluster', props.clusterName);
    }
}
