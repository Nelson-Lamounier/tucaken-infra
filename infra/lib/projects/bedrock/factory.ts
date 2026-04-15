/**
 * @format
 * Bedrock Project Factory
 *
 * Creates the Amazon Bedrock Agent infrastructure using an 8-stack architecture:
 * - DataStack: S3 bucket for content pipeline documents
 * - KbStack: Bedrock Knowledge Base backed by Pinecone
 * - AgentStack: Bedrock Agent, Guardrail, Action Group
 * - ApiStack: API Gateway + Lambda for agent invocation
 * - ContentStack: Data layer (DynamoDB table + SSM exports)
 * - PipelineStack: Multi-agent Step Functions pipeline (Research → Writer → QA)
 * - StrategistDataStack: Job strategist data layer (DynamoDB)
 * - StrategistPipelineStack: Job strategist pipeline (Research → Strategist → Coach)
 *
 * Stacks created:
 * - Bedrock-Data-{environment}
 * - Bedrock-Kb-{environment}
 * - Bedrock-Agent-{environment}
 * - Bedrock-Api-{environment}
 * - Bedrock-Content-{environment}
 * - Bedrock-Pipeline-{environment}
 * - Bedrock-Strategist-Data-{environment}
 * - Bedrock-Strategist-Pipeline-{environment}
 */

import * as cdk from 'aws-cdk-lib/core';

import { getBedrockAllocations } from '../../config/bedrock/allocations';
import { getBedrockConfigs } from '../../config/bedrock/configurations';
import { getContentConfigs } from '../../config/bedrock/content-configurations';
import { getPipelineAllocations } from '../../config/bedrock/pipeline-allocations';
import { getPipelineConfigs } from '../../config/bedrock/pipeline-configurations';
import { getStrategistAllocations } from '../../config/bedrock/strategist-allocations';
import { getStrategistConfigs } from '../../config/bedrock/strategist-configurations';
import { Environment, cdkEnvironment } from '../../config/environments';
import { Project, getProjectConfig } from '../../config/projects';
import { SYSTEM_INFERENCE_PROFILES } from '../../config/shared/model-registry';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    BedrockDataStack,
    BedrockKbStack,
    BedrockAgentStack,
    BedrockApiStack,
    AiContentStack,
    BedrockPipelineStack,
    StrategistDataStack,
    StrategistPipelineStack,
} from '../../stacks/bedrock';
import { stackId, flatName } from '../../utilities/naming';

// =========================================================================
// Factory Context
// =========================================================================

/**
 * Extended factory context with Bedrock-specific overrides.
 */
export interface BedrockFactoryContext extends ProjectFactoryContext {
    /** Override agent instruction from config */
    agentInstruction?: string;
    /** Override foundation model from config */
    foundationModel?: string;
}

/**
 * Bedrock project factory.
 * Creates Amazon Bedrock Agent infrastructure with Guardrails,
 * Action Groups, API Gateway frontend, and MD-to-Blog pipeline.
 */
