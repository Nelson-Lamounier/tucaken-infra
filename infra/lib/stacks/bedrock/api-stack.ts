/**
 * @format
 * Bedrock API Stack
 *
 * API Gateway + Lambda frontend for the Bedrock Agent.
 * Provides a secured REST endpoint to invoke the agent.
 *
 * Security features:
 * - API Key stored in Secrets Manager — value injected via CF dynamic reference
 *   so the BFF proxy can retrieve it at runtime without manual rotation (Gap S2)
 * - Request body validation
 * - CloudWatch access logging
 * - No browser CORS — endpoint is BFF-only (server-to-server), not browser-facing
 */

import * as path from 'path';

import { NagSuppressions } from 'cdk-nag';

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for BedrockApiStack
 */
export interface BedrockApiStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Runtime environment name (e.g. 'development') — used for resource naming */
    readonly environmentName: string;
    /** Lambda memory in MB */
    readonly lambdaMemoryMb: number;
    /** Lambda timeout in seconds */
    readonly lambdaTimeoutSeconds: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Whether to enable API Key authentication */
    readonly enableApiKey: boolean;
    /** Allowed CORS origins — used by Lambda ALLOWED_ORIGINS env var only.
     *  No browser CORS is set on API Gateway itself (BFF-only endpoint). */
    readonly allowedOrigins: string[];
    /** API Gateway throttle — sustained requests per second */
    readonly throttlingRateLimit: number;
    /** API Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
}

/**
 * API Stack for Bedrock Agent.
 *
 * Creates a secured REST API Gateway backed by a Lambda function that
 * invokes the Bedrock Agent using the AWS SDK.
 */
export class BedrockApiStack extends cdk.Stack {
    /** The API Gateway REST API */
    public readonly api: apigateway.RestApi;

    /** The invoke Lambda function */
    public readonly invokeFunction: lambdaNode.NodejsFunction;

    /** The API URL */
    public readonly apiUrl: string;

    /** The API Key (if enabled) */
    public readonly apiKey?: apigateway.IApiKey;

    /**
     * ARN of the Secrets Manager secret holding the API key value.
     *
     * Exported to SSM so the BFF proxy (public-api) can retrieve the key
     * at runtime via the EC2 instance profile — no static credentials needed.
     * Only set when `enableApiKey` is true.
     */
    public readonly apiKeySecretArn?: string;

