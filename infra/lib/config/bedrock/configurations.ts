/**
 * @format
 * Bedrock Project - Resource Configurations
 *
 * Centralized resource configurations (policies, retention, instructions) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getBedrockConfigs } from '../../config/bedrock';
 * const configs = getBedrockConfigs(Environment.PRODUCTION);
 * const instruction = configs.agentInstruction;
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';

import { CHATBOT_AGENT_INSTRUCTION } from './chatbot-persona';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Guardrail configuration
 */
export interface GuardrailConfig {
    /** Whether to enable content filtering */
    readonly enableContentFilters: boolean;
    /** Blocked input messaging */
    readonly blockedInputMessaging: string;
    /** Blocked output messaging */
    readonly blockedOutputMessaging: string;
}

/**
 * API Gateway configuration
 */
export interface ApiConfig {
    /** Whether to require API Key authentication */
    readonly enableApiKey: boolean;
    /** Allowed CORS origins */
    readonly allowedOrigins: string[];
}

/**
 * Knowledge Base configuration
 */
export interface KnowledgeBaseConfig {
    /** Secrets Manager secret name for Pinecone API key */
    readonly pineconeSecretName: string;
    /** Knowledge Base description */
    readonly description: string;
    /** Knowledge Base instruction for agent interaction */
    readonly instruction: string;
}

/**
 * Complete resource configurations for Bedrock project
 */
export interface BedrockConfigs {
    /** Agent instruction prompt — defines agent behavior */
    readonly agentInstruction: string;
    /** Agent description */
    readonly agentDescription: string;
    /** Guardrail configuration */
    readonly guardrail: GuardrailConfig;
    /** Knowledge Base configuration */
    readonly knowledgeBase: KnowledgeBaseConfig;
    /** API Gateway configuration */
    readonly api: ApiConfig;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Whether this is a production environment */
    readonly isProduction: boolean;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Whether to create customer-managed KMS keys */
    readonly createKmsKeys: boolean;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Bedrock resource configurations by environment.
 *
 * Agent instruction prompt is imported from the canonical source:
 * @see bedrock-applications/chatbot/src/prompts/chatbot-persona.ts
 */

export const BEDROCK_CONFIGS: Record<DeployableEnvironment, BedrockConfigs> = {
    [Environment.DEVELOPMENT]: {
        agentInstruction: CHATBOT_AGENT_INSTRUCTION,
        agentDescription: 'Portfolio AI assistant (development)',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        knowledgeBase: {
            pineconeSecretName: 'bedrock-dev/pinecone-api-key',
            description: 'Portfolio repository documentation knowledge base (development)',
            // Gap A7: Precise retrieval instruction — guides the agent to search across
            // all portfolio topic areas listed in the agent instruction (KB TOPICS section).
            instruction:
                'Answers portfolio questions: AWS CDK, Kubernetes, AI/ML, CI/CD, Next.js, ' +
                'observability, AWS certs. Always retrieve context before answering. No general knowledge.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['http://localhost:3000', 'https://nelsonlamounier.com'],
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.STAGING]: {
        agentInstruction: CHATBOT_AGENT_INSTRUCTION,
        agentDescription: 'Portfolio AI assistant (staging)',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        knowledgeBase: {
            pineconeSecretName: 'bedrock-stg/pinecone-api-key',
            description: 'Portfolio repository documentation knowledge base (staging)',
            // Gap A7: Consistent with development — precise retrieval guidance.
            instruction:
                'Answers portfolio questions: AWS CDK, Kubernetes, AI/ML, CI/CD, Next.js, ' +
                'observability, AWS certs. Always retrieve context before answering. No general knowledge.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://staging.nelsonlamounier.com'],
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.PRODUCTION]: {
        agentInstruction: CHATBOT_AGENT_INSTRUCTION,
        agentDescription: 'Portfolio AI assistant',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        knowledgeBase: {
            pineconeSecretName: 'bedrock-prd/pinecone-api-key',
            description: 'Portfolio repository documentation knowledge base',
            // Gap A7: Production instruction adds citation requirement for higher grounding precision.
            instruction:
                'Answers portfolio questions: AWS, K8s, AI/ML, CI/CD, Next.js, observability. ' +
                'Retrieve context before answering and cite specific documents. No general knowledge.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://nelsonlamounier.com'],
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Bedrock configurations for an environment
 */
export function getBedrockConfigs(env: Environment): BedrockConfigs {
    return BEDROCK_CONFIGS[env as DeployableEnvironment];
}
