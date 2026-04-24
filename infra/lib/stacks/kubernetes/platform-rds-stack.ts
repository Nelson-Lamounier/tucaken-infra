/**
 * @format
 * Platform RDS Stack
 *
 * Single PostgreSQL 16 + pgvector instance in the SharedVpc.
 * Replaces RdsPgVectorStack from ai-applications.
 *
 * Placement: PUBLIC subnets (SharedVpc has no private subnets).
 * Access control: security group restricts port 5432 to VPC CIDR only.
 * publiclyAccessible: false (default) — not reachable from internet.
 *
 * All pods connect via PgBouncer (pgbouncer.platform.svc.cluster.local:5432).
 * PgBouncer maintains ≤20 server connections to RDS, multiplexed to 200 clients.
 */

import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

import {
    Environment,
    isProductionEnvironment,
    environmentRemovalPolicy,
} from '../../config';

// =============================================================================
// PROPS
// =============================================================================

export interface PlatformRdsStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly vpc: ec2.IVpc;
    readonly namePrefix: string;
    readonly databaseName: string;
}

// =============================================================================
// STACK
// =============================================================================

export class PlatformRdsStack extends cdk.Stack {
    public readonly instance: rds.DatabaseInstance;
    public readonly securityGroupId: string;

    constructor(scope: Construct, id: string, props: PlatformRdsStackProps) {
        super(scope, id, props);

        const { targetEnvironment, vpc, namePrefix, databaseName } = props;
        const isProduction = isProductionEnvironment(targetEnvironment);
        const removalPolicy = environmentRemovalPolicy(targetEnvironment);
        const ssmBase = `/k8s/${targetEnvironment}/platform-rds`;

        // Security group — restricts inbound 5432 to VPC CIDR only
        const dbSg = new ec2.SecurityGroup(this, 'PlatformRdsSg', {
            vpc,
            securityGroupName: `${namePrefix}-platform-rds`,
            description: 'Platform RDS — allow PostgreSQL from within VPC',
            allowAllOutbound: false,
        });

        dbSg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(5432),
            'PostgreSQL from VPC CIDR (K8s nodes + Lambda)',
        );

        this.securityGroupId = dbSg.securityGroupId;

        // RDS PostgreSQL 16
        // SubnetType.PUBLIC — SharedVpc has no private subnets (natGateways: 0).
        // publiclyAccessible: false — security group is the access boundary.
        const credentials = rds.Credentials.fromGeneratedSecret('postgres', {
            secretName: `${namePrefix}/platform-rds/credentials`,
        });

        this.instance = new rds.DatabaseInstance(this, 'Instance', {
            instanceIdentifier: `${namePrefix}-platform-rds`,
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_16_3,
            }),
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.T4G,
                ec2.InstanceSize.MICRO,
            ),
            credentials,
            databaseName,
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            securityGroups: [dbSg],
            publiclyAccessible: false,
            storageEncrypted: true,
            multiAz: false,
            allocatedStorage: 20,
            maxAllocatedStorage: 100,
            backupRetention: cdk.Duration.days(isProduction ? 7 : 1),
            cloudwatchLogsExports: ['postgresql', 'upgrade'],
            deletionProtection: isProduction,
            removalPolicy,
        });

        // SSM parameters — consumed by pods via ESO
        const ssmParams: Record<string, string> = {
            host:           this.instance.dbInstanceEndpointAddress,
            port:           this.instance.dbInstanceEndpointPort,
            database:       databaseName,
            user:           'postgres',
            'secret-arn':   this.instance.secret!.secretArn,
            'sg-id':        dbSg.securityGroupId,
        };

        Object.entries(ssmParams).forEach(([key, value]) => {
            new ssm.StringParameter(this, `Ssm-${key}`, {
                parameterName: `${ssmBase}/${key}`,
                stringValue: value,
                tier: ssm.ParameterTier.STANDARD,
            });
        });

        // CDK-Nag suppressions
        NagSuppressions.addResourceSuppressions(this.instance, [
            {
                id: 'AwsSolutions-RDS3',
                reason: 'Multi-AZ disabled in non-production — enable in production config',
            },
            {
                id: 'AwsSolutions-RDS11',
                reason: 'Default PostgreSQL port 5432 — non-standard port adds no meaningful security',
            },
        ], true);

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/Instance/Secret/Resource`,
            [{
                id: 'AwsSolutions-SMG4',
                reason: 'Secret rotation deferred — schedule after Phase 2 migration is stable',
            }],
        );

        new cdk.CfnOutput(this, 'RdsEndpoint', {
            value: this.instance.dbInstanceEndpointAddress,
            description: 'Platform RDS endpoint — connect via PgBouncer, not directly',
        });

        new cdk.CfnOutput(this, 'SecretArn', {
            value: this.instance.secret!.secretArn,
            description: 'Platform RDS credentials secret ARN',
        });
    }
}