    constructor(scope: Construct, id: string, props: BedrockApiStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // Resolve Agent IDs from SSM (avoids cross-stack exports from AgentStack)
        const agentId = ssm.StringParameter.valueForStringParameter(
            this, `/${namePrefix}/agent-id`,
        );
        const agentAliasId = ssm.StringParameter.valueForStringParameter(
            this, `/${namePrefix}/agent-alias-id`,
        );

        // =================================================================
        // Invoke Lambda — Calls Bedrock Agent via SDK
        //
        // Uses NodejsFunction for esbuild bundling from the
        // lambda/bedrock/invoke-agent/ directory.
        // =================================================================
        this.invokeFunction = new lambdaNode.NodejsFunction(this, 'InvokeFunction', {
            functionName: `${namePrefix}-invoke-agent`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'chatbot', 'src', 'index.ts'),
            handler: 'handler',
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            environment: {
                AGENT_ID: agentId,
                AGENT_ALIAS_ID: agentAliasId,
                ALLOWED_ORIGINS: props.allowedOrigins.join(','),
            },
            description: `Agent invocation handler for ${namePrefix}`,
            logGroup: new logs.LogGroup(this, 'InvokeFunctionLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-invoke-agent`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: [
                    // AWS SDK v3 is included in the Lambda runtime
                    '@aws-sdk/*',
                ],
            },
        });

        // CDK-Nag suppression: NODEJS_22_X is the latest Node.js LTS runtime;
        // AwsSolutions-L1 may not recognize it as latest yet.
        NagSuppressions.addResourceSuppressions(
            this.invokeFunction,
            [{ id: 'AwsSolutions-L1', reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime' }],
            true,
        );

        // Grant Bedrock Agent invoke permissions
        this.invokeFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'InvokeBedrockAgent',
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeAgent',
            ],
            resources: [
                `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${agentId}/${agentAliasId}`,
            ],
        }));

        // =================================================================
        // CloudWatch Log Group — API Gateway Access Logging
        // =================================================================
        const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
            logGroupName: `/aws/apigateway/${namePrefix}-agent-api`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // API Gateway — REST API
        // =================================================================
        // No defaultCorsPreflightOptions — this endpoint is BFF-only (server-to-server).
        // The public-api proxy handles browser CORS for its own /api/chatbot/invoke route.
        // Removing browser CORS from API Gateway prevents direct browser invocation
        // and eliminates the need to distribute x-api-key to the client.
        this.api = new apigateway.RestApi(this, 'AgentApi', {
            restApiName: `${namePrefix}-agent-api`,
            description: `REST API for ${namePrefix} Bedrock Agent`,
            deployOptions: {
                stageName: 'v1',
                tracingEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
                accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
                    caller: true,
                    httpMethod: true,
                    ip: true,
                    protocol: true,
                    requestTime: true,
                    resourcePath: true,
                    responseLength: true,
                    status: true,
                    user: true,
                }),
                throttlingRateLimit: props.throttlingRateLimit,
                throttlingBurstLimit: props.throttlingBurstLimit,
            },
        });

        // =================================================================
        // Request Validator — Validate body on POST /invoke
        // =================================================================
        const requestValidator = new apigateway.RequestValidator(this, 'InvokeRequestValidator', {
            restApi: this.api,
            requestValidatorName: `${namePrefix}-invoke-validator`,
            validateRequestBody: true,
            validateRequestParameters: false,
        });

        // Define request model for the invoke endpoint
        const invokeModel = this.api.addModel('InvokeRequestModel', {
            contentType: 'application/json',
            modelName: 'InvokeRequest',
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ['prompt'],
                properties: {
                    prompt: {
                        type: apigateway.JsonSchemaType.STRING,
                        minLength: 1,
                        maxLength: 10000,
                        description: 'The user prompt to send to the Bedrock Agent',
                    },
                    sessionId: {
                        type: apigateway.JsonSchemaType.STRING,
                        description: 'Optional session ID for conversation continuity',
                    },
                },
            },
        });

        // =================================================================
        // POST /invoke — Invoke the agent
        // =================================================================
        const invokeResource = this.api.root.addResource('invoke');
        invokeResource.addMethod('POST', new apigateway.LambdaIntegration(this.invokeFunction), {
            apiKeyRequired: props.enableApiKey,
            requestValidator,
            requestModels: {
                'application/json': invokeModel,
            },
            methodResponses: [
                { statusCode: '200' },
                { statusCode: '400' },
                { statusCode: '500' },
            ],
        });

        // =================================================================
        // API Key + Usage Plan (throttling + quota)
        //
        // Gap S2 — The key value is generated by Secrets Manager and injected
        // into CfnApiKey via a CloudFormation dynamic reference
        // ({{resolve:secretsmanager:...}}). This is the only CDK pattern that
        // lets you both SET a known API key value AND read it back at runtime.
        //
        // The BFF proxy (public-api) reads the secret via the EC2 instance
        // profile at startup — no static key distribution to the browser.
        // =================================================================
        if (props.enableApiKey) {
            // Generate and store the API key value in Secrets Manager.
            // Plain string secret (no generateStringKey) — raw password only.
            const apiKeySecret = new secretsmanager.Secret(this, 'AgentApiKeySecret', {
                secretName: `${namePrefix}/bedrock-api-key`,
                description: `Bedrock chatbot API key for ${namePrefix} BFF proxy`,
                generateSecretString: {
                    // Exclude chars that could cause issues in HTTP headers
                    excludeCharacters: ' !"#$%&\'()*+,/:;<=>?@[\\]^`{|}~',
                    passwordLength: 40,
                },
            });
            apiKeySecret.applyRemovalPolicy(props.removalPolicy);

            NagSuppressions.addResourceSuppressions(
                apiKeySecret,
                [{ id: 'AwsSolutions-SMG4', reason: 'API key secret is statically mapped to CfnApiKey; automatic rotation would break API Gateway mapping without custom Lambdas' }],
            );

            // CfnApiKey resolves the CF dynamic reference at deploy time.
            // apigateway.ApiKey (L2) does not support setting an explicit value,
            // so we drop to L1 here and create an L2 shim for the usage plan.
            const cfnApiKey = new apigateway.CfnApiKey(this, 'AgentApiKeyResource', {
                name: `${namePrefix}-agent-api-key`,
                description: `API Key for ${namePrefix} Bedrock Agent API (managed by Secrets Manager)`,
                enabled: true,
                value: apiKeySecret.secretValue.unsafeUnwrap(),
            });

            // L2 shim — required by UsagePlan.addApiKey()
            this.apiKey = apigateway.ApiKey.fromApiKeyId(this, 'AgentApiKeyL2', cfnApiKey.ref);
            // readonly is assignable in the constructor
            this.apiKeySecretArn = apiKeySecret.secretArn;

            const usagePlan = this.api.addUsagePlan('AgentUsagePlan', {
                name: `${namePrefix}-usage-plan`,
                description: `Usage plan for ${namePrefix} Bedrock Agent API`,
                throttle: {
                    rateLimit: props.throttlingRateLimit,
                    burstLimit: props.throttlingBurstLimit,
                },
                quota: {
                    limit: 10000,
                    period: apigateway.Period.MONTH,
                },
            });

            usagePlan.addApiKey(this.apiKey);
            usagePlan.addApiStage({
                stage: this.api.deploymentStage,
            });

            // Export secret ARN to SSM — consumed by deploy.py to populate
            // the public-api ConfigMap with BEDROCK_API_KEY_SECRET_ARN.
            new ssm.StringParameter(this, 'ApiKeySecretArnParam', {
                parameterName: `/${namePrefix}/bedrock-api-key-secret-arn`,
                stringValue: apiKeySecret.secretArn,
                description: `Secrets Manager ARN for the Bedrock chatbot API key (${namePrefix})`,
                tier: ssm.ParameterTier.STANDARD,
            });
        }

        this.apiUrl = this.api.url;

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================

        // APIG2: Request validation IS enabled via requestValidator + model
        // on POST /invoke (lines above). CDK Nag requires it set at the API
        // level as a default; suppress since it is explicitly wired per-method.
        NagSuppressions.addResourceSuppressions(
            this.api,
            [{ id: 'AwsSolutions-APIG2', reason: 'Request validation is configured per-method with RequestValidator and InvokeRequestModel on POST /invoke' }],
            true,
        );

        // APIG4 + COG4: This API uses API Key authentication with Usage Plan
        // throttling — Cognito authorizer is not applicable for this
        // machine-to-machine integration pattern.
        NagSuppressions.addResourceSuppressions(
            invokeResource,
            [
                { id: 'AwsSolutions-APIG4', reason: 'API uses API Key authentication with Usage Plan throttling; Cognito not applicable for M2M integration' },
                { id: 'AwsSolutions-COG4', reason: 'API uses API Key authentication; Cognito user pool authorizer not applicable for M2M integration' },
            ],
            true,
        );

        // APIG3: WAF deferred — Gap S1 in implementation plan.
        // API key is now managed via Secrets Manager (Gap S2) and the endpoint
        // is BFF-only (no browser CORS), significantly reducing the attack surface.
        // WAFv2 REGIONAL WebACL should be added in a follow-up PR.
        NagSuppressions.addResourceSuppressions(
            this.api.deploymentStage,
            [{ id: 'AwsSolutions-APIG3', reason: 'WAFv2 deferred (Gap S1). Endpoint is BFF-only with Secrets Manager-managed API key — see implementation_plan_ChatBot.md S1' }],
            true,
        );

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'ApiUrlParam', {
            parameterName: `/${namePrefix}/api-url`,
            stringValue: this.api.url,
            description: `API Gateway URL for ${namePrefix} agent`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: this.api.url,
            description: 'API Gateway URL',
        });

        new cdk.CfnOutput(this, 'ApiId', {
            value: this.api.restApiId,
            description: 'API Gateway REST API ID',
        });
    }
}
