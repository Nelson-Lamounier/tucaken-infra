/**
 * @format
 * Strategist Pipeline Stack — Iterative Multi-Agent Step Functions Pipeline
 *
 * Creates two Step Functions state machines and 7 Lambda functions
 * for the iterative job strategist pipeline.
 *
 * Architecture:
 *   Admin Dashboard → API Gateway → Trigger Lambda
 *     ↓ operation='analyse'
 *     Analysis State Machine:
 *       → Research Lambda (Haiku 4.5) — KB retrieval, resume, gap analysis
 *       → Strategist Lambda (Sonnet 4.6) — 5-phase XML analysis
 *       → Resume Builder Lambda (Haiku 4.5) — apply suggestions to rebuild resume
 *       → Analysis Persist Lambda — DynamoDB persistence
 *
 *     ↓ operation='coach'
 *     Coaching State Machine:
 *       → Coach Loader Lambda — Load existing analysis from DDB
 *       → Coach Lambda (Haiku 4.5) — Stage-specific interview prep
 *
 * DDB Record Lifecycle:
 *   Iteration 1 (analyse): APPLICATION#slug → METADATA + ANALYSIS#<pipelineId>
 *   Iteration N (coach):   APPLICATION#slug → METADATA update + INTERVIEW#<stage>
 *
 * Observability:
 *   - Per-agent EMF metrics in BedrockMultiAgent namespace
 *   - X-Ray tracing on all Lambdas
 *   - CloudWatch Logs with configurable retention
 *   - Pipeline-level cost metrics
 */

import * as path from 'node:path';


import { NagSuppressions } from 'cdk-nag';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { JsonPath } from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for StrategistPipelineStack.
 */
export interface StrategistPipelineStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Name of the shared S3 assets bucket (from BedrockDataStack) */
    readonly assetsBucketName: string;
    /** DynamoDB table for strategist data (from StrategistDataStack) */
    readonly tableName: string;
    /** Research Agent model ID */
    readonly researchModel: string;
    /** Strategist Agent model ID */
    readonly strategistModel: string;
    /** Strategist maximum output tokens */
    readonly strategistMaxTokens: number;
    /** Strategist thinking budget tokens */
    readonly strategistThinkingBudgetTokens: number;
    /** Interview Coach model ID */
    readonly coachModel: string;
    /** Coach maximum output tokens */
    readonly coachMaxTokens: number;
    /** Coach thinking budget tokens */
    readonly coachThinkingBudgetTokens: number;
    /** Lambda memory in MB for agent functions */
    readonly agentLambdaMemoryMb: number;
    /** Lambda timeout in seconds for agent functions */
    readonly agentLambdaTimeoutSeconds: number;
    /** Lambda memory in MB for the trigger function */
    readonly triggerLambdaMemoryMb: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for ephemeral resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Bedrock Knowledge Base ID (optional) */
    readonly knowledgeBaseId?: string;
    /** Bedrock Knowledge Base ARN for IAM permissions (optional) */
    readonly knowledgeBaseArn?: string;
    /** wiki-mcp base URL for deterministic constraint retrieval (optional) */
    readonly wikiMcpUrl?: string;
    /** SSM SecureString path for wiki-mcp BasicAuth header, e.g. /wiki-mcp/basicauth-header (optional) */
    readonly wikiMcpAuthSsmPath?: string;
    /** Runtime environment name */
    readonly environmentName: string;
    /** Application Inference Profile ARN for Research agent */
    readonly researchProfileArn: string;
    /** Application Inference Profile ARN for Strategist agent */
    readonly strategistProfileArn: string;
    /** Application Inference Profile ARN for Resume Builder agent */
    readonly resumeBuilderProfileArn: string;
    /** Application Inference Profile ARN for Interview Coach agent */
    readonly coachProfileArn: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Iterative Multi-Agent Strategist Pipeline Stack.
 *
 * Creates two independent Step Functions state machines:
 *   1. Analysis Pipeline: Research → Strategist → Persist
 *   2. Coaching Pipeline: Load Analysis → Coach (with DDB write)
 *
 * The trigger Lambda routes to the correct state machine based on
 * the `operation` field in the API request body.
 */
