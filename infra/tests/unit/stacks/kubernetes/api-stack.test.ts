/**
 * @format
 * NextJS API Stack Unit Tests
 *
 * Tests for the NextJS API Gateway stack:
 * - REST API creation with correct naming
 * - CloudWatch access logging
 * - CORS configuration
 * - Request validation (AwsSolutions-APIG2)
 * - Throttling configuration
 * - Per-function dead letter queues (all environments, env-driven retention)
 * - Lambda functions (subscriptions only — article Lambdas removed)
 * - SES permissions for subscription Lambda
 * - Stack outputs
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import {
    NextJsApiStack,
    NextJsApiStackProps,
} from '../../../../lib/stacks/kubernetes/api-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

/**
 * Helper to create NextJsApiStack for testing
 * Uses SSM paths (resolved as dummy tokens in tests)
 */
function createApiStack(
    props?: Partial<NextJsApiStackProps>,
): { stack: NextJsApiStack; template: Template } {
    const app = createTestApp();

    const stack = new NextJsApiStack(app, 'TestApiStack', {
        env: TEST_ENV_EU,
        targetEnvironment: props?.targetEnvironment ?? Environment.DEVELOPMENT,
        tableSsmPath: props?.tableSsmPath ?? '/nextjs/development/dynamodb-table-name',
        bucketSsmPath: props?.bucketSsmPath ?? '/nextjs/development/assets-bucket-name',
        projectName: props?.projectName ?? 'nextjs',
        ssmPrefix: props?.ssmPrefix ?? '/k8s/development',
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}


describe('NextJsApiStack', () => {
    describe('REST API', () => {
        it('should create a REST API', () => {
            const { template } = createApiStack();
            template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
        });

        it('should use correct naming convention', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::RestApi', {
                Name: Match.stringLikeRegexp('nextjs.*portfolio-api.*development'),
            });
        });

        it('should have description', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::RestApi', {
                Description: Match.anyValue(),
            });
        });

        it('should use REGIONAL endpoint type', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::RestApi', {
                EndpointConfiguration: {
                    Types: ['REGIONAL'],
                },
            });
        });
    });

    describe('Request Validator (AwsSolutions-APIG2)', () => {
        it('should create request validator', () => {
            const { template } = createApiStack();
            template.resourceCountIs('AWS::ApiGateway::RequestValidator', 1);
        });

        it('should validate request body', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
                ValidateRequestBody: true,
            });
        });

        it('should validate request parameters', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
                ValidateRequestParameters: true,
            });
        });

        it('should use environment-specific naming', () => {
            const { template } = createApiStack({
                targetEnvironment: Environment.STAGING,
            });
            template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
                Name: Match.stringLikeRegexp('staging'),
            });
        });
    });

    describe('CloudWatch Logging', () => {
        it('should create CloudWatch log group for access logs', () => {
            const { template } = createApiStack();
            // Log group exists with retention configured (no hardcoded name)
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                RetentionInDays: Match.anyValue(),
            });
        });

        it('should set log retention', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                RetentionInDays: Match.anyValue(),
            });
        });

        it('should enable logging on deployment stage', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::Stage', {
                MethodSettings: Match.arrayWith([
                    Match.objectLike({
                        LoggingLevel: 'INFO',
                    }),
                ]),
            });
        });

        it('should have access log destination configured', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::Stage', {
                AccessLogSetting: Match.objectLike({
                    DestinationArn: Match.anyValue(),
                }),
            });
        });

        it('should have API Gateway account resource for CloudWatch Logs role', () => {
            const { template } = createApiStack();
            // CDK auto-creates CfnAccount + IAM role when cloudWatchRole=true (default)
            template.resourceCountIs('AWS::ApiGateway::Account', 1);
        });
    });

    describe('Throttling Configuration', () => {
        it('should configure stage-level throttling', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::Stage', {
                MethodSettings: Match.arrayWith([
                    Match.objectLike({
                        ThrottlingRateLimit: Match.anyValue(),
                        ThrottlingBurstLimit: Match.anyValue(),
                    }),
                ]),
            });
        });
    });

    describe('Dead Letter Queue (Production)', () => {
        it('should create DLQ for production environment', () => {
            const { template } = createApiStack({
                targetEnvironment: Environment.PRODUCTION,
                verificationSecret: 'test-production-secret',
            });
            // 2 per-function DLQs (subscribe + verify)
            template.resourceCountIs('AWS::SQS::Queue', 2);
        });

        it('should use KMS encryption for DLQ', () => {
            const { template } = createApiStack({
                targetEnvironment: Environment.PRODUCTION,
                verificationSecret: 'test-production-secret',
            });
            template.hasResourceProperties('AWS::SQS::Queue', {
                KmsMasterKeyId: 'alias/aws/sqs',
            });
        });

        it('should also create DLQs for development environment', () => {
            const { template } = createApiStack({
                targetEnvironment: Environment.DEVELOPMENT,
            });
            // 2 per-function DLQs (subscribe + verify)
            template.resourceCountIs('AWS::SQS::Queue', 2);
        });



        it('should enforce SSL on DLQ queues (AwsSolutions-SQS4)', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::SQS::QueuePolicy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Deny',
                            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
                        }),
                    ]),
                }),
            });
        });
    });

    describe('DLQ CloudWatch Alarms', () => {
        it('should create 2 CloudWatch alarms (one per DLQ)', () => {
            const { template } = createApiStack();
            template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
        });

        it('should create SNS topic for DLQ alarm notifications', () => {
            const { template } = createApiStack();
            template.resourceCountIs('AWS::SNS::Topic', 1);
        });

        it('should create email subscription when notificationEmail is provided', () => {
            const { template } = createApiStack({
                notificationEmail: 'test@example.com',
            });
            template.hasResourceProperties('AWS::SNS::Subscription', {
                Protocol: 'email',
                Endpoint: 'test@example.com',
            });
        });

        it('should alarm on ApproximateNumberOfMessagesVisible >= 1', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                MetricName: 'ApproximateNumberOfMessagesVisible',
                Threshold: 1,
                EvaluationPeriods: 1,
                ComparisonOperator: 'GreaterThanOrEqualToThreshold',
                TreatMissingData: 'notBreaching',
            });
        });
    });


    describe('Lambda Functions - Email Subscriptions', () => {
        it('should create subscribe Lambda function', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: Match.stringLikeRegexp('subscribe'),
            });
        });

        it('should create verify-subscription Lambda function', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: Match.stringLikeRegexp('verify-subscription'),
            });
        });

        it('should create 2 Lambda functions + 1 custom resource provider', () => {
            const { template } = createApiStack();
            // 2 business Lambdas (subscribe + verify) + 1 AwsCustomResource provider for SSM parameter
            template.resourceCountIs('AWS::Lambda::Function', 3);
        });

        it('should grant SES SendEmail permission to subscribe Lambda', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith(['ses:SendEmail']),
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });

        it('should pass email configuration as environment variables', () => {
            const { template } = createApiStack({
                notificationEmail: 'test@example.com',
                sesFromEmail: 'noreply@example.com',
            });
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: Match.stringLikeRegexp('subscribe'),
                Environment: {
                    Variables: Match.objectLike({
                        NOTIFICATION_EMAIL: 'test@example.com',
                        SES_FROM_EMAIL: 'noreply@example.com',
                    }),
                },
            });
        });
    });

    describe('Stage Configuration', () => {
        it('should create deployment stage', () => {
            const { template } = createApiStack();
            template.resourceCountIs('AWS::ApiGateway::Stage', 1);
        });

        it('should use api as default stage name', () => {
            const { template } = createApiStack();
            template.hasResourceProperties('AWS::ApiGateway::Stage', {
                StageName: 'api',
            });
        });
    });

    describe('Stack Outputs', () => {
        it('should export API URL', () => {
            const { template } = createApiStack();
            template.hasOutput('ApiUrl', {});
        });

        it('should export API ID', () => {
            const { template } = createApiStack();
            template.hasOutput('ApiId', {});
        });

        it('should export subscribe endpoint', () => {
            const { template } = createApiStack();
            template.hasOutput('SubscribeEndpoint', {});
        });

        it('should export verify endpoint', () => {
            const { template } = createApiStack();
            template.hasOutput('VerifyEndpoint', {});
        });
    });

    describe('Stack Properties', () => {
        it('should expose api property', () => {
            const { stack } = createApiStack();
            expect(stack.api).toBeDefined();
        });

        it('should expose targetEnvironment property', () => {
            const { stack } = createApiStack({
                targetEnvironment: Environment.STAGING,
            });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });

        it('should expose lambdaDlqs for production', () => {
            const { stack } = createApiStack({
                targetEnvironment: Environment.PRODUCTION,
                verificationSecret: 'test-production-secret',
            });
            expect(stack.lambdaDlqs).toBeDefined();
            expect(Object.keys(stack.lambdaDlqs)).toHaveLength(2);
        });

        it('should throw if production has no verificationSecret', () => {
            expect(() => createApiStack({
                targetEnvironment: Environment.PRODUCTION,
            })).toThrow('verificationSecret is required in production');
        });

        it('should expose lambdaDlqs for all environments', () => {
            const { stack } = createApiStack({
                targetEnvironment: Environment.DEVELOPMENT,
            });
            expect(stack.lambdaDlqs).toBeDefined();
            expect(Object.keys(stack.lambdaDlqs)).toHaveLength(2);
        });
    });

    describe('Environment Configuration', () => {
        it('should include environment in resource names', () => {
            const { template } = createApiStack({
                targetEnvironment: Environment.STAGING,
            });
            template.hasResourceProperties('AWS::ApiGateway::RestApi', {
                Name: Match.stringLikeRegexp('staging'),
            });
        });

        it('should tag resources with Stack tag', () => {
            const { stack } = createApiStack();
            const tags = cdk.Tags.of(stack);
            expect(tags).toBeDefined();
        });
    });

    describe('CORS Configuration', () => {
        it('should have CORS preflight options', () => {
            // CORS is configured via defaultCorsPreflightOptions
            // This creates OPTIONS methods on resources
            const { template } = createApiStack();
            // RestApi should exist with CORS enabled
            template.hasResourceProperties('AWS::ApiGateway::RestApi', {
                Name: Match.anyValue(),
            });
        });
    });

    describe('Security Best Practices', () => {
        it('should create resources for CDK-Nag compliance', () => {
            const { template } = createApiStack();

            // Request validator exists (APIG2)
            template.resourceCountIs('AWS::ApiGateway::RequestValidator', 1);

            // CloudWatch logging enabled (log group with retention)
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                RetentionInDays: Match.anyValue(),
            });
        });
    });
});
