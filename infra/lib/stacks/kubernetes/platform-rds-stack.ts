/**
 * @format
 * Platform RDS Stack
 *
 * Single PostgreSQL 16 + pgvector instance in the SharedVpc.
 * Replaces RdsPgVectorStack from ai-applications.
 *
 * Placement: isolated subnets, resolved from SSM at deploy time (not
 * Vpc.fromLookup) so this stack never caches subnet discovery or depends on the
 * subnets existing at synth. See the VPC resolution block below.
 * Access control: this stack creates the DB security group but does not grant
 * CIDR ingress. Source stacks add explicit SG-to-SG rules for approved clients.
 * publiclyAccessible: false (default) — not reachable from internet.
 *
 * All pods connect via PgBouncer (pgbouncer.platform.svc.cluster.local:5432).
 * PgBouncer maintains ≤20 server connections to RDS, multiplexed to 200 clients.
 */

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    Environment,
    environmentRemovalPolicy,
    isProductionEnvironment,
} from '../../config';
import { SsmParameterStoreConstruct } from '../../constructs/ssm';

// =============================================================================
// PROPS
// =============================================================================

export interface PlatformRdsStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    /**
     * @deprecated No longer used. The VPC is resolved from SSM
     * (`/shared/vpc/${targetEnvironment}/*`) at deploy time. Retained only for
     * backwards compatibility with existing callers.
     */
    readonly vpcName?: string;
    readonly namePrefix: string;
    readonly databaseName: string;
}

// =============================================================================
// STACK
// =============================================================================

export class PlatformRdsStack extends cdk.Stack {
    public readonly instance: rds.IDatabaseInstance;
    public readonly securityGroupId: string;

    constructor(scope: Construct, id: string, props: PlatformRdsStackProps) {
        super(scope, id, props);

        const { targetEnvironment, namePrefix, databaseName } = props;
        const isProduction = isProductionEnvironment(targetEnvironment);
        // Resolve the shared VPC from SSM instead of Vpc.fromLookup(). fromLookup
        // runs a synth-time subnet discovery that (a) caches into cdk.context.json —
        // going stale after the VPC's subnets change — and (b) needs the isolated
        // subnets to exist at synth, a chicken/egg with the VPC stack that publishes
        // them. Two different SSM read modes, chosen deliberately:
        //
        //   vpcId  -> valueFromLookup (synth-time). A VPC id is immutable, so a
        //     cached synth value is always correct. Critically, this keeps the DB
        //     security group's VpcId a *concrete literal*: VpcId is immutable on a
        //     SecurityGroup, so a token here would force a replace of the fixed-name
        //     SG and collide with the existing one.
        //   subnetIds -> valueForStringParameter (deploy-time {{resolve:ssm:...}}).
        //     Subnet IDs can change, so they must resolve at deploy, not be cached.
        //     They land only in the DBSubnetGroup, which CDK auto-names and CFN can
        //     freely update.
        const vpcSsm = `/shared/vpc/${targetEnvironment}`;
        const vpcId = ssm.StringParameter.valueFromLookup(this, `${vpcSsm}/vpc-id`);
        // fromVpcAttributes rejects token AZs, so derive concrete AZs from the stack
        // region (no account lookup). The shared VPC spans the first two AZs
        // (maxAzs: 2); RDS needs ≥2 isolated subnets across ≥2 AZs.
        const availabilityZones = ['a', 'b'].map(z => `${this.region}${z}`);
        // Fn.split yields an unknown-length token list (CDK counts it as 1), which
        // trips fromVpcAttributes' "subnets must be a multiple of AZs" check. Build a
        // fixed-length list with Fn.select so the count matches availabilityZones.
        const splitIds = cdk.Fn.split(
            ',',
            ssm.StringParameter.valueForStringParameter(this, `${vpcSsm}/isolated-subnet-ids`),
        );
        const isolatedSubnetIds = availabilityZones.map((_, i) => cdk.Fn.select(i, splitIds));
        const vpc = ec2.Vpc.fromVpcAttributes(this, 'SharedVpc', {
            vpcId,
            availabilityZones,
            isolatedSubnetIds,
        });
        const removalPolicy = environmentRemovalPolicy(targetEnvironment);
        const ssmBase = `/k8s/${targetEnvironment}/platform-rds`;

        // Security group — source stacks grant narrow ingress by security group.
        // NOTE: `description` (CFN GroupDescription) is IMMUTABLE. Editing it forces
        // a replacement, which collides with the fixed securityGroupName below and
        // fails with "already exists". The wording is kept byte-identical to the
        // deployed SG on purpose; the real access model (no CIDR ingress, SG-to-SG
        // grants added by source stacks) lives in the ingress rules, not this label.
        const dbSg = new ec2.SecurityGroup(this, 'PlatformRdsSg', {
            vpc,
            securityGroupName: `${namePrefix}-platform-rds`,
            description: 'Platform RDS - allow PostgreSQL from within VPC',
            allowAllOutbound: false,
        });

        this.securityGroupId = dbSg.securityGroupId;

        // RDS PostgreSQL 18 in the isolated subnets.
        //
        // MIGRATION (2026-07-04): the instance previously lived in the shared VPC's
        // public subnets. RDS cannot relocate a *running* instance to a disjoint
        // subnet set in place — modifying the DB subnet group to drop the in-use
        // public subnets fails with "subnets to be deleted are currently in use". So
        // the instance is re-created from a pre-migration snapshot into the isolated
        // subnet group. CloudFormation replacement is create-before-delete, so the
        // restored instance needs a NEW identifier and a NEW credentials secret — a
        // same-name resource would collide with the still-existing originals. The new
        // endpoint and secret ARN are re-published to SSM below, so PgBouncer/ESO
        // consumers that read those SSM values follow the cutover automatically.
        //
        // `snapshotIdentifier` seeds the data on first create only; it must be
        // retained for as long as this instance could be replaced.
        // SnapshotCredentials.fromGeneratedSecret cannot name the secret (the API
        // exposes no secretName), so the restore gets a CDK auto-named secret. That
        // is fine: consumers read the ARN from `${ssmBase}/secret-arn` below, never a
        // fixed secret name. The generated secret resets the master password on the
        // restored instance.
        const credentials = rds.SnapshotCredentials.fromGeneratedSecret('postgres');

        // Explicit, separately-named subnet group in the isolated subnets. The old
        // instance's auto-created group ('Instance/SubnetGroup') must NOT be reused:
        // mutating it to drop the in-use public subnets fails while the old instance
        // still holds them ("subnets to be deleted are currently in use"). A distinct
        // group lets CloudFormation build the new group + restored instance first,
        // then delete the old instance and its old group last — no in-use conflict.
        const subnetGroup = new rds.SubnetGroup(this, 'IsolatedSubnetGroup', {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            description: 'Platform RDS - isolated (no-NAT) data subnets',
            removalPolicy,
        });

        const instance = new rds.DatabaseInstanceFromSnapshot(this, 'Instance', {
            snapshotIdentifier: 'k8s-dev-platform-rds-pre-isolated-20260704',
            instanceIdentifier: `${namePrefix}-platform-rds-iso`,
            engine: rds.DatabaseInstanceEngine.postgres({
                // Matches the snapshot's engine version (auto minor upgrade landed 18.3).
                version: rds.PostgresEngineVersion.VER_18_3,
            }),
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.T4G,
                // t4g.small: a t4g.micro (2 burstable vCPU, ~1 GB) cannot sustain
                // canonical-ingestion load — parallel enrichment workers exhaust CPU
                // credits, then throttle to baseline and REFUSE/TIME OUT connections.
                ec2.InstanceSize.SMALL,
            ),
            credentials,
            vpc,
            subnetGroup,
            securityGroups: [dbSg],
            publiclyAccessible: false,
            iamAuthentication: true,
            allowMajorVersionUpgrade: true,
            multiAz: false,
            // Keep the snapshot's 20 GiB; without this CDK defaults AllocatedStorage
            // to 100 GiB, silently tripling storage cost.
            allocatedStorage: 20,
            maxAllocatedStorage: 100,
            backupRetention: cdk.Duration.days(isProduction ? 7 : 1),
            cloudwatchLogsExports: ['postgresql', 'upgrade'],
            enablePerformanceInsights: true,
            performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
            monitoringInterval: cdk.Duration.seconds(60),
            deletionProtection: isProduction,
            removalPolicy,
        });
        this.instance = instance;

