/**
 * @format
 * PlatformRdsStack Unit Tests
 */
import { Template, Match } from 'aws-cdk-lib/assertions';

import { Environment } from '../../../../lib/config';
import { PlatformRdsStack } from '../../../../lib/stacks/kubernetes/platform-rds-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

const TEST_ENV = Environment.DEVELOPMENT;

function createStack(overrides?: Partial<ConstructorParameters<typeof PlatformRdsStack>[2]>) {
    // No VPC context stub: the stack resolves the VPC from SSM via deploy-time
    // dynamic references, so synth performs no Vpc.fromLookup subnet discovery.
    const app = createTestApp();

    const stack = new PlatformRdsStack(app, 'TestPlatformRdsStack', {
        targetEnvironment: TEST_ENV,
        namePrefix: 'k8s-development',
        databaseName: 'tucaken',
        env: TEST_ENV_EU,
        ...overrides,
    });
    return { stack, template: Template.fromStack(stack), app };
}

describe('PlatformRdsStack', () => {
    describe('RDS instance', () => {
        it('should restore a PostgreSQL 18 instance from the pre-migration snapshot', () => {
            const { template } = createStack();
            // Restored from snapshot: DBName and StorageEncrypted are inherited from
            // the snapshot, not set on the resource.
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                Engine: 'postgres',
                EngineVersion: Match.stringLikeRegexp('^18\\.'),
                DBInstanceClass: 'db.t4g.small',
                DBSnapshotIdentifier: 'k8s-dev-platform-rds-pre-isolated-20260704',
            });
        });

        it('should not be publicly accessible', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                PubliclyAccessible: false,
            });
        });

        it('should enable IAM database authentication', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                EnableIAMDatabaseAuthentication: true,
            });
        });

        it('should build the DB subnet group from the SSM isolated-subnet-ids parameter', () => {
            const { template } = createStack();

            // Exactly one DB subnet group, wired from the deploy-time SSM value.
            template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);

            // The isolated subnet IDs resolve at deploy time via a CFN dynamic
            // reference (AWS::SSM::Parameter::Value<String> template parameter),
            // never as literal subnet IDs baked in at synth. (The VPC id is
            // resolved at synth via valueFromLookup — it is immutable — so it
            // creates no such parameter.)
            template.hasParameter('*', {
                Type: 'AWS::SSM::Parameter::Value<String>',
                Default: '/shared/vpc/development/isolated-subnet-ids',
            });

            // No public subnet IDs leak into the subnet group.
            const dbSubnetGroups = template.findResources('AWS::RDS::DBSubnetGroup');
            const rendered = JSON.stringify(Object.values(dbSubnetGroups));
            expect(rendered).not.toContain('subnet-pub-1a');
            expect(rendered).not.toContain('subnet-pub-1b');
        });

        it('should have deletion protection disabled in development', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                DeletionProtection: false,
            });
        });
    });

    describe('Security group', () => {
        it('should not allow TCP 5432 inbound from any CIDR block', () => {
            const { template } = createStack();
            const securityGroups = template.findResources('AWS::EC2::SecurityGroup');
            const ingressRules = Object.values(securityGroups)
                .map((resource: any) => resource.Properties.SecurityGroupIngress)
                .filter(Boolean)
                .flat();

            expect(ingressRules).not.toStrictEqual(expect.arrayContaining([
                expect.objectContaining({
                    IpProtocol: 'tcp',
                    FromPort: 5432,
                    ToPort: 5432,
                    CidrIp: expect.any(String),
                }),
            ]));
        });
    });

    describe('SSM parameters', () => {
        const ssmPaths = [
            '/k8s/development/platform-rds/host',
            '/k8s/development/platform-rds/port',
            '/k8s/development/platform-rds/database',
            '/k8s/development/platform-rds/user',
            '/k8s/development/platform-rds/secret-arn',
            '/k8s/development/platform-rds/sg-id',
        ];

        it.each(ssmPaths)('should publish SSM parameter %s', (path) => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: path,
                Type: 'String',
            });
        });
    });

    describe('Secrets Manager', () => {
        it('should create a generated secret for the restored RDS credentials', () => {
            const { template } = createStack();
            // The restore uses SnapshotCredentials.fromGeneratedSecret, which cannot
            // name the secret — it is CDK auto-named. Consumers read the ARN from the
            // published SSM secret-arn param, so the exact name is not asserted here.
            template.resourceCountIs('AWS::SecretsManager::Secret', 1);
        });
    });
});
