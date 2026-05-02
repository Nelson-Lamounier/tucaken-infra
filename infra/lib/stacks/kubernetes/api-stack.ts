/** @format */

/**
 * NextJS API Stack — Email Subscriptions Only
 *
 * Serverless API Gateway with Lambda functions for email subscriptions.
 *
 * Architecture:
 * Client -> API Gateway -> Lambda -> DynamoDB/SES
 *
 * NOTE: Article endpoints were removed — articles are served directly by
 * the ECS container via SSR → DynamoDB (see compute-stack.ts + application-stack.ts).
 *
 * This stack creates:
 * - API Gateway REST API with CloudWatch logging
 * - Lambda functions for email subscriptions (subscribe + verify)
 * - Per-function Dead Letter Queues
 * - DLQ CloudWatch Alarms with SNS notification
 * - Regional WAF protection
 * - SSM parameter for API URL discovery Lambda to access DynamoDB, S3, and SES
 * - CloudWatch Log Groups with retention policies
 * - CloudWatch Alarms on DLQs with SNS email notifications
 * - CORS configuration for frontend integration
 *
 * Configuration comes from centralized lib/config/nextjs/ - no hard-coded values.
 */

import { NagSuppressions } from 'cdk-nag';

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import {
    Environment,
} from '../../config/environments';
import {
    getNextJsAllocations,
    getNextJsConfigs,
} from '../../config/nextjs';
import { nextjsSsmPaths } from '../../config/ssm-paths';
import { LambdaFunctionConstruct } from '../../constructs/compute/constructs/lambda-function';
import { ApiGatewayConstruct } from '../../constructs/networking/api/api-gateway';
import { buildWafRules } from '../../constructs/security/waf-rules';

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Props for WebappApiStack
 */
export interface NextJsApiStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /** Project name @default 'nextjs' */
    readonly projectName?: string;

    /**
     * SSM parameter path for DynamoDB table name.
     * Points to the Bedrock AiContentStack's content table.
     * @example '/bedrock-dev/content-table-name'
     */
    readonly tableSsmPath: string;

    /**
     * SSM parameter path for S3 assets bucket name
     * @example '/nextjs/development/assets-bucket-name'
     */
    readonly bucketSsmPath: string;

    /** Name prefix for resources */
    readonly namePrefix?: string;

    /**
     * Skip creating the REGIONAL WAF WebACL.
     * Set to true when CloudFront WAF is protecting this API.
     * @default false
     */
    readonly skipWaf?: boolean;

    /**
     * SSM parameter prefix (e.g. '/k8s/development').
     * Used to read `{ssmPrefix}/ops-email` for DLQ alarm SNS subscription
     * when `notificationEmail` is not explicitly provided.
     */
    readonly ssmPrefix: string;

    // ==========================================================================
    // EMAIL SUBSCRIPTION CONFIGURATION
    // ==========================================================================

    /**
     * Owner email address for receiving subscription notifications.
     * When provided, overrides the `{ssmPrefix}/ops-email` SSM parameter.
     * Must be SES-verified in sandbox mode.
     * @example 'nelson@nelsonlamounier.com'
     */
    readonly notificationEmail?: string;

    /**
     * SES sender email address (the "from" address).
     * Must be SES-verified.
     * @example 'noreply@nelsonlamounier.com'
     */
    readonly sesFromEmail?: string;

    /**
     * Base URL for email verification links.
     * Should point to the API Gateway /subscriptions/verify endpoint.
     * @example 'https://api.dev.nelsonlamounier.com/subscriptions/verify'
     */
    readonly verificationBaseUrl?: string;

    /**
     * HMAC secret for generating verification tokens.
     * Should be stored in SSM/Secrets Manager in production.
     * @default 'default-dev-secret' (development only)
     */
    readonly verificationSecret?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * WebappApiStack - Serverless API for portfolio webapp
 *
 * Uses centralized configuration from lib/config/nextjs/:
 * - Allocations: Lambda memory, reserved concurrency
 * - Configurations: Throttling, CORS, timeouts, log retention
 *
 * Endpoints:
 * - GET  /articles           - List published articles
 * - GET  /articles/{slug}    - Get article by slug
 * - POST /subscriptions      - Create email subscription
 * - GET  /subscriptions/verify - Verify email subscription
 *
 * @example
 * ```typescript
 * const apiStack = new WebappApiStack(app, 'NextJS-ApiStack-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     tableSsmPath: '/bedrock-dev/content-table-name',
 *     bucketSsmPath: '/nextjs/development/assets-bucket-name',
 *     notificationEmail: 'nelson@example.com',
 *     sesFromEmail: 'noreply@example.com',
 * });
 * ```
 */