export class StrategistPipelineStack extends cdk.Stack {
    /** Analysis Step Functions state machine */
    public readonly analysisStateMachine: sfn.StateMachine;

    /** Coaching Step Functions state machine */
    public readonly coachingStateMachine: sfn.StateMachine;

    /** Trigger Handler Lambda (API Gateway → Step Functions) */
    public readonly triggerFunction: lambdaNode.NodejsFunction;

    /** Dead Letter Queue for pipeline failures */
    public readonly pipelineDlq: sqs.Queue;

    constructor(scope: Construct, id: string, props: StrategistPipelineStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // Import shared resources
        const assetsBucket = s3.Bucket.fromBucketName(
            this,
            'ImportedAssetsBucket',
            props.assetsBucketName,
        );

        // Use Table.fromTableName (not TableV2) to avoid the `policyResource` deprecation
        // warning emitted by TableV2's grant path when importing by name only.
        const strategistTable = dynamodb.Table.fromTableName(
            this,
            'ImportedStrategistTable',
            props.tableName,
        );

        // =================================================================
        // SQS — Pipeline Dead Letter Queue
        // =================================================================
        this.pipelineDlq = new sqs.Queue(this, 'PipelineDlq', {
            queueName: `${namePrefix}-strategist-dlq`,
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            removalPolicy: props.removalPolicy,
        });

        NagSuppressions.addResourceSuppressions(this.pipelineDlq, [
            {
                id: 'AwsSolutions-SQS3',
                reason: 'This queue IS the dead-letter queue — it does not need its own DLQ',
            },
        ]);

        // =================================================================
        // Lambda entry point path
        // =================================================================
        const handlersDir = path.join(
            __dirname, '..', '..', '..', '..', 'bedrock-applications', 'job-strategist', 'src', 'handlers',
        );

        /** Shared bundling config for all pipeline Lambdas */
        const bundlingConfig: lambdaNode.BundlingOptions = {
            minify: true,
            sourceMap: true,
            externalModules: ['@aws-sdk/*'],
        };

        // =================================================================
        // Lambda — Research Handler (Analysis Pipeline Stage 1)
        // =================================================================
        const researchFn = new lambdaNode.NodejsFunction(this, 'ResearchFunction', {
            functionName: `${namePrefix}-strategist-research`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'research-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                RESEARCH_MODEL: props.researchModel,
                INFERENCE_PROFILE_ARN: props.researchProfileArn,
                ASSETS_BUCKET: assetsBucket.bucketName,
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
                ...(props.knowledgeBaseId ? { KNOWLEDGE_BASE_ID: props.knowledgeBaseId } : {}),
                // wiki-mcp — deterministic constraint retrieval (optional; falls back to Pinecone)
                ...(props.wikiMcpUrl ? { WIKI_MCP_URL: props.wikiMcpUrl } : {}),
                ...(props.wikiMcpAuthSsmPath
                    ? {
                          WIKI_MCP_AUTH: ssm.StringParameter.valueForSecureStringParameter(
                              this,
                              props.wikiMcpAuthSsmPath,
                              1,
                          ),
                      }
                    : {}),
            },
            description: `Strategist Research Agent (${props.researchModel})`,
            logGroup: new logs.LogGroup(this, 'ResearchLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-research`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
            deadLetterQueue: this.pipelineDlq,
        });

        // =================================================================
        // Lambda — Strategist Handler (Analysis Pipeline Stage 2)
        // =================================================================
        const strategistFn = new lambdaNode.NodejsFunction(this, 'StrategistFunction', {
            functionName: `${namePrefix}-strategist-writer`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'strategist-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                STRATEGIST_MODEL: props.strategistModel,
                INFERENCE_PROFILE_ARN: props.strategistProfileArn,
                MAX_TOKENS: String(props.strategistMaxTokens),
                THINKING_BUDGET_TOKENS: String(props.strategistThinkingBudgetTokens),
                ASSETS_BUCKET: assetsBucket.bucketName,
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Strategist Agent (${props.strategistModel})`,
            logGroup: new logs.LogGroup(this, 'StrategistLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-writer`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
            deadLetterQueue: this.pipelineDlq,
        });

        // =================================================================
        // Lambda — Analysis Persist Handler (Analysis Pipeline Stage 4)
        // =================================================================
        const analysisPersistFn = new lambdaNode.NodejsFunction(this, 'AnalysisPersistFunction', {
            functionName: `${namePrefix}-strategist-analysis-persist`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'analysis-persist-handler.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            environment: {
                TABLE_NAME: strategistTable.tableName,
                ASSETS_BUCKET: assetsBucket.bucketName,
                ENVIRONMENT: props.environmentName,
            },
            description: 'Strategist Analysis Persist — DynamoDB writer',
            logGroup: new logs.LogGroup(this, 'AnalysisPersistLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-analysis-persist`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
            deadLetterQueue: this.pipelineDlq,
        });

        // =================================================================
        // Lambda — Coach Loader Handler (Coaching Pipeline Stage 1)
        // =================================================================
        const coachLoaderFn = new lambdaNode.NodejsFunction(this, 'CoachLoaderFunction', {
            functionName: `${namePrefix}-strategist-coach-loader`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'coach-loader-handler.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            environment: {
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: 'Strategist Coach Loader — DDB analysis retrieval',
            logGroup: new logs.LogGroup(this, 'CoachLoaderLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-coach-loader`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
            deadLetterQueue: this.pipelineDlq,
        });

        // =================================================================
        // Lambda — Interview Coach Handler (Coaching Pipeline Stage 2)
        // =================================================================
        const coachFn = new lambdaNode.NodejsFunction(this, 'CoachFunction', {
            functionName: `${namePrefix}-strategist-coach`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'coach-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                COACH_MODEL: props.coachModel,
                INFERENCE_PROFILE_ARN: props.coachProfileArn,
                MAX_TOKENS: String(props.coachMaxTokens),
                THINKING_BUDGET_TOKENS: String(props.coachThinkingBudgetTokens),
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Interview Coach Agent (${props.coachModel})`,
            logGroup: new logs.LogGroup(this, 'CoachLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-coach`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
            deadLetterQueue: this.pipelineDlq,
        });

        // =================================================================
        // IAM — Grant permissions
        // =================================================================

        // Research: S3 read, Bedrock InvokeModel, KB Retrieve, DynamoDB read/write
        assetsBucket.grantRead(researchFn);
        strategistTable.grantWriteData(researchFn);
        researchFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: [
                props.researchProfileArn,
                'arn:aws:bedrock:*::foundation-model/*',
            ],
        }));
        if (props.knowledgeBaseArn) {
            researchFn.addToRolePolicy(new iam.PolicyStatement({
                actions: ['bedrock:Retrieve'],
                resources: [props.knowledgeBaseArn],
            }));
        }

        // Strategist: Bedrock InvokeModel, DynamoDB write (persist analysis)
        strategistFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: [
                props.strategistProfileArn,
                'arn:aws:bedrock:*::foundation-model/*',
            ],
        }));
        strategistTable.grantWriteData(strategistFn);
        assetsBucket.grantWrite(strategistFn); // S3 offload for analysisXml

        // Analysis Persist: DynamoDB read/write + S3 read for analysisXml
        strategistTable.grantReadWriteData(analysisPersistFn);
        assetsBucket.grantRead(analysisPersistFn);

        // =================================================================
        // Lambda — Resume Builder Handler (Analysis Pipeline Stage 3)
        // =================================================================
        const resumeBuilderFn = new lambdaNode.NodejsFunction(this, 'ResumeBuilderFunction', {
            functionName: `${namePrefix}-strategist-resume-builder`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'resume-builder-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                RESUME_BUILDER_MODEL: props.researchModel, // Haiku 4.5 — same tier as research
                INFERENCE_PROFILE_ARN: props.resumeBuilderProfileArn,
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Resume Builder Agent (${props.researchModel})`,
            logGroup: new logs.LogGroup(this, 'ResumeBuilderLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-resume-builder`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
            deadLetterQueue: this.pipelineDlq,
        });

        // Resume Builder: Bedrock InvokeModel, DynamoDB read/write
        resumeBuilderFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: [
                props.resumeBuilderProfileArn,
                'arn:aws:bedrock:*::foundation-model/*',
            ],
        }));
        strategistTable.grantReadWriteData(resumeBuilderFn);

        // Coach Loader: DynamoDB read (query ANALYSIS# records)
        strategistTable.grantReadData(coachLoaderFn);

        // Coach: Bedrock InvokeModel, DynamoDB read/write
        coachFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: [
                props.coachProfileArn,
                'arn:aws:bedrock:*::foundation-model/*',
            ],
        }));
        strategistTable.grantReadWriteData(coachFn);

        // CDK-Nag suppression for NODEJS_22_X
        const allFunctions = [researchFn, strategistFn, resumeBuilderFn, analysisPersistFn, coachLoaderFn, coachFn];
        for (const fn of allFunctions) {
            NagSuppressions.addResourceSuppressions(
                fn,
                [
                    {
                        id: 'AwsSolutions-L1',
                        reason: 'Using NODEJS_22_X — latest Node.js LTS runtime',
                    },
                ],
                true,
            );
        }

        // IAM5 suppression — remaining wildcards from S3 prefix grants
        NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'S3 grants use prefix-scoped wildcards. Bedrock IAM now uses scoped Application Inference Profile ARNs.',
            },
        ]);

        // =================================================================
        // Step Functions — Analysis Pipeline State Machine
        // =================================================================

        const researchTask = new tasks.LambdaInvoke(this, 'ResearchTask', {
            lambdaFunction: researchFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Research Agent: KB retrieval, resume parsing, gap analysis',
        });
        researchTask.addRetry({
            errors: ['ThrottlingException', 'ServiceUnavailableException', 'States.TaskFailed'],
            interval: cdk.Duration.seconds(5),
            maxAttempts: 2,
            backoffRate: 2,
        });

        const strategistTask = new tasks.LambdaInvoke(this, 'StrategistTask', {
            lambdaFunction: strategistFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Strategist Agent: 5-phase XML analysis and document generation',
        });
        strategistTask.addRetry({
            errors: ['ThrottlingException', 'ServiceUnavailableException', 'States.TaskFailed'],
            interval: cdk.Duration.seconds(10),
            maxAttempts: 2,
            backoffRate: 2,
        });

        const resumeBuilderTask = new tasks.LambdaInvoke(this, 'ResumeBuilderTask', {
            lambdaFunction: resumeBuilderFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Resume Builder Agent: apply suggestions to produce tailored resume',
        });

        const analysisPersistTask = new tasks.LambdaInvoke(this, 'AnalysisPersistTask', {
            lambdaFunction: analysisPersistFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Persist analysis results to DynamoDB',
        });

        // =================================================================
        // Error Handling — Analysis SM: DynamoUpdateItem → Fail
        //
        // When any Lambda task fails, the Catch block preserves the
        // original task input (which includes context.applicationSlug)
        // and adds error details at $.error. The DynamoUpdateItem task
        // writes status='failed' to the APPLICATION METADATA record so
        // the frontend can display the failure state.
        // =================================================================

        const analysisFailed = new sfn.Fail(this, 'AnalysisPipelineFailed', {
            error: 'AnalysisPipelineExecutionFailed',
            cause: 'One of the analysis pipeline agents threw an unrecoverable error',
        });

        /** Write status='failed' to DDB before transitioning to Fail state */
        const markAnalysisFailed = new tasks.DynamoUpdateItem(this, 'MarkAnalysisFailed', {
            table: strategistTable,
            key: {
                pk: tasks.DynamoAttributeValue.fromString(
                    JsonPath.format('APPLICATION#{}', JsonPath.stringAt('$.context.applicationSlug')),
                ),
                sk: tasks.DynamoAttributeValue.fromString('METADATA'),
            },
            updateExpression: 'SET #status = :failed, #updatedAt = :now, #errorMessage = :error, #gsi1pk = :gsi1pk, #gsi1sk = :gsi1sk',
            expressionAttributeNames: {
                '#status': 'status',
                '#updatedAt': 'updatedAt',
                '#errorMessage': 'errorMessage',
                '#gsi1pk': 'gsi1pk',
                '#gsi1sk': 'gsi1sk',
            },
            expressionAttributeValues: {
                ':failed': tasks.DynamoAttributeValue.fromString('failed'),
                ':now': tasks.DynamoAttributeValue.fromString(
                    JsonPath.stringAt('$$.State.EnteredTime'),
                ),
                ':error': tasks.DynamoAttributeValue.fromString(
                    JsonPath.stringAt('$.error.Cause'),
                ),
                ':gsi1pk': tasks.DynamoAttributeValue.fromString('APP_STATUS#failed'),
                ':gsi1sk': tasks.DynamoAttributeValue.fromString(
                    JsonPath.format(
                        '{}#{}',
                        JsonPath.arrayGetItem(
                            JsonPath.stringSplit(JsonPath.stringAt('$$.State.EnteredTime'), 'T'),
                            0,
                        ),
                        JsonPath.stringAt('$.context.applicationSlug'),
                    ),
                ),
            },
            resultPath: sfn.JsonPath.DISCARD,
            comment: 'Write status=failed to DynamoDB so frontend can display analysis failure',
        });

        /** Send structured error context to the DLQ before reaching Fail state */
        const sendAnalysisErrorToDlq = new tasks.SqsSendMessage(this, 'SendAnalysisErrorToDlq', {
            queue: this.pipelineDlq,
            messageBody: sfn.TaskInput.fromObject({
                pipeline: 'analysis',
                applicationSlug: JsonPath.stringAt('$.context.applicationSlug'),
                error: JsonPath.stringAt('$.error.Error'),
                cause: JsonPath.stringAt('$.error.Cause'),
                failedAt: JsonPath.stringAt('$$.State.EnteredTime'),
                stateMachine: JsonPath.stringAt('$$.StateMachine.Name'),
                executionId: JsonPath.stringAt('$$.Execution.Name'),
            }),
            comment: 'Forward structured error context to DLQ for operational visibility',
            resultPath: sfn.JsonPath.DISCARD,
        });

        markAnalysisFailed.next(sendAnalysisErrorToDlq).next(analysisFailed);

        // Chain: Research → Strategist → ResumeBuilder → Persist (all catch → MarkFailed → Fail)
        const analysisDefinition = researchTask
            .addCatch(markAnalysisFailed, {
                errors: ['States.ALL'],
                resultPath: '$.error',
            })
            .next(
                strategistTask.addCatch(markAnalysisFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            )
            .next(
                resumeBuilderTask.addCatch(markAnalysisFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            )
            .next(
                analysisPersistTask.addCatch(markAnalysisFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            );

        this.analysisStateMachine = new sfn.StateMachine(this, 'AnalysisPipelineStateMachine', {
            stateMachineName: `${namePrefix}-strategist-analysis`,
            definitionBody: sfn.DefinitionBody.fromChainable(analysisDefinition),
            timeout: cdk.Duration.minutes(30),
            tracingEnabled: true,
            stateMachineType: sfn.StateMachineType.STANDARD,
            logs: {
                level: sfn.LogLevel.ALL,
                destination: new logs.LogGroup(this, 'AnalysisStateMachineLogGroup', {
                    logGroupName: `/aws/vendedlogs/states/${namePrefix}-strategist-analysis`,
                    retention: props.logRetention,
                    removalPolicy: props.removalPolicy,
                }),
            },
        });

        // =================================================================
        // Step Functions — Coaching Pipeline State Machine
        // =================================================================

        const coachLoaderTask = new tasks.LambdaInvoke(this, 'CoachLoaderTask', {
            lambdaFunction: coachLoaderFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Coach Loader: Load existing analysis from DynamoDB',
        });

        const coachTask = new tasks.LambdaInvoke(this, 'CoachTask', {
            lambdaFunction: coachFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Interview Coach: stage-specific interview preparation',
        });
        coachTask.addRetry({
            errors: ['ThrottlingException', 'ServiceUnavailableException', 'States.TaskFailed'],
            interval: cdk.Duration.seconds(5),
            maxAttempts: 2,
            backoffRate: 2,
        });

        // =================================================================
        // Error Handling — Coaching SM: DynamoUpdateItem → Fail
        // =================================================================

        const coachingFailed = new sfn.Fail(this, 'CoachingPipelineFailed', {
            error: 'CoachingPipelineExecutionFailed',
            cause: 'The coaching pipeline threw an unrecoverable error',
        });

        /** Write status='failed' to DDB before transitioning to Fail state */
        const markCoachingFailed = new tasks.DynamoUpdateItem(this, 'MarkCoachingFailed', {
            table: strategistTable,
            key: {
                pk: tasks.DynamoAttributeValue.fromString(
                    JsonPath.format('APPLICATION#{}', JsonPath.stringAt('$.context.applicationSlug')),
                ),
                sk: tasks.DynamoAttributeValue.fromString('METADATA'),
            },
            updateExpression: 'SET #status = :failed, #updatedAt = :now, #errorMessage = :error, #gsi1pk = :gsi1pk, #gsi1sk = :gsi1sk',
            expressionAttributeNames: {
                '#status': 'status',
                '#updatedAt': 'updatedAt',
                '#errorMessage': 'errorMessage',
                '#gsi1pk': 'gsi1pk',
                '#gsi1sk': 'gsi1sk',
            },
            expressionAttributeValues: {
                ':failed': tasks.DynamoAttributeValue.fromString('failed'),
                ':now': tasks.DynamoAttributeValue.fromString(
                    JsonPath.stringAt('$$.State.EnteredTime'),
                ),
                ':error': tasks.DynamoAttributeValue.fromString(
                    JsonPath.stringAt('$.error.Cause'),
                ),
                ':gsi1pk': tasks.DynamoAttributeValue.fromString('APP_STATUS#failed'),
                ':gsi1sk': tasks.DynamoAttributeValue.fromString(
                    JsonPath.format(
                        '{}#{}',
                        JsonPath.arrayGetItem(
                            JsonPath.stringSplit(JsonPath.stringAt('$$.State.EnteredTime'), 'T'),
                            0,
                        ),
                        JsonPath.stringAt('$.context.applicationSlug'),
                    ),
                ),
            },
            resultPath: sfn.JsonPath.DISCARD,
            comment: 'Write status=failed to DynamoDB so frontend can display coaching failure',
        });

        /** Send structured error context to the DLQ before reaching Fail state */
        const sendCoachingErrorToDlq = new tasks.SqsSendMessage(this, 'SendCoachingErrorToDlq', {
            queue: this.pipelineDlq,
            messageBody: sfn.TaskInput.fromObject({
                pipeline: 'coaching',
                applicationSlug: JsonPath.stringAt('$.context.applicationSlug'),
                error: JsonPath.stringAt('$.error.Error'),
                cause: JsonPath.stringAt('$.error.Cause'),
                failedAt: JsonPath.stringAt('$$.State.EnteredTime'),
                stateMachine: JsonPath.stringAt('$$.StateMachine.Name'),
                executionId: JsonPath.stringAt('$$.Execution.Name'),
            }),
            comment: 'Forward structured error context to DLQ for operational visibility',
            resultPath: sfn.JsonPath.DISCARD,
        });

        markCoachingFailed.next(sendCoachingErrorToDlq).next(coachingFailed);

        // Chain: Load → Coach (all catch → MarkFailed → Fail)
        const coachingDefinition = coachLoaderTask
            .addCatch(markCoachingFailed, {
                errors: ['States.ALL'],
                resultPath: '$.error',
            })
            .next(
                coachTask.addCatch(markCoachingFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            );

        this.coachingStateMachine = new sfn.StateMachine(this, 'CoachingPipelineStateMachine', {
            stateMachineName: `${namePrefix}-strategist-coaching`,
            definitionBody: sfn.DefinitionBody.fromChainable(coachingDefinition),
            timeout: cdk.Duration.minutes(15),
            tracingEnabled: true,
            stateMachineType: sfn.StateMachineType.STANDARD,
            logs: {
                level: sfn.LogLevel.ALL,
                destination: new logs.LogGroup(this, 'CoachingStateMachineLogGroup', {
                    logGroupName: `/aws/vendedlogs/states/${namePrefix}-strategist-coaching`,
                    retention: props.logRetention,
                    removalPolicy: props.removalPolicy,
                }),
            },
        });

        // Grant DDB write to both state machine execution roles
        strategistTable.grantWriteData(this.analysisStateMachine);
        strategistTable.grantWriteData(this.coachingStateMachine);

        // =================================================================
        // Lambda — Trigger Handler (API Gateway → Step Functions)
        // =================================================================
        this.triggerFunction = new lambdaNode.NodejsFunction(this, 'TriggerFunction', {
            functionName: `${namePrefix}-strategist-trigger`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'trigger-handler.ts'),
            handler: 'handler',
            memorySize: props.triggerLambdaMemoryMb,
            timeout: cdk.Duration.seconds(30),
            environment: {
                ANALYSIS_STATE_MACHINE_ARN: this.analysisStateMachine.stateMachineArn,
                COACHING_STATE_MACHINE_ARN: this.coachingStateMachine.stateMachineArn,
                TABLE_NAME: strategistTable.tableName,
                ASSETS_BUCKET: assetsBucket.bucketName,
                ALLOWED_ORIGINS: '*',
                ENVIRONMENT: props.environmentName,
            },
            description: 'Strategist Trigger — API Gateway → Step Functions (analyse/coach)',
            logGroup: new logs.LogGroup(this, 'TriggerLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-trigger`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
            deadLetterQueue: this.pipelineDlq,
        });

        // Grant trigger Lambda permission to start executions on both state machines
        this.analysisStateMachine.grantStartExecution(this.triggerFunction);
        this.coachingStateMachine.grantStartExecution(this.triggerFunction);
        strategistTable.grantReadWriteData(this.triggerFunction);

        NagSuppressions.addResourceSuppressions(
            this.triggerFunction,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Using NODEJS_22_X — latest Node.js LTS runtime',
                },
            ],
            true,
        );

        // =================================================================
        // SSM — Export pipeline configuration
        // =================================================================
        new ssm.StringParameter(this, 'AnalysisStateMachineArnParam', {
            parameterName: `/${namePrefix}/strategist-analysis-state-machine-arn`,
            stringValue: this.analysisStateMachine.stateMachineArn,
            description: 'ARN of the strategist analysis pipeline Step Functions state machine',
        });

        new ssm.StringParameter(this, 'CoachingStateMachineArnParam', {
            parameterName: `/${namePrefix}/strategist-coaching-state-machine-arn`,
            stringValue: this.coachingStateMachine.stateMachineArn,
            description: 'ARN of the strategist coaching pipeline Step Functions state machine',
        });

        new ssm.StringParameter(this, 'TriggerFunctionArnParam', {
            parameterName: `/${namePrefix}/strategist-trigger-function-arn`,
            stringValue: this.triggerFunction.functionArn,
            description: 'ARN of the Strategist Trigger Handler Lambda',
        });
    }
}