export class BedrockProjectFactory implements IProjectFactory<BedrockFactoryContext> {
    readonly project = Project.BEDROCK;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.BEDROCK).namespace;
    }

    createAllStacks(scope: cdk.App, context: BedrockFactoryContext): ProjectStackFamily {
        // -------------------------------------------------------------
        // Load typed config for this environment
        // -------------------------------------------------------------
        const allocs = getBedrockAllocations(this.environment);
        const configs = getBedrockConfigs(this.environment);
        const contentConfigs = getContentConfigs(this.environment);
        const pipelineAllocs = getPipelineAllocations(this.environment);
        const pipelineConfigs = getPipelineConfigs(this.environment);
        const strategistAllocs = getStrategistAllocations(this.environment);
        const strategistConfigs = getStrategistConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        const namePrefix = flatName('bedrock', '', this.environment);

        // Context overrides > typed config defaults
        const agentInstruction = context.agentInstruction ?? configs.agentInstruction;
        const foundationModel = context.foundationModel ?? allocs.agent.foundationModel;

        // =================================================================
        // Stack 1: Data (S3 bucket for content pipeline)
        //
        // Stateful resources with independent lifecycle.
        // Data persists across agent redeployments.
        // =================================================================
        const dataStack = new BedrockDataStack(
            scope,
            stackId(this.namespace, 'Data', this.environment),
            {
                namePrefix,
                createEncryptionKey: configs.createKmsKeys,
                removalPolicy: configs.removalPolicy,
                haikuProfileSourceArn: SYSTEM_INFERENCE_PROFILES.CLAUDE_HAIKU_4_5,
                sonnetProfileSourceArn: SYSTEM_INFERENCE_PROFILES.CLAUDE_SONNET_4_6,
                environmentName: this.environment,
                // Gap C3: Wire monthly budget alarm when a notification email is configured.
                // Consistent with the NOTIFICATION_EMAIL convention in shared/factory.ts.
                budgetAlertEmail: process.env.NOTIFICATION_EMAIL,
                env,
            }
        );

        // =================================================================
        // Stack 2: Knowledge Base (Pinecone-backed vector store)
        //
        // Creates the Bedrock KB that embeds and retrieves repo docs.
        // Uses Pinecone free tier — zero idle cost.
        // Must be created before Agent so it can be associated.
        // =================================================================
        const kbStack = new BedrockKbStack(
            scope,
            stackId(this.namespace, 'Kb', this.environment),
            {
                namePrefix,
                embeddingsModel: allocs.knowledgeBase.embeddingsModel,
                dataBucketArn: dataStack.dataBucket.bucketArn,
                pineconeConnectionString: allocs.knowledgeBase.pineconeConnectionString,
                pineconeSecretName: configs.knowledgeBase.pineconeSecretName,
                pineconeNamespace: allocs.knowledgeBase.pineconeNamespace,
                kbDescription: configs.knowledgeBase.description,
                kbInstruction: configs.knowledgeBase.instruction,
                removalPolicy: configs.removalPolicy,
                env,
            }
        );
        kbStack.addDependency(dataStack);

        // =================================================================
        // Stack 3: Agent (Bedrock Agent + Guardrail + KB)
        //
        // Core AI resources. Knowledge Base is wired here so the chatbot
        // can answer portfolio questions from Pinecone-indexed documents.
        // =================================================================
        const agentStack = new BedrockAgentStack(
            scope,
            stackId(this.namespace, 'Agent', this.environment),
            {
                namePrefix,
                foundationModel,
                agentInstruction,
                agentDescription: configs.agentDescription,
                idleSessionTtlInSeconds: allocs.agent.idleSessionTtlInSeconds,
                enableContentFilters: configs.guardrail.enableContentFilters,
                blockedInputMessaging: configs.guardrail.blockedInputMessaging,
                blockedOutputsMessaging: configs.guardrail.blockedOutputMessaging,
                removalPolicy: configs.removalPolicy,
                knowledgeBase: kbStack.knowledgeBase,
                env,
            },
        );
        agentStack.addDependency(dataStack);
        agentStack.addDependency(kbStack);

        // =================================================================
        // Stack 4: API (API Gateway + Lambda for agent invocation)
        //
        // Serverless frontend. References Agent stack outputs.
        // =================================================================
        const apiStack = new BedrockApiStack(
            scope,
            stackId(this.namespace, 'Api', this.environment),
            {
                namePrefix,
                environmentName: this.environment,
                lambdaMemoryMb: allocs.apiLambda.memoryMb,
                lambdaTimeoutSeconds: allocs.apiLambda.timeoutSeconds,
                logRetention: configs.logRetention,
                removalPolicy: configs.removalPolicy,
                enableApiKey: configs.api.enableApiKey,
                allowedOrigins: configs.api.allowedOrigins,
                throttlingRateLimit: allocs.apiGateway.throttlingRateLimit,
                throttlingBurstLimit: allocs.apiGateway.throttlingBurstLimit,
                env,
            }
        );
        apiStack.addDependency(agentStack);

        // =================================================================
        // Stack 5: Content (Data Layer — DynamoDB + SSM Exports)
        //
        // Creates the shared DynamoDB table consumed by both the admin
        // dashboard (reads) and the Pipeline (writes). SSM exports allow
        // cross-stack parameter discovery.
        //
        // The monolith Lambda publisher has been deprecated. Article
        // generation is now handled by PipelineStack (Step Functions).
        // =================================================================
        const contentStack = new AiContentStack(
            scope,
            stackId(this.namespace, 'Content', this.environment),
            {
                namePrefix,
                assetsBucketName: dataStack.bucketName,
                publishedPrefix: contentConfigs.s3.publishedPrefix,
                contentPrefix: contentConfigs.s3.contentPrefix,
                logRetention: contentConfigs.logRetention,
                removalPolicy: contentConfigs.removalPolicy,
                environmentName: this.environment,
                env,
            }
        );
        contentStack.addDependency(dataStack);

        // =================================================================
        // Stack 6: Pipeline (Multi-Agent Step Functions)
        //
        // Primary article generation pipeline. Multi-agent orchestration
        // using separate Lambdas per agent with Step Functions.
        // Triggered by the admin dashboard via API Gateway.
        // =================================================================
        const pipelineStack = new BedrockPipelineStack(
            scope,
            stackId(this.namespace, 'Pipeline', this.environment),
            {
                namePrefix,
                assetsBucketName: dataStack.bucketName,
                tableName: contentStack.tableName,
                researchModel: pipelineAllocs.research.modelId,
                writerModel: pipelineAllocs.writer.modelId,
                qaModel: pipelineAllocs.qa.modelId,
                writerMaxTokens: pipelineAllocs.writer.maxTokens,
                writerThinkingBudgetTokens: pipelineAllocs.writer.thinkingBudgetTokens,
                agentLambdaMemoryMb: pipelineAllocs.lambda.agentMemoryMb,
                agentLambdaTimeoutSeconds: pipelineAllocs.lambda.agentTimeoutSeconds,
                triggerLambdaMemoryMb: pipelineAllocs.lambda.triggerMemoryMb,
                publishLambdaMemoryMb: pipelineAllocs.lambda.publishMemoryMb,
                logRetention: pipelineConfigs.logRetention,
                removalPolicy: pipelineConfigs.removalPolicy,
                knowledgeBaseId: kbStack.knowledgeBaseId,
                knowledgeBaseArn: kbStack.knowledgeBaseArn,
                environmentName: this.environment,
                draftPrefix: pipelineConfigs.s3.draftPrefix,
                publishedPrefix: pipelineConfigs.s3.publishedPrefix,
                contentPrefix: pipelineConfigs.s3.contentPrefix,
                reviewPrefix: pipelineConfigs.s3.reviewPrefix,
                archivedPrefix: pipelineConfigs.s3.archivedPrefix,
                isrEndpoint: pipelineConfigs.isrEndpoint,
                researchProfileArn: dataStack.articleHaikuProfileArn,
                writerProfileArn: dataStack.articleSonnetProfileArn,
                qaProfileArn: dataStack.articleSonnetProfileArn,
                env,
            }
        );
        pipelineStack.addDependency(dataStack);
        pipelineStack.addDependency(contentStack); // Uses contentStack's DynamoDB table

        // =================================================================
        // Stack 7: Strategist Data (DynamoDB for job applications)
        //
        // Stateful resources for the job strategist pipeline.
        // Independent lifecycle from pipeline Lambdas.
        // =================================================================
        const strategistDataStack = new StrategistDataStack(
            scope,
            stackId(this.namespace, 'Strategist-Data', this.environment),
            {
                namePrefix,
                assetsBucketName: dataStack.bucketName,
                removalPolicy: strategistConfigs.removalPolicy,
                environmentName: this.environment,
                env,
            }
        );
        strategistDataStack.addDependency(dataStack);

        // =================================================================
        // Stack 8: Strategist Pipeline (Multi-Agent Step Functions)
        //
        // 3-agent pipeline: Research → Strategist → Interview Coach.
        // Triggered by the admin dashboard via API Gateway.
        // =================================================================
        const strategistPipelineStack = new StrategistPipelineStack(
            scope,
            stackId(this.namespace, 'Strategist-Pipeline', this.environment),
            {
                namePrefix,
                assetsBucketName: dataStack.bucketName,
                tableName: strategistDataStack.tableName,
                researchModel: strategistAllocs.research.modelId,
                strategistModel: strategistAllocs.strategist.modelId,
                strategistMaxTokens: strategistAllocs.strategist.maxTokens,
                strategistThinkingBudgetTokens: strategistAllocs.strategist.thinkingBudgetTokens,
                coachModel: strategistAllocs.interviewCoach.modelId,
                coachMaxTokens: strategistAllocs.interviewCoach.maxTokens,
                coachThinkingBudgetTokens: strategistAllocs.interviewCoach.thinkingBudgetTokens,
                agentLambdaMemoryMb: strategistAllocs.lambda.agentMemoryMb,
                agentLambdaTimeoutSeconds: strategistAllocs.lambda.agentTimeoutSeconds,
                triggerLambdaMemoryMb: strategistAllocs.lambda.triggerMemoryMb,
                logRetention: strategistConfigs.logRetention,
                removalPolicy: strategistConfigs.removalPolicy,
                knowledgeBaseId: kbStack.knowledgeBaseId,
                knowledgeBaseArn: kbStack.knowledgeBaseArn,
                environmentName: this.environment,
                researchProfileArn: dataStack.strategistHaikuProfileArn,
                strategistProfileArn: dataStack.strategistSonnetProfileArn,
                resumeBuilderProfileArn: dataStack.strategistHaikuProfileArn,
                coachProfileArn: dataStack.strategistHaikuProfileArn,
                env,
            }
        );
        strategistPipelineStack.addDependency(dataStack);
        strategistPipelineStack.addDependency(strategistDataStack);

        const stacks: cdk.Stack[] = [
            dataStack,
            kbStack,
            agentStack,
            apiStack,
            contentStack,
            pipelineStack,
            strategistDataStack,
            strategistPipelineStack,
        ];

        cdk.Annotations.of(scope).addInfo(
            `Bedrock factory created ${stacks.length} stacks for ${this.environment}`,
        );

        return {
            stacks,
            stackMap: {
                data: dataStack,
                kb: kbStack,
                agent: agentStack,
                api: apiStack,
                content: contentStack,
                pipeline: pipelineStack,
                strategistData: strategistDataStack,
                strategistPipeline: strategistPipelineStack,
            },
        };
    }
}