export class NextJsApiStack extends cdk.Stack {
    /** The API Gateway construct */
    public readonly api: ApiGatewayConstruct;

    /** Dead Letter Queue for failed Lambda invocations (per-function) */
    public readonly lambdaDlqs: Record<string, sqs.Queue>;

    /** WAF WebACL for API protection */
    public readonly webAcl?: wafv2.CfnWebACL;

    /** Target environment */
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: NextJsApiStackProps) {
        super(scope, id, {
            ...props,
            description: `Subscriptions API for ${props.projectName ?? 'nextjs'} portfolio`,
        });

        this.targetEnvironment = props.targetEnvironment;
        const projectName = props.projectName ?? 'nextjs';
        const namePrefix = props.namePrefix ?? projectName;
        const envName = props.targetEnvironment;
        const ssmPaths = nextjsSsmPaths(props.targetEnvironment, namePrefix);

        // =====================================================================
        // CENTRALIZED CONFIGURATION
        // =====================================================================

        // Get all config from centralized lib/config/nextjs/
        const allocations = getNextJsAllocations(props.targetEnvironment);
        const configs = getNextJsConfigs(props.targetEnvironment);

        // =====================================================================
        // SSM-BASED DISCOVERY (Decoupled from Data Stack)
        // Reads table/bucket names from SSM instead of direct cross-stack
        // references, preventing CloudFormation export lock-in.
        // =====================================================================
        const tableName = ssm.StringParameter.valueForStringParameter(
            this, props.tableSsmPath,
        );
        const table = dynamodb.Table.fromTableName(this, 'ImportedTable', tableName);

        const _bucketName = ssm.StringParameter.valueForStringParameter(
            this, props.bucketSsmPath,
        );

        // =====================================================================
        // PER-FUNCTION DEAD LETTER QUEUES
        // Each Lambda gets its own DLQ for clear failure attribution.
        // Retention is env-driven (7d dev / 14d prod).
        // =====================================================================
        this.lambdaDlqs = {
            subscribe: this.createLambdaDlq('SubscribeDlq', configs),
            verify: this.createLambdaDlq('VerifyDlq', configs),
        };

        // =====================================================================
        // DLQ CLOUDWATCH ALARMS
        // One alarm per DLQ — triggers when any message lands in the queue.
        // Uses 5-min period (cheapest standard resolution) with SNS email
        // notification. Total cost: ~$0.40/month for 4 alarms.
        // =====================================================================
        const dlqAlarmTopic = new sns.Topic(this, 'DlqAlarmTopic', {
            displayName: `${namePrefix} API DLQ Alerts (${envName})`,
        });

        const dlqAlarmEmail: string =
            props.notificationEmail ||
            ssm.StringParameter.valueForStringParameter(this, `${props.ssmPrefix}/ops-email`);

        dlqAlarmTopic.addSubscription(
            new sns_subscriptions.EmailSubscription(dlqAlarmEmail),
        );

        // Suppress cdk-nag: SNS topic uses default encryption (acceptable for
        // alarm notifications which contain no sensitive data)
        NagSuppressions.addResourceSuppressions(
            dlqAlarmTopic,
            [{ id: 'AwsSolutions-SNS2', reason: 'Alarm notification topic — no sensitive data, default encryption sufficient' }],
        );
        NagSuppressions.addResourceSuppressions(
            dlqAlarmTopic,
            [{ id: 'AwsSolutions-SNS3', reason: 'Alarm notification topic — enforceSSL not required for email-only delivery' }],
        );

        for (const [name, dlq] of Object.entries(this.lambdaDlqs)) {
            const alarm = new cloudwatch.Alarm(this, `${name}DlqAlarm`, {
                alarmDescription: `Messages in ${name} DLQ — Lambda failures need investigation`,
                metric: dlq.metricApproximateNumberOfMessagesVisible({
                    period: cdk.Duration.minutes(5),
                    statistic: 'Maximum',
                }),
                threshold: 1,
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            alarm.addAlarmAction(new cloudwatch_actions.SnsAction(dlqAlarmTopic));
            alarm.addOkAction(new cloudwatch_actions.SnsAction(dlqAlarmTopic));
        }

        // =====================================================================
        // API GATEWAY
        // =====================================================================
        this.api = new ApiGatewayConstruct(this, 'ArticlesApi', {
            apiName: 'portfolio-api',
            environment: props.targetEnvironment,
            description: `Portfolio API for ${projectName} (subscriptions)`,
            namePrefix,

            // From centralized config
            cors: configs.cors,
            throttle: configs.apiGateway.throttle,
            stageName: configs.apiGateway.stageName,
            enableLogging: true,
            logRetention: configs.lambda.logRetention,
            enableTracing: configs.apiGateway.enableTracing,
            enableDetailedMetrics: configs.apiGateway.enableDetailedMetrics,
            enableLogEncryption: configs.apiGateway.enableLogEncryption,
            removalPolicy: configs.removalPolicy,
        });


        // =====================================================================
        // WAF WEBACL
        // Always created unless skipWaf is set (e.g. when CloudFront WAF
        // already protects this API). Uses shared rule builder.
        // =====================================================================
        if (!props.skipWaf) {
            this.webAcl = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
                name: `${namePrefix}-api-waf-${envName}`,
                defaultAction: { allow: {} },
                scope: 'REGIONAL',
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: `${namePrefix}-api-waf-${envName}`,
                    sampledRequestsEnabled: true,
                },
                rules: buildWafRules({
                    envName,
                    namePrefix,
                    // No SizeRestrictions_BODY exclusion for API (unlike CloudFront)
                    commonRuleExclusions: [],
                }),
            });

            // Associate WAF with API Gateway stage
            new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
                resourceArn: this.api.api.deploymentStage.stageArn,
                webAclArn: this.webAcl.attrArn,
            });
        } else {
            // WAF intentionally skipped — API is protected by CloudFront edge WAF
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                `/${this.stackName}/ArticlesApi/RestApi/DeploymentStage.api/Resource`,
                [{ id: 'AwsSolutions-APIG3', reason: 'Regional WAF skipped — API is protected by CloudFront edge WAF (AwsSolutions-APIG3)' }],
            );
        }

        // =================================================================
        // KMS DECRYPT GRANT (customer-managed encryption — production only)
        //
        // Table.fromTableName() creates an unencrypted reference — so
        // grantReadWriteData() only grants DynamoDB actions, NOT kms:Decrypt.
        // In production the table uses a customer-managed KMS key, so we
        // must read the key ARN from SSM and grant encrypt/decrypt explicitly.
        //
        // In non-production, DynamoDB uses AWS-managed encryption (no CMK),
        // so the SSM parameter doesn't exist and no explicit grant is needed.
        // =================================================================
        const isProduction = configs.isProduction;
        let dynamoKmsKey: kms.IKey | undefined;

        if (isProduction) {
            const kmsKeyArnParam = ssm.StringParameter.valueForStringParameter(
                this, ssmPaths.dynamodbKmsKeyArn,
            );
            dynamoKmsKey = kms.Key.fromKeyArn(this, 'ImportedDynamoKmsKey', kmsKeyArnParam);
        }

        // =====================================================================
        // LAMBDA FUNCTIONS - EMAIL SUBSCRIPTIONS
        // =====================================================================

        // Email configuration with sensible defaults for development
        const notificationEmail = props.notificationEmail ?? 'owner@example.com';
        const sesFromEmail = props.sesFromEmail ?? 'noreply@example.com';

        // HMAC secret — production MUST provide a real secret.
        // The dev fallback is acceptable for sandbox/testing only.
        if (configs.isProduction && !props.verificationSecret) {
            throw new Error(
                'verificationSecret is required in production — ' +
                'HMAC tokens would be signed with a known default'
            );
        }
        // TODO: Migrate to Secrets Manager once LambdaFunctionConstruct supports secrets injection
        const verificationSecret = props.verificationSecret ?? 'default-dev-secret';

        // Build subscription environment variables
        // If verificationBaseUrl is provided explicitly, use it.
        // Otherwise, the Lambda will construct it at runtime from API_BASE_URL.
        const subscriptionEnvVars: Record<string, string> = {
            TABLE_NAME: tableName,
            NOTIFICATION_EMAIL: notificationEmail,
            SES_FROM_EMAIL: sesFromEmail,
            VERIFICATION_SECRET: verificationSecret,
            ENVIRONMENT: props.targetEnvironment,
            LOG_LEVEL: configs.lambda.logLevel,
        };

        if (props.verificationBaseUrl) {
            subscriptionEnvVars.VERIFICATION_BASE_URL = props.verificationBaseUrl;
        }

        // Subscribe Lambda (handles POST /subscriptions)
        const subscribeLambda = new LambdaFunctionConstruct(this, 'SubscribeLambda', {
            functionName: `${namePrefix}-subscribe-${props.targetEnvironment}`,
            description: 'Create email subscription with double opt-in verification',
            entry: 'lambda/subscriptions/subscribe.ts',
            handler: 'handler',
            timeout: configs.lambda.timeout,
            memorySize: allocations.lambda.memoryMiB,
            reservedConcurrentExecutions: allocations.lambda.reservedConcurrency,
            logRetention: configs.lambda.logRetention,
            namePrefix,
            environment: subscriptionEnvVars,
            deadLetterQueue: this.lambdaDlqs.subscribe,
        });

        // Verify Lambda (handles GET /subscriptions/verify)
        const verifyLambda = new LambdaFunctionConstruct(this, 'VerifyLambda', {
            functionName: `${namePrefix}-verify-subscription-${props.targetEnvironment}`,
            description: 'Verify email subscription via double opt-in token',
            entry: 'lambda/subscriptions/verify.ts',
            handler: 'handler',
            timeout: configs.lambda.timeout,
            memorySize: allocations.lambda.memoryMiB,
            reservedConcurrentExecutions: allocations.lambda.reservedConcurrency,
            logRetention: configs.lambda.logRetention,
            namePrefix,
            environment: {
                TABLE_NAME: tableName,
                VERIFICATION_SECRET: verificationSecret,
                ENVIRONMENT: props.targetEnvironment,
                LOG_LEVEL: configs.lambda.logLevel,
            },
            deadLetterQueue: this.lambdaDlqs.verify,
        });

        // Grant DynamoDB access
        table.grantReadWriteData(subscribeLambda.function);
        table.grantReadWriteData(verifyLambda.function);

        // KMS grants for subscription Lambdas (read-write needs encrypt + decrypt)
        // Table.fromTableName() doesn't propagate encryption key, so explicit grant needed.
        // Only needed in production where customer-managed KMS is used.
        if (dynamoKmsKey) {
            dynamoKmsKey.grantEncryptDecrypt(subscribeLambda.function);
            dynamoKmsKey.grantEncryptDecrypt(verifyLambda.function);
        }

        // Grant SES SendEmail permission — scoped to the verified sender identity
        subscribeLambda.function.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ses:SendEmail', 'ses:SendRawEmail'],
                resources: [
                    `arn:aws:ses:${this.region}:${this.account}:identity/${sesFromEmail}`,
                ],
            }),
        );

        // =====================================================================
        // API ROUTES
        // =====================================================================

        // --- Subscription request model (JSON Schema validation) ---
        // API Gateway rejects malformed payloads before they reach Lambda,
        // reducing invocation costs and attack surface.
        const subscriptionModel = this.api.api.addModel('SubscriptionModel', {
            contentType: 'application/json',
            modelName: 'SubscriptionRequest',
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ['email'],
                properties: {
                    email: { type: apigateway.JsonSchemaType.STRING },
                    name: { type: apigateway.JsonSchemaType.STRING, minLength: 1, maxLength: 100 },
                    source: { type: apigateway.JsonSchemaType.STRING, minLength: 1, maxLength: 50 },
                },
                additionalProperties: false,
            },
        });


        // --- Email Subscriptions ---
        // POST /subscriptions - Create email subscription (with request body validation)
        const subscribeMethod = this.api.addLambdaIntegration('POST', '/subscriptions', subscribeLambda.function, {
            requestModels: { 'application/json': subscriptionModel },
        });

        // GET /subscriptions/verify - Verify email subscription
        const verifyMethod = this.api.addLambdaIntegration('GET', '/subscriptions/verify', verifyLambda.function);

        // =====================================================================
        // CDK-NAG SUPPRESSIONS
        // =====================================================================
        const subscriptionApiReason = 'Public subscription endpoint - email verification provides security via HMAC token';

        NagSuppressions.addResourceSuppressions(
            subscribeMethod,
            [
                { id: 'AwsSolutions-APIG4', reason: subscriptionApiReason },
                { id: 'AwsSolutions-COG4', reason: subscriptionApiReason },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            verifyMethod,
            [
                { id: 'AwsSolutions-APIG4', reason: subscriptionApiReason },
                { id: 'AwsSolutions-COG4', reason: subscriptionApiReason },
            ],
            true
        );

        // Suppress CKV_AWS_59: Public portfolio API — no authorizer needed.
        // Same rationale as AwsSolutions-APIG4/COG4 suppressions above.
        for (const method of [subscribeMethod, verifyMethod]) {
            const cfnMethod = method.node.defaultChild as cdk.CfnResource;
            cfnMethod.addMetadata('checkov', {
                skip: [{
                    id: 'CKV_AWS_59',
                    comment: 'Public portfolio API — endpoints serve public content, WAF provides protection',
                }],
            });
        }

        // SES permissions are now scoped to specific identity — no IAM5 suppression needed

        // =====================================================================
        // STACK OUTPUTS
        // =====================================================================
        const exportPrefix = `${props.targetEnvironment}-${projectName}`;

        new cdk.CfnOutput(this, 'ApiUrl', {
            value: this.api.url,
            description: 'API Gateway URL',
            exportName: `${exportPrefix}-api-url`,
        });

        new cdk.CfnOutput(this, 'ApiId', {
            value: this.api.api.restApiId,
            description: 'API Gateway ID',
            exportName: `${exportPrefix}-api-id`,
        });

        new cdk.CfnOutput(this, 'SubscribeEndpoint', {
            value: `${this.api.url}subscriptions`,
            description: 'Email subscription endpoint (POST)',
        });

        new cdk.CfnOutput(this, 'VerifyEndpoint', {
            value: `${this.api.url}subscriptions/verify`,
            description: 'Email verification endpoint (GET)',
        });

        // =====================================================================
        // SSM PARAMETER — API GATEWAY URL
        // Publishes the API URL to SSM for cross-stack discovery,
        // consistent with the data-stack SSM pattern.
        // =====================================================================
        const ssmWriterPolicy = cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
                resources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPaths.apiGatewayUrl}`,
                ],
            }),
        ]);
        this.createSsmParameter(
            'ApiGatewayUrlParam',
            ssmPaths.apiGatewayUrl,
            this.api.url,
            'API Gateway URL for cross-stack discovery',
            ssmWriterPolicy,
        );

        // Suppress cdk-nag for AwsCustomResource Lambda (SSM parameter writer)
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Lambda runtime is managed by CDK AwsCustomResource and cannot be configured',
                },
            ],
        );
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Creates a per-function Dead Letter Queue.
     *
     * No hardcoded queueName — CloudFormation generates a unique name from
     * the logical ID, preventing 'already exists' collisions on stack
     * rollback/re-creation (especially with RemovalPolicy.RETAIN).
     */
    private createLambdaDlq(
        id: string,
        configs: { dlq: { retentionPeriod: cdk.Duration }; removalPolicy: cdk.RemovalPolicy },
    ): sqs.Queue {
        return new sqs.Queue(this, id, {
            encryption: sqs.QueueEncryption.KMS_MANAGED,
            enforceSSL: true,
            retentionPeriod: configs.dlq.retentionPeriod,
            removalPolicy: configs.removalPolicy,
        });
    }

    /**
     * Creates an SSM parameter via AwsCustomResource with idempotent put/delete.
     * Same pattern as data-stack.
     */
    private createSsmParameter(
        id: string,
        parameterName: string,
        value: string,
        description: string,
        policy: cr.AwsCustomResourcePolicy,
    ): void {
        new cr.AwsCustomResource(this, id, {
            onUpdate: {
                service: 'SSM',
                action: 'putParameter',
                parameters: {
                    Name: parameterName,
                    Value: value,
                    Type: 'String',
                    Description: description,
                    Overwrite: true,
                },
                physicalResourceId: cr.PhysicalResourceId.of(parameterName),
            },
            onDelete: {
                service: 'SSM',
                action: 'deleteParameter',
                parameters: { Name: parameterName },
            },
            policy,
        });
    }
}




