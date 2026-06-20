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
        it('should create a PostgreSQL 18 instance', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                Engine: 'postgres',
                EngineVersion: Match.stringLikeRegexp('^18\\.'),
                DBInstanceClass: 'db.t4g.small',
                DBName: 'tucaken',
                StorageEncrypted: true,
            });
        });

        it('should not be publicly accessible', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                PubliclyAccessible: false,
            });
        });

        it('should have deletion protection disabled in development', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                DeletionProtection: false,
            });
        });
    });

    describe('Security group', () => {
        it('should allow TCP 5432 inbound from VPC CIDR', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        IpProtocol: 'tcp',
                        FromPort: 5432,
                        ToPort: 5432,
                        CidrIp: Match.not(Match.exact('0.0.0.0/0')),
                    }),
                ]),
            });
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
        it('should create a generated secret for the RDS credentials', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Name: 'k8s-development/platform-rds/credentials',
            });
        });
    });
});
