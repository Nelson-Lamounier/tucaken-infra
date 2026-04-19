/**
 * @format
 * Bedrock Strategist Pipeline — Resource Allocations
 *
 * Lambda sizing and Bedrock model budget for the 3-agent strategist pipeline.
 * Allocations are "how much" — memory, timeout, model selection, token budgets.
 *
 * Agent architecture:
 *   1. Research Agent (Haiku 4.5) — KB retrieval, resume parsing, gap analysis
 *   2. Strategist Agent (Sonnet 4.6) — Strategy generation, document crafting
 *   3. Interview Coach (Haiku 4.5) — Stage-specific interview preparation
 *
 * Usage:
 * ```typescript
 * import { getStrategistAllocations } from '../../config/bedrock/strategist-allocations';
 * const allocs = getStrategistAllocations(Environment.DEVELOPMENT);
 * ```
 */

import { type DeployableEnvironment, Environment } from '../environments';
import { MODELS } from '../shared/model-registry';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Per-agent model allocation for the strategist pipeline.
 */
export interface StrategistAgentModelAllocation {
    /** Foundation model ID for this agent */
    readonly modelId: string;
}

/**
 * Extended model allocation with token budgets (for Strategist and Coach).
 */
export interface StrategistWriterModelAllocation extends StrategistAgentModelAllocation {
    /** Maximum output tokens */
    readonly maxTokens: number;
    /** Adaptive Thinking budget tokens */
    readonly thinkingBudgetTokens: number;
}

/**
 * Lambda sizing for strategist pipeline functions.
 */
export interface StrategistLambdaAllocation {
    /** Lambda memory in MB for agent Lambdas (Research, Strategist) */
    readonly agentMemoryMb: number;
    /** Lambda timeout in seconds for agent Lambdas */
    readonly agentTimeoutSeconds: number;
    /** Lambda memory in MB for the trigger function */
    readonly triggerMemoryMb: number;
    /** Lambda memory in MB for the interview coach function */
    readonly interviewMemoryMb: number;
    /** Lambda memory in MB for the status update function */
    readonly statusMemoryMb: number;
}

/**
 * Complete strategist pipeline resource allocations.
 */
export interface StrategistAllocations {
    readonly lambda: StrategistLambdaAllocation;
    /** Research Agent — KB retrieval and gap analysis (Haiku 4.5) */
    readonly research: StrategistAgentModelAllocation;
    /** Strategist Agent — strategy generation and document crafting (Sonnet 4.6) */
    readonly strategist: StrategistWriterModelAllocation;
    /** Interview Coach — stage-specific preparation (Haiku 4.5) */
    readonly interviewCoach: StrategistWriterModelAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

export const STRATEGIST_ALLOCATIONS: Record<DeployableEnvironment, StrategistAllocations> = {
    [Environment.DEVELOPMENT]: {
        lambda: {
            agentMemoryMb: 512,
            agentTimeoutSeconds: 600,
            triggerMemoryMb: 256,
            interviewMemoryMb: 512,
            statusMemoryMb: 256,
        },
        research: {
            modelId: MODELS.JOB_STRATEGIST_RESEARCH,
        },
        strategist: {
            modelId: MODELS.JOB_STRATEGIST_WRITER,
            // 64k ceiling: 16k thinking + 48k text — supports full XML + tailored resume JSON
            maxTokens: 64_000,
            thinkingBudgetTokens: 16_384,
        },
        interviewCoach: {
            modelId: MODELS.JOB_STRATEGIST_COACH,
            maxTokens: 8192,
            thinkingBudgetTokens: 4096,
        },
    },

    [Environment.STAGING]: {
        lambda: {
            agentMemoryMb: 1024,
            agentTimeoutSeconds: 900,
            triggerMemoryMb: 256,
            interviewMemoryMb: 1024,
            statusMemoryMb: 256,
        },
        research: {
            modelId: MODELS.JOB_STRATEGIST_RESEARCH,
        },
        strategist: {
            modelId: MODELS.JOB_STRATEGIST_WRITER,
            // 64k ceiling: 16k thinking + 48k text — supports full XML + tailored resume JSON
            maxTokens: 64_000,
            thinkingBudgetTokens: 16_384,
        },
        interviewCoach: {
            modelId: MODELS.JOB_STRATEGIST_COACH,
            maxTokens: 8192,
            thinkingBudgetTokens: 6144,
        },
    },

    [Environment.PRODUCTION]: {
        lambda: {
            agentMemoryMb: 1024,
            agentTimeoutSeconds: 900,
            triggerMemoryMb: 256,
            interviewMemoryMb: 1024,
            statusMemoryMb: 256,
        },
        research: {
            modelId: MODELS.JOB_STRATEGIST_RESEARCH,
        },
        strategist: {
            modelId: MODELS.JOB_STRATEGIST_WRITER,
            // 64k ceiling: 16k thinking + 48k text — supports full XML + tailored resume JSON
            // Previous: maxTokens=16384 / thinkingBudget=16000 → 384 text tokens (broken).
            maxTokens: 64_000,
            thinkingBudgetTokens: 16_384,
        },
        interviewCoach: {
            modelId: MODELS.JOB_STRATEGIST_COACH,
            // Previous: thinkingBudget=8192 equalled maxTokens → zero text budget (broken).
            maxTokens: 8192,
            thinkingBudgetTokens: 4096,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get strategist pipeline allocations for an environment.
 *
 * @param env - Target environment
 * @returns Strategist pipeline resource allocations
 */
export function getStrategistAllocations(env: Environment): StrategistAllocations {
    return STRATEGIST_ALLOCATIONS[env as DeployableEnvironment];
}
