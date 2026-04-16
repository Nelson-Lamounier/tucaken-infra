/**
 * @format
 * Self-Healing Agent Stack
 *
 * Creates the Self-Healing Agent Lambda — a TypeScript function using the
 * Bedrock ConverseCommand API with a native MCP tool-use loop.
 *
 * Resources:
 * - NodejsFunction (esbuild-bundled TypeScript handler)
 * - SQS FIFO queue (rate limiter between EventBridge and Lambda)
 * - SQS Dead Letter Queue (FIFO — captures failed deliveries)
 * - DynamoDB tables (deduplication + remediation outcome tracking)
 * - IAM policy for Bedrock model invocation
 * - EventBridge rule (scoped CloudWatch Alarm → SQS FIFO → Lambda trigger)
 * - CloudWatch log group + monthly token budget alarm
 * - SSM parameters for cross-stack discovery
 * - SSM Parameter Store for system prompt (secure storage)
 */

import * as path from 'node:path';

import { NagSuppressions } from 'cdk-nag';

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for SelfHealingAgentStack
 */
export interface SelfHealingAgentStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'self-healing-dev') */
    readonly namePrefix: string;
    /** Lambda memory in MB */
    readonly lambdaMemoryMb: number;
    /** Lambda timeout in seconds */
    readonly lambdaTimeoutSeconds: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Bedrock foundation model ID */
    readonly foundationModel: string;
    /** Whether agent runs in dry-run mode (propose but do not execute) */
    readonly enableDryRun: boolean;
    /** System prompt content — stored in SSM at deploy time */
    readonly systemPrompt: string;
    /** SSM path where the system prompt is stored (Lambda reads at cold start) */
    readonly systemPromptSsmPath: string;
    /** AgentCore Gateway URL (resolved from SSM in factory) */
    readonly gatewayUrl: string;
    /** DLQ message retention in days */
    readonly dlqRetentionDays: number;
    /** Reserved concurrent executions for cost control */
    readonly reservedConcurrency?: number;
    /** Maximum tokens per hour before alarm fires (FinOps guardrail) */
    readonly tokenBudgetPerHour?: number;
    /** Cognito OAuth2 token endpoint for client credentials flow */
    readonly cognitoTokenEndpoint: string;
    /** Cognito User Pool ID (for retrieving client secret at runtime) */
    readonly cognitoUserPoolId: string;
    /** Cognito User Pool Client ID for M2M auth */
    readonly cognitoClientId: string;
    /** OAuth2 scope strings (space-separated) for client credentials flow */
    readonly cognitoScopes: string;
    /** Email address for SNS remediation report notifications */
    readonly notificationEmail?: string;
    /** Retention in days for S3 session memory objects */
    readonly memoryRetentionDays?: number;
    /** Monthly token budget for Bedrock cost alarm (default: 500,000) */
    readonly monthlyTokenBudget?: number;
    /** Application Inference Profile ARN for FinOps cost attribution */
    readonly inferenceProfileArn: string;
}

/**
 * Agent Stack for Self-Healing Pipeline.
 *
 * Creates a TypeScript Lambda function using the Bedrock ConverseCommand
 * API with a native tool-use loop. When triggered by scoped CloudWatch
 * Alarms, the agent reasons about the failure, discovers available tools
 * via MCP, and orchestrates remediation.
 */
export class SelfHealingAgentStack extends cdk.Stack {
    /** The Self-Healing Agent Lambda function */
    public readonly agentFunction: lambdaNode.NodejsFunction;

    /** SQS FIFO queue for rate-limiting alarm triggers (SH-S6) */
    public readonly triggerQueue: sqs.Queue;

    /** Dead Letter Queue for failed agent invocations */
    public readonly agentDlq: sqs.Queue;

    /** SNS topic for remediation report notifications */
    public readonly reportsTopic: sns.Topic;

    /** S3 bucket for conversation session memory */
    public readonly memoryBucket: s3.Bucket;

    /** DynamoDB table for cross-container deduplication (SH-S4) */
    public readonly dedupTable: dynamodb.Table;

    /** DynamoDB table for remediation outcome tracking (SH-R5) */
    public readonly outcomesTable: dynamodb.Table;