        // SSM parameters — consumed by pods via ESO
        new SsmParameterStoreConstruct(this, 'SsmParams', {
            parameters: {
                [`${ssmBase}/host`]:       instance.dbInstanceEndpointAddress,
                [`${ssmBase}/port`]:       instance.dbInstanceEndpointPort,
                [`${ssmBase}/database`]:   databaseName,
                [`${ssmBase}/user`]:       'postgres',
                [`${ssmBase}/secret-arn`]: instance.secret!.secretArn,
                [`${ssmBase}/sg-id`]:      dbSg.securityGroupId,
            },
        });

        // CDK-Nag suppressions
        const nagSuppressions = [
            {
                id: 'AwsSolutions-RDS3',
                reason: 'Multi-AZ disabled in non-production — enable in production config',
            },
            {
                id: 'AwsSolutions-RDS11',
                reason: 'Default PostgreSQL port 5432 — non-standard port adds no meaningful security',
            },
            {
                id: 'AwsSolutions-RDS2',
                reason:
                    'Storage encryption is inherited from the encrypted pre-migration snapshot. ' +
                    'DatabaseInstanceFromSnapshot does not re-emit StorageEncrypted, so cdk-nag ' +
                    'cannot see it statically — this is a false positive, the restored volume is encrypted.',
            },
        ];

        if (!isProduction) {
            nagSuppressions.push({
                id: 'AwsSolutions-RDS10',
                reason: 'Deletion protection intentionally disabled in non-production for easy teardown',
            });
        }

        NagSuppressions.addResourceSuppressions(this.instance, nagSuppressions, true);

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
            value: instance.secret!.secretArn,
            description: 'Platform RDS credentials secret ARN',
        });
    }
}
