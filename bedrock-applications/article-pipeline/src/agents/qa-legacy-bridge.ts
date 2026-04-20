/**
 * @format
 * Legacy QA Bridge — Backwards Compatibility for Monolithic Handler
 *
 * Provides the `validateArticle` function and type exports that the
 * monolithic `index.ts` handler imports. This bridge will be removed
 * when the monolith is deprecated after pipeline cutover.
 *
 * @deprecated Will be removed during monolith deprecation (Phase 2c)
 */

import {
    BedrockRuntimeClient,
    ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

import { QA_PERSONA_SYSTEM_PROMPT } from '../prompts/qa-persona.js';
import { estimateInvocationCost } from '../../../shared/src/metrics.js';
import { log } from '../../../shared/src/index.js';
import type { TokenUsage } from '../../../shared/src/metrics.js';

// Re-export types for the monolith
export type { QaValidationResult, QaRecommendation, QaIssue, IssueSeverity, DimensionResult } from '../../../shared/src/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Validates and returns the QA_MODEL environment variable.
 *
 * @returns The validated model identifier
 * @throws {Error} If the environment variable is not set
 */
function requireQaModel(): string {
    const model = process.env.QA_MODEL;
    if (!model) {
        throw new Error(
            'Missing required environment variable QA_MODEL. ' +
            'This must be set by CDK infrastructure (e.g. eu.anthropic.claude-haiku-4-5-20251001-v1:0)',
        );
    }
    return model;
}

const QA_MODEL = requireQaModel();
const QA_MAX_TOKENS = parseInt(process.env.QA_MAX_TOKENS ?? '8192', 10);
const QA_THINKING_BUDGET = parseInt(process.env.QA_THINKING_BUDGET ?? '4096', 10);

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? QA_MODEL;

// =============================================================================
// LEGACY TYPES
// =============================================================================

/**
 * Legacy input shape for the monolith's validateArticle call.
 *
 * @deprecated Use the new QA Agent module instead
 */
export interface ValidateArticleInput {
    /** Full MDX article content */
    content: string;
    /** Article metadata from the Writer */
    metadata: {
        title: string;
        description: string;
        tags: string[];
        slug: string;
        readingTime: number;
        category: string;
        aiSummary: string;
        technicalConfidence: number;
        skillsDemonstrated?: string[];
        processingNote?: string;
        [key: string]: unknown;
    };
    /** Article slug */
    slug: string;
    /** Pipeline mode */
    mode: string;
}

/**
 * A stage timer interface for backwards compatibility.
 *
 * @deprecated Use the new AgentRunner pattern for timing
 */
interface StageTimer {
    start: (stage: string) => void;
    end: (stage: string) => void;
}

// =============================================================================
// LEGACY FUNCTION
// =============================================================================

import type { QaValidationResult } from '../../../shared/src/types.js';

const bedrockClient = new BedrockRuntimeClient({});

/**
 * Legacy validateArticle function for the monolithic handler.
 *
 * This is a simplified version that calls Bedrock directly without
 * the AgentRunner wrapper. It exists solely for backward compatibility
 * during the shadow-mode migration period.
 *
 * @deprecated Use executeQaAgent from agents/qa-agent.ts instead
 * @param input - Article content and metadata
 * @param timer - Stage timer for metrics
 * @returns QA validation result
 */
export async function validateArticle(
    input: ValidateArticleInput,
    timer: StageTimer,
): Promise<QaValidationResult> {
    timer.start('qa-validation');

    const userMessage = [
        `Review the following blog article.`,
        ``,
        `## Article Metadata`,
        `- Title: ${input.metadata.title}`,
        `- Slug: ${input.slug}`,
        `- Tags: ${input.metadata.tags.join(', ')}`,
        `- Reading Time: ${input.metadata.readingTime} minutes`,
        `- Description: ${input.metadata.description}`,
        `- AI Summary: ${input.metadata.aiSummary}`,
        `- Writer's Self-Rated Confidence: ${input.metadata.technicalConfidence}/100`,
        `- Category: ${input.metadata.category}`,
        `- Generation Mode: ${input.mode}`,
        ``,
        `## Full Article Content`,
        `--- BEGIN ARTICLE ---`,
        input.content,
        `--- END ARTICLE ---`,
        ``,
        `Perform your quality review and return the JSON result object.`,
    ].join('\n');

    const command = new ConverseCommand({
        modelId: EFFECTIVE_MODEL_ID,
        system: QA_PERSONA_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ text: userMessage }] }],
        inferenceConfig: { maxTokens: QA_MAX_TOKENS },
        ...(QA_THINKING_BUDGET > 0
            ? {
                  additionalModelRequestFields: {
                      thinking: { type: 'enabled', budget_tokens: QA_THINKING_BUDGET },
                  },
              }
            : {}),
    });

    const response = await bedrockClient.send(command);
    timer.end('qa-validation');

    // Extract text content
    const outputBlocks = (response.output?.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
    const textContent = outputBlocks
        .filter((block): block is { text: string } =>
            typeof block === 'object' && block !== null && 'text' in block && typeof (block as { text?: unknown }).text === 'string',
        )
        .map((block) => block.text)
        .join('');

    if (!textContent) {
        throw new Error('QA validation: No text content in Bedrock response');
    }

    // Parse JSON from response
    const firstBrace = textContent.indexOf('{');
    const lastBrace = textContent.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
        throw new Error('QA validation: No JSON found in response');
    }

    const parsed = JSON.parse(textContent.substring(firstBrace, lastBrace + 1)) as QaValidationResult;

    // Log token usage
    const usage: TokenUsage = {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        thinkingTokens: 0,
    };
    const cost = estimateInvocationCost(QA_MODEL, usage);
    log('INFO', 'Legacy QA validation complete', { agent: 'qa-legacy', overallScore: parsed.overallScore, cost });

    return parsed;
}