    constructor(scope: Construct, id: string, props: SelfHealingAgentStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // CloudWatch Log Group — Agent Lambda
        // =================================================================
        const logGroup = new logs.LogGroup(this, 'AgentLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-agent`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // SQS — Dead Letter Queue (FIFO)
        //
        // FIFO DLQ paired with the trigger queue. Captures messages that
        // exceed the redrive count without successful processing.
        // =================================================================
        this.agentDlq = new sqs.Queue(this, 'AgentTriggerDlq', {
            queueName: `${namePrefix}-agent-trigger-dlq.fifo`,
            fifo: true,
            retentionPeriod: cdk.Duration.days(props.dlqRetentionDays),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // SQS — Lambda Dead Letter Queue (Standard)
        //
        // Lambda DLQ must be Standard — Lambda does not support FIFO queues
        // as a dead-letter target (AWS limitation). The FIFO agentDlq above
        // serves the trigger queue's redrive policy; this Standard queue
        // captures any async Lambda invocation failures independently.
        // =================================================================
        const agentLambdaDlq = new sqs.Queue(this, 'AgentLambdaDlq', {
            queueName: `${namePrefix}-agent-lambda-dlq`,
            retentionPeriod: cdk.Duration.days(props.dlqRetentionDays),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // SQS — FIFO Trigger Queue (SH-S6: Rate Limiting)
        //
        // Absorbs alarm storms by serialising events for the SAME alarm
        // (messageGroupId = alarmName) while allowing different alarms to
        // process in parallel. Content-based dedup provides a 5-minute
        // deduplication window, replacing in-memory dedup.
        // =================================================================
        this.triggerQueue = new sqs.Queue(this, 'AgentTriggerQueue', {
            queueName: `${namePrefix}-agent-trigger.fifo`,
            fifo: true,
            contentBasedDeduplication: true,
            visibilityTimeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds * 2),
            deadLetterQueue: {
                queue: this.agentDlq,
                maxReceiveCount: 3,
            },
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // DynamoDB — Deduplication Table (SH-S4)
        //
        // Cross-container deduplication with TTL. Events are de-duped by
        // alarmName#eventTime key. Falls back gracefully if DDB is slow.
        // =================================================================
        this.dedupTable = new dynamodb.Table(this, 'DedupTable', {
            tableName: `${namePrefix}-agent-dedup`,
            partitionKey: { name: 'dedupKey', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: props.removalPolicy,
            pointInTimeRecovery: false,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
        });

        // =================================================================
        // DynamoDB — Remediation Outcomes (SH-R5)
        //
        // Tracks invocation → resolution correlation. Written at invocation
        // time, updated when the alarm transitions ALARM → OK.
        // =================================================================
        this.outcomesTable = new dynamodb.Table(this, 'OutcomesTable', {
            tableName: `${namePrefix}-agent-outcomes`,
            partitionKey: { name: 'alarmName', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'correlationId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: props.removalPolicy,
            pointInTimeRecovery: false,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
        });

        // =================================================================
        // SNS — Remediation Report Notifications (SH-S7: Encrypted)
        //
        // Publishes the agent's remediation report after each invocation
        // so the operator receives immediate email visibility.
        // Uses AWS-managed SNS key for at-rest encryption.
        // =================================================================
        this.reportsTopic = new sns.Topic(this, 'ReportsTopic', {
            topicName: `${namePrefix}-agent-reports`,
            displayName: `Self-Healing Agent Reports (${namePrefix})`,
            masterKey: kms.Alias.fromAliasName(this, 'SnsKmsAlias', 'alias/aws/sns'),
        });

        if (props.notificationEmail) {
            this.reportsTopic.addSubscription(
                new sns_subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        // =================================================================
        // S3 — Conversation Session Memory
        //
        // Stores session records (prompt, tools called, outcome) keyed by
        // alarm name. On retry, the agent loads the most recent session to
        // avoid repeating the same remediation.
        // =================================================================
        const memoryRetentionDays = props.memoryRetentionDays ?? 30;

        this.memoryBucket = new s3.Bucket(this, 'MemoryBucket', {
            bucketName: `${namePrefix}-agent-memory-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: props.removalPolicy,
            autoDeleteObjects: props.removalPolicy === cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [{
                id: 'expire-old-sessions',
                expiration: cdk.Duration.days(memoryRetentionDays),
                enabled: true,
            }],
        });

        // =================================================================
        // Lambda — Self-Healing Agent (Bedrock ConverseCommand)
        //
        // TypeScript function using the Bedrock ConverseCommand API
        // with a native tool-use agentic loop. Bundled with esbuild
        // via NodejsFunction, matching the Bedrock publisher pattern.
        // =================================================================
        this.agentFunction = new lambdaNode.NodejsFunction(this, 'AgentFunction', {
            functionName: `${namePrefix}-agent`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'self-healing', 'src', 'index.ts'),
            handler: 'handler',
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            logGroup,
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                GATEWAY_URL: props.gatewayUrl,
                FOUNDATION_MODEL: props.foundationModel,
                INFERENCE_PROFILE_ARN: props.inferenceProfileArn,
                DRY_RUN: props.enableDryRun ? 'true' : 'false',
                SYSTEM_PROMPT_SSM_PATH: props.systemPromptSsmPath,
                COGNITO_TOKEN_ENDPOINT: props.cognitoTokenEndpoint,
                COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
                COGNITO_CLIENT_ID: props.cognitoClientId,
                COGNITO_SCOPES: props.cognitoScopes,
                SNS_TOPIC_ARN: this.reportsTopic.topicArn,
                MEMORY_BUCKET: this.memoryBucket.bucketName,
                DEDUP_TABLE_NAME: this.dedupTable.tableName,
                OUTCOMES_TABLE_NAME: this.outcomesTable.tableName,
            },
            description: `Self-healing remediation agent for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: [
                    // AWS SDK v3 is included in the Lambda runtime
                    '@aws-sdk/*',
                ],
            },
            deadLetterQueue: agentLambdaDlq,
            deadLetterQueueEnabled: true,
            retryAttempts: 2,
            // FinOps: cap parallel Bedrock agent invocations
            ...(props.reservedConcurrency !== undefined
                ? { reservedConcurrentExecutions: props.reservedConcurrency }
                : {}),
        });

        // =================================================================
        // CloudWatch Metric Filters — Token Usage Tracking
        //
        // Extracts inputTokens and outputTokens from the structured JSON
        // logs emitted by the handler. Publishes to custom CloudWatch
        // metrics for FinOps visibility and alarming.
        // =================================================================
        const metricNamespace = `${namePrefix}/SelfHealing`;

        new logs.MetricFilter(this, 'InputTokensMetric', {
            logGroup,
            filterPattern: logs.FilterPattern.exists('$.inputTokens'),
            metricNamespace,
            metricName: 'InputTokens',
            metricValue: '$.inputTokens',
            defaultValue: 0,
        });

        new logs.MetricFilter(this, 'OutputTokensMetric', {
            logGroup,
            filterPattern: logs.FilterPattern.exists('$.outputTokens'),
            metricNamespace,
            metricName: 'OutputTokens',
            metricValue: '$.outputTokens',
            defaultValue: 0,
        });

        // FinOps alarm: total tokens exceeds budget in a 1-hour window
        const tokenBudget = props.tokenBudgetPerHour ?? 100_000;

        new cloudwatch.Alarm(this, 'TokenBudgetAlarm', {
            alarmName: `${namePrefix}-agent-token-budget`,
            alarmDescription:
                `Self-healing agent consumed >${tokenBudget} input tokens in 1 hour. ` +
                'Investigate for runaway agent loops or unexpected alarm storms.',
            metric: new cloudwatch.MathExpression({
                expression: 'inputTokens + outputTokens',
                usingMetrics: {
                    inputTokens: new cloudwatch.Metric({
                        namespace: metricNamespace,
                        metricName: 'InputTokens',
                        statistic: 'Sum',
                        period: cdk.Duration.hours(1),
                    }),
                    outputTokens: new cloudwatch.Metric({
                        namespace: metricNamespace,
                        metricName: 'OutputTokens',
                        statistic: 'Sum',
                        period: cdk.Duration.hours(1),
                    }),
                },
            }),
            threshold: tokenBudget,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // CDK-Nag suppression: NODEJS_22_X is the latest Node.js LTS runtime
        NagSuppressions.addResourceSuppressions(
            this.agentFunction,
            [{ id: 'AwsSolutions-L1', reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime' }],
            true,
        );

        // =================================================================
        // IAM — Bedrock Model Invocation
        //
        // Cross-region inference profiles (eu.anthropic.*) route requests
        // to the underlying foundation model in ANY EU region. IAM must
        // cover both the inference profile and the foundation model.
        // =================================================================
        const baseModelId = props.foundationModel.replace(/^eu\./, '');
        this.agentFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'InvokeBedrockModel',
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
            ],
            resources: [
                // Application Inference Profile (primary invocation target)
                props.inferenceProfileArn,
                // Cross-region inference profile (local region, account-scoped)
                `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${props.foundationModel}`,
                // Foundation model in ANY region (cross-region routing target)
                `arn:aws:bedrock:*::foundation-model/${baseModelId}`,
            ],
        }));

        // =================================================================
        // IAM — Cognito Client Secret Retrieval
        //
        // The agent retrieves the Cognito User Pool Client secret at runtime
        // to obtain a JWT via the client credentials flow for Gateway auth.
        // =================================================================
        if (props.cognitoUserPoolId) {
            this.agentFunction.addToRolePolicy(new iam.PolicyStatement({
                sid: 'DescribeCognitoClient',
                effect: iam.Effect.ALLOW,
                actions: ['cognito-idp:DescribeUserPoolClient'],
                resources: [
                    `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`,
                ],
            }));
        }

        // =================================================================
        // SSM — System Prompt Storage (SH-S1)
        //
        // Stores the system prompt securely in SSM Parameter Store rather
        // than as a plaintext Lambda environment variable. The Lambda reads
        // this at cold start and caches in-memory.
        // =================================================================
        const systemPromptParam = new ssm.StringParameter(this, 'SystemPromptParam', {
            parameterName: props.systemPromptSsmPath,
            stringValue: props.systemPrompt,
            description: `Self-healing agent system prompt for ${namePrefix}`,
            tier: ssm.ParameterTier.ADVANCED,
        });

        systemPromptParam.grantRead(this.agentFunction);

        // Grant Lambda access to DynamoDB tables
        this.dedupTable.grantReadWriteData(this.agentFunction);
        this.outcomesTable.grantReadWriteData(this.agentFunction);

        // =================================================================
        // EventBridge Rule — CloudWatch Alarm → SQS FIFO (SH-S6)
        //
        // Triggers on CloudWatch alarms entering ALARM state, EXCLUDING
        // the agent's own alarms (e.g. token budget) to prevent a
        // self-referential feedback loop.
        //
        // Events are routed through the FIFO queue rather than directly
        // to Lambda, absorbing alarm storms and serialising per-alarm.
        // =================================================================
        const alarmRule = new events.Rule(this, 'AlarmTriggerRule', {
            ruleName: `${namePrefix}-alarm-trigger`,
            description: `Routes CloudWatch Alarm state changes to SQS FIFO for ${namePrefix}`,
            eventPattern: {
                source: ['aws.cloudwatch'],
                detailType: ['CloudWatch Alarm State Change'],
                detail: {
                    state: {
                        value: ['ALARM'],
                    },
                    alarmName: [{
                        'anything-but': { prefix: `${namePrefix}-agent` },
                    }],
                },
            },
        });

        alarmRule.addTarget(new targets.SqsQueue(this.triggerQueue, {
            messageGroupId: events.EventField.fromPath('$.detail.alarmName'),
        }));

        // SQS → Lambda event source (batch size 1 for serial processing)
        this.agentFunction.addEventSource(
            new lambdaEventSources.SqsEventSource(this.triggerQueue, {
                batchSize: 1,
                enabled: true,
            }),
        );

        // =================================================================
        // EventBridge Rule — ALARM → OK (SH-R5: Outcome Tracking)
        //
        // When an alarm transitions from ALARM → OK, the outcome tracker
        // correlates this with recent agent invocations to measure
        // remediation effectiveness.
        // =================================================================
        const outcomeTrackerLogGroup = new logs.LogGroup(this, 'OutcomeTrackerLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-outcome-tracker`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        const outcomeTracker = new lambdaNode.NodejsFunction(this, 'OutcomeTracker', {
            functionName: `${namePrefix}-outcome-tracker`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'self-healing', 'src', 'outcome-tracker.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: outcomeTrackerLogGroup,
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                OUTCOMES_TABLE_NAME: this.outcomesTable.tableName,
                METRIC_NAMESPACE: `${namePrefix}/SelfHealing`,
            },
            description: `Tracks remediation outcomes for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        this.outcomesTable.grantReadWriteData(outcomeTracker);
        outcomeTracker.addToRolePolicy(new iam.PolicyStatement({
            sid: 'PutRemediationMetrics',
            effect: iam.Effect.ALLOW,
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'cloudwatch:namespace': `${namePrefix}/SelfHealing`,
                },
            },
        }));

        const okRule = new events.Rule(this, 'AlarmOkRule', {
            ruleName: `${namePrefix}-alarm-ok-trigger`,
            description: `Tracks alarm resolution for remediation outcome correlation (${namePrefix})`,
            eventPattern: {
                source: ['aws.cloudwatch'],
                detailType: ['CloudWatch Alarm State Change'],
                detail: {
                    state: {
                        value: ['OK'],
                    },
                    alarmName: [{
                        'anything-but': { prefix: `${namePrefix}-agent` },
                    }],
                },
            },
        });

        okRule.addTarget(new targets.LambdaFunction(outcomeTracker, {
            retryAttempts: 2,
        }));

        NagSuppressions.addResourceSuppressions(
            outcomeTracker,
            [{ id: 'AwsSolutions-L1', reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime' }],
            true,
        );

        // =================================================================
        // Monthly Token Budget Alarm (SH-C3)
        //
        // Long-horizon cost alarm: fires if cumulative Bedrock token usage
        // exceeds the monthly budget. Complements the hourly alarm.
        // =================================================================
        const monthlyBudget = props.monthlyTokenBudget ?? 500_000;

        new cloudwatch.Alarm(this, 'MonthlyTokenBudgetAlarm', {
            alarmName: `${namePrefix}-agent-monthly-token-budget`,
            alarmDescription:
                `Self-healing agent consumed >${monthlyBudget} tokens in 30 days. ` +
                'Review agent invocation frequency and token efficiency.',
            metric: new cloudwatch.MathExpression({
                expression: 'inputTokens + outputTokens',
                usingMetrics: {
                    inputTokens: new cloudwatch.Metric({
                        namespace: metricNamespace,
                        metricName: 'InputTokens',
                        statistic: 'Sum',
                        period: cdk.Duration.days(30),
                    }),
                    outputTokens: new cloudwatch.Metric({
                        namespace: metricNamespace,
                        metricName: 'OutputTokens',
                        statistic: 'Sum',
                        period: cdk.Duration.days(30),
                    }),
                },
            }),
            threshold: monthlyBudget,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.agentFunction,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Bedrock model invocation requires foundation-model ARN with wildcard region pattern',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            this.reportsTopic,
            [{
                id: 'AwsSolutions-SNS3',
                reason: 'Remediation report topic — enforceSSL not required for email-only delivery',
            }],
            true,
        );

        // Grant Lambda permission to publish to SNS
        this.reportsTopic.grantPublish(this.agentFunction);

        // Grant Lambda read/write access to session memory
        this.memoryBucket.grantReadWrite(this.agentFunction);

        NagSuppressions.addResourceSuppressions(
            this.memoryBucket,
            [{
                id: 'AwsSolutions-S1',
                reason: 'Session memory bucket — internal agent data only, server access logging not required',
            }],
            true,
        );

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'AgentLambdaArnParam', {
            parameterName: `/${namePrefix}/agent-lambda-arn`,
            stringValue: this.agentFunction.functionArn,
            description: `Self-healing Agent Lambda ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentLambdaNameParam', {
            parameterName: `/${namePrefix}/agent-lambda-name`,
            stringValue: this.agentFunction.functionName,
            description: `Self-healing Agent Lambda name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentDlqUrlParam', {
            parameterName: `/${namePrefix}/agent-dlq-url`,
            stringValue: this.agentDlq.queueUrl,
            description: `Agent DLQ URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'TriggerQueueUrlParam', {
            parameterName: `/${namePrefix}/agent-trigger-queue-url`,
            stringValue: this.triggerQueue.queueUrl,
            description: `Agent FIFO trigger queue URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'AgentFunctionArn', {
            value: this.agentFunction.functionArn,
            description: 'Self-healing Agent Lambda ARN',
        });

        new cdk.CfnOutput(this, 'AgentFunctionName', {
            value: this.agentFunction.functionName,
            description: 'Self-healing Agent Lambda name',
        });

        new cdk.CfnOutput(this, 'AgentDlqUrl', {
            value: this.agentDlq.queueUrl,
            description: 'Agent Dead Letter Queue URL',
        });

        new cdk.CfnOutput(this, 'TriggerQueueUrl', {
            value: this.triggerQueue.queueUrl,
            description: 'Agent SQS FIFO trigger queue URL',
        });

        new cdk.CfnOutput(this, 'DryRunEnabled', {
            value: props.enableDryRun ? 'true' : 'false',
            description: 'Whether the agent is in dry-run mode',
        });

        new cdk.CfnOutput(this, 'MemoryBucketName', {
            value: this.memoryBucket.bucketName,
            description: 'S3 bucket for agent conversation memory',
        });

        new cdk.CfnOutput(this, 'ReportsTopicArn', {
            value: this.reportsTopic.topicArn,
            description: 'SNS topic ARN for remediation report notifications',
        });

        new cdk.CfnOutput(this, 'OutcomesTableName', {
            value: this.outcomesTable.tableName,
            description: 'DynamoDB table for remediation outcome tracking',
        });
    }
}
