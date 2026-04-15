/**
 * @format
 * Bedrock API Stack Unit Tests
 *
 * Tests for the BedrockApiStack:
 * - API Gateway REST API with correct name
 * - API Key and Usage Plan (throttling)
 * - Request Validator configured
 * - Invoke Lambda with correct env vars and runtime
 * - IAM policy for bedrock:InvokeAgent
 * - CloudWatch access log group
 * - SSM parameter exports
 * - Stack outputs
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { BedrockApiStack } from '../../../../lib/stacks/bedrock/api-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'bedrock-development';

/**
 * Helper to create BedrockApiStack with sensible defaults.
 */
function createApiStack(
    overrides?: Partial<ConstructorParameters<typeof BedrockApiStack>[2]>,
): { stack: BedrockApiStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new BedrockApiStack(
        app,
        'TestBedrockApiStack',
        {
            namePrefix: NAME_PREFIX,
            environmentName: 'development',
            lambdaMemoryMb: 256,
            lambdaTimeoutSeconds: 60,
            logRetention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            enableApiKey: true,
            allowedOrigins: ['https://nelsonlamounier.com'],
            throttlingRateLimit: 10,
            throttlingBurstLimit: 20,
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

describe('BedrockApiStack', () => {

    // =========================================================================
    // API Gateway
    // =========================================================================
    describe('API Gateway', () => {
        const { template } = createApiStack();

        it('should create a REST API with correct name', () => {
            template.hasResourceProperties('AWS::ApiGateway::RestApi', {
                Name: `${NAME_PREFIX}-agent-api`,
            });
        });
    });

    // =========================================================================
    // API Key + Usage Plan
    // =========================================================================
    describe('API Key and Usage Plan', () => {
        it('should create an API Key when enableApiKey is true', () => {
            const { template } = createApiStack({ enableApiKey: true });
            template.hasResourceProperties('AWS::ApiGateway::ApiKey', {
                Name: `${NAME_PREFIX}-agent-api-key`,
                Enabled: true,
            });
        });

        it('should create a Usage Plan when enableApiKey is true', () => {
            const { template } = createApiStack({ enableApiKey: true });
            template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
                UsagePlanName: `${NAME_PREFIX}-usage-plan`,
                Throttle: Match.objectLike({
                    RateLimit: 10,
                    BurstLimit: 20,
                }),
            });
        });

        it('should NOT create an API Key when enableApiKey is false', () => {
            const { template } = createApiStack({ enableApiKey: false });
            template.resourceCountIs('AWS::ApiGateway::ApiKey', 0);
        });
    });

    // =========================================================================
    // Request Validator
    // =========================================================================
    describe('Request Validation', () => {
        const { template } = createApiStack();

        it('should create a request validator', () => {
            template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
                Name: `${NAME_PREFIX}-invoke-validator`,
                ValidateRequestBody: true,
            });
        });

        it('should define a request model', () => {
            template.hasResourceProperties('AWS::ApiGateway::Model', {
                ContentType: 'application/json',
                Name: 'InvokeRequest',
            });
        });
    });

    // =========================================================================
    // Lambda — Invoke Function
    // =========================================================================
    describe('Lambda InvokeFunction', () => {
        const { template } = createApiStack();

        it('should create a Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-invoke-agent`,
            });
        });

        it('should use Node.js 22 runtime', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'nodejs22.x',
            });
        });

        it('should configure agent environment variables from SSM parameters', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        AGENT_ID: Match.anyValue(),
                        AGENT_ALIAS_ID: Match.anyValue(),
                    }),
                },
            });
        });

        it('should set 256 MB memory', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                MemorySize: 256,
            });
        });

        it('should set 60 second timeout', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Timeout: 60,
            });
        });
    });

    // =========================================================================
    // IAM — Bedrock InvokeAgent permission
    // =========================================================================
    describe('IAM Policies', () => {
        const { template } = createApiStack();

        it('should grant Bedrock InvokeAgent permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'bedrock:InvokeAgent',
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });
    });

    // =========================================================================
    // CloudWatch Access Log Group
    // =========================================================================
    describe('CloudWatch Access Logging', () => {
        const { template } = createApiStack();

        it('should create an access log group for the API', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/apigateway/${NAME_PREFIX}-agent-api`,
                RetentionInDays: 7,
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createApiStack();

        it('should create SSM parameter for API URL', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/api-url`,
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createApiStack();

        it('should output the API URL', () => {
            template.hasOutput('ApiUrl', {});
        });

        it('should output the API ID', () => {
            template.hasOutput('ApiId', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createApiStack();

        it('should expose api', () => {
            expect(stack.api).toBeDefined();
        });

        it('should expose invokeFunction', () => {
            expect(stack.invokeFunction).toBeDefined();
        });

        it('should expose apiUrl', () => {
            expect(stack.apiUrl).toBeDefined();
        });

        it('should expose apiKey when enableApiKey is true', () => {
            expect(stack.apiKey).toBeDefined();
        });
    });
});
