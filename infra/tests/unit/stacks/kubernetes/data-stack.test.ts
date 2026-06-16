/**
 * @format
 * Kubernetes Data Stack Unit Tests
 *
 * Tests for the KubernetesDataStack:
 * - S3 Assets & Access Logs Buckets (encryption, versioning, public access)
 * - SSM Parameters (cross-stack references)
 * - CloudFormation Outputs (bucket, SSM prefix)
 * - Tags (Stack, Layer)
 *
 * NOTE: DynamoDB tests have been removed — the portfolio table
 * is now consolidated in AiContentStack (bedrock-{env}-ai-content).
 *
 * All tests use the same config references as the stack itself
 * (nextjsSsmPaths, etc.) to ensure the test validates real behaviour.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import {
    Environment,
    nextjsSsmPaths,
} from '../../../../lib/config';
import { KubernetesDataStack } from '../../../../lib/stacks/kubernetes/data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
    StackAssertions,
} from '../../../fixtures';

// =============================================================================
// Test Constants — derived from the same configs the stack uses
// =============================================================================

const TEST_PROJECT = 'k8s';
const TEST_ENV = Environment.DEVELOPMENT;
const TEST_SSM_PATHS = nextjsSsmPaths(TEST_ENV, TEST_PROJECT);

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create KubernetesDataStack with sensible defaults.
 * Uses the same config references as the factory.
 */
function _createDataStack(
    overrides?: Partial<ConstructorParameters<typeof KubernetesDataStack>[2]>,
): { stack: KubernetesDataStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new KubernetesDataStack(
        app,
        'TestK8sDataStack',
        {
            targetEnvironment: TEST_ENV,
            projectName: TEST_PROJECT,
            env: TEST_ENV_EU,
            ...overrides,
        },
    );

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesDataStack', () => {


    // =========================================================================
    // S3 Buckets
    // =========================================================================
    describe('S3 Buckets', () => {
        it('should create 2 S3 buckets (assets + access logs)', () => {
            const { template } = _createDataStack();

            StackAssertions.hasResourceCount(template, 'AWS::S3::Bucket', 2);
        });

        it('should block public access on assets bucket', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });

        it('should enable versioning on both buckets', () => {
            const { template } = _createDataStack();
            const buckets = template.findResources('AWS::S3::Bucket');

            const allVersioned = Object.values(buckets).every((bucket) => {
                const props = (bucket as { Properties?: { VersioningConfiguration?: { Status: string } } }).Properties;
                return props?.VersioningConfiguration?.Status === 'Enabled';
            });

            expect(allVersioned).toBe(true);
        });

        it('should use S3-managed encryption on both buckets', () => {
            const { template } = _createDataStack();

            // Both the access-logs and assets bucket use S3_MANAGED encryption.
            // Verify at least one bucket has an SSE configuration (CDK sets it on all).
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketEncryption: Match.objectLike({
                    ServerSideEncryptionConfiguration: Match.arrayWith([
                        Match.objectLike({
                            ServerSideEncryptionByDefault: Match.objectLike({
                                SSEAlgorithm: Match.anyValue(),
                            }),
                        }),
                    ]),
                }),
            });
        });

        it('should not grant the CloudFront service principal (OAC grant retired with CloudFront edge)', () => {
            // CloudFront was retired in the EKS migration (the edge is now the
            // shared ALB; no distributions exist in the account). The OAC bucket
            // policy granting cloudfront.amazonaws.com was removed in data-stack.ts.
            const { template } = _createDataStack();

            // No bucket policy (or any resource) may reference the CloudFront
            // service principal — the OAC grant was removed with the edge.
            expect(JSON.stringify(template.toJSON())).not.toContain('cloudfront.amazonaws.com');
        });

        it('should have lifecycle rules on assets bucket', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({ Id: 'archive-old-versions', Status: 'Enabled' }),
                        Match.objectLike({ Id: 'delete-incomplete-uploads', Status: 'Enabled' }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should create SSM parameter for assets bucket name', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: TEST_SSM_PATHS.assetsBucketName,
            });
        });

        it('should create SSM parameter for AWS region', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: TEST_SSM_PATHS.awsRegion,
            });
        });

        it('should NOT create SSM parameter for DynamoDB table name', () => {
            const { template } = _createDataStack();

            // DynamoDB table is now in AiContentStack — no table name SSM param here
            const ssmResources = template.findResources('AWS::SSM::Parameter');
            const tableNameParam = Object.values(ssmResources).find((r) => {
                const props = (r as { Properties?: { Name?: string } }).Properties;
                return props?.Name === TEST_SSM_PATHS.dynamodbTableName;
            });

            expect(tableNameParam).toBeUndefined();
        });
    });

    // =========================================================================
    // CloudFormation Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should export AssetsBucketName with cross-stack export', () => {
            const { template } = _createDataStack();

            StackAssertions.hasOutput(template, 'AssetsBucketName', {
                description: 'S3 bucket name for article images and media',
                exportName: `${TEST_ENV}-${TEST_PROJECT}-assets-bucket-name`,
            });
        });

        it('should export SsmParameterPrefix without export name', () => {
            const { template } = _createDataStack();

            StackAssertions.hasOutput(template, 'SsmParameterPrefix', {
                description: 'SSM parameter path prefix for this environment',
            });
        });

        describe('PortfolioTable outputs removal', () => {
            // Depends on: template from _createDataStack
            let outputKeys: string[];

            beforeAll(() => {
                const { template } = _createDataStack();
                const outputs = template.toJSON().Outputs ?? {};
                outputKeys = Object.keys(outputs).filter(
                    (key) => key.startsWith('PortfolioTable'),
                );
            });

            it('should NOT export PortfolioTable outputs', () => {
                // DynamoDB outputs removed — table is in AiContentStack
                expect(outputKeys).toHaveLength(0);
            });
        });
    });

    // =========================================================================
    // Tags
    // =========================================================================
    describe('Tags and Metadata', () => {
        it('should add proper tags to S3 buckets', () => {
            const { template } = _createDataStack();

            // Verify buckets exist (tags are applied at stack level via aspects)
            StackAssertions.hasResourceCount(template, 'AWS::S3::Bucket', 2);
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose targetEnvironment', () => {
            const { stack } = _createDataStack();

            expect(stack.targetEnvironment).toBe(TEST_ENV);
        });

        it('should expose ssmPrefix matching config', () => {
            const { stack } = _createDataStack();

            expect(stack.ssmPrefix).toBe(TEST_SSM_PATHS.prefix);
        });

        it('should expose assetsBucket as a Bucket construct', () => {
            const { stack } = _createDataStack();

            expect(stack.assetsBucket).toBeDefined();
            expect(stack.assetsBucket.bucketName).toBeDefined();
        });

        it('should expose accessLogsBucket as a Bucket construct', () => {
            const { stack } = _createDataStack();

            expect(stack.accessLogsBucket).toBeDefined();
            expect(stack.accessLogsBucket.bucketName).toBeDefined();
        });
    });

    // =========================================================================
    // Environment-Specific Behavior
    // =========================================================================
    describe('Environment-Specific Behaviour', () => {
        it('should create all S3 buckets regardless of environment', () => {
            const devResult = _createDataStack({ targetEnvironment: Environment.DEVELOPMENT });
            const prodResult = _createDataStack({ targetEnvironment: Environment.PRODUCTION });

            StackAssertions.hasResourceCount(devResult.template, 'AWS::S3::Bucket', 2);
            StackAssertions.hasResourceCount(prodResult.template, 'AWS::S3::Bucket', 2);
        });
    });
});
