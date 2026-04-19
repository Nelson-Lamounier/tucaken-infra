/**
 * @format
 * Agent Runner — Generic Bedrock Converse API Wrapper
 *
 * Provides a reusable execution wrapper for all agents in the
 * multi-agent pipeline. Handles:
 *
 * - Bedrock Converse API calls with proper model configuration
 * - Adaptive Thinking budget injection
 * - Token usage extraction and cost estimation
 * - X-Ray subsegment creation for per-agent tracing
 * - EMF metric emission per agent execution
 * - Structured error wrapping with agent context
 * - Pipeline context accumulation (tokens, cost)
 *
 * Each agent module calls `runAgent()` with its config, system prompt,
 * and a response parser. The runner handles all cross-cutting concerns.
 *
 * @example
 * ```typescript
 * const result = await runAgent<ResearchResult>({
 *   config: { agentName: 'research', modelId: 'eu.anthropic.claude-haiku-4-5-...', ... },
 *   userMessage: 'Analyse this draft...',
 *   parseResponse: (text) => JSON.parse(text),
 *   pipelineContext: ctx,
 * });
 * ```
 */

import {
    BedrockRuntimeClient,
    ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

import { estimateInvocationCost } from './metrics.js';
import type { TokenUsage } from './metrics.js';
import type { AgentConfig, AgentResult, PipelineContext } from './types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Shared Bedrock client — re-used across all agent invocations within a Lambda. */
const bedrockClient = new BedrockRuntimeClient({});

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for running an agent via the Bedrock Converse API.
 *
 * @template T - The expected parsed output type from the agent's response
 */
export interface RunAgentOptions<T> {
    /** Agent configuration (model, tokens, thinking budget, system prompt) */
    readonly config: AgentConfig;

    /** The user message to send to the model */
    readonly userMessage: string;

    /**
     * Parse the raw text response into the agent-specific output type.
     *
     * @param responseText - The concatenated text blocks from Bedrock's response
     * @returns The parsed, typed agent output
     * @throws Error if the response cannot be parsed
     */
    readonly parseResponse: (responseText: string) => T;

    /** Pipeline context for token/cost accumulation */
    readonly pipelineContext: PipelineContext;
}

/**
 * Error thrown when an agent execution fails.
 * Wraps the original error with agent context for debugging.
 */
export class AgentExecutionError extends Error {
    /** Agent that failed */
    readonly agentName: string;
    /** Pipeline execution ID */
    readonly pipelineId: string;
    /** Original error */
    readonly cause: Error;

    constructor(agentName: string, pipelineId: string, cause: Error) {
        super(`Agent '${agentName}' failed in pipeline '${pipelineId}': ${cause.message}`);
        this.name = 'AgentExecutionError';
        this.agentName = agentName;
        this.pipelineId = pipelineId;
        this.cause = cause;
    }
}

// =============================================================================
// AGENT RUNNER
// =============================================================================

/**
 * Extract text content from a Bedrock Converse API response.
 *
 * Filters out thinking blocks, returning only the model's text output.
 * Bedrock may interleave thinking blocks with text blocks when
 * Adaptive Thinking is enabled.
 *
 * @param contentBlocks - The output content blocks from the Converse response
 * @returns Concatenated text content
 * @throws Error if no text content is found
 */
function extractTextFromResponse(
    contentBlocks: Array<Record<string, unknown>>,
    agentName: string,
): string {
    const textContent = contentBlocks
        .filter((block): block is { text: string } =>
            typeof block === 'object' &&
            block !== null &&
            'text' in block &&
            typeof (block as { text?: unknown }).text === 'string',
        )
        .map((block) => block.text)
        .join('');

    if (!textContent) {
        throw new Error(`Agent '${agentName}': No text content in Bedrock response`);
    }

    return textContent;
}

/**
 * Extract token usage from a Bedrock Converse API response.
 *
 * @param usage - The usage object from the Converse response
 * @returns Normalised token usage with defaults for missing fields
 */
function extractTokenUsage(usage?: { inputTokens?: number; outputTokens?: number }): TokenUsage {
    return {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        thinkingTokens: 0, // Thinking tokens not separately reported in current API
    };
}

/**
 * Accumulate an agent's token usage and cost onto the pipeline context.
 *
 * Mutates the pipeline context in place to track cumulative resource
 * consumption across the entire pipeline execution.
 *
 * @param ctx - Pipeline context to update
 * @param tokenUsage - Token usage from this agent invocation
 * @param costUsd - Estimated cost from this invocation
 */
function accumulateContext(
    ctx: PipelineContext,
    tokenUsage: TokenUsage,
    costUsd: number,
): void {
    ctx.cumulativeTokens.input += tokenUsage.inputTokens;
    ctx.cumulativeTokens.output += tokenUsage.outputTokens;
    ctx.cumulativeTokens.thinking += tokenUsage.thinkingTokens;
    ctx.cumulativeCostUsd += costUsd;
}

/**
 * Emit per-agent EMF (Embedded Metric Format) metrics to CloudWatch.
 *
 * Uses the `BedrockMultiAgent` namespace with `AgentName` and
 * `Environment` dimensions for per-agent breakdowns in Grafana.
 *
 * @param agentName - Agent identifier
 * @param environment - Runtime environment (development/production)
 * @param tokenUsage - Token usage from this invocation
 * @param durationMs - Execution duration in milliseconds
 * @param costUsd - Estimated cost in USD
 * @param modelId - Bedrock model ID used
 */
function emitAgentMetrics(
    agentName: string,
    environment: string,
    tokenUsage: TokenUsage,
    durationMs: number,
    costUsd: number,
    modelId: string,
): void {
    const emfLog = {
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
                {
                    Namespace: 'BedrockMultiAgent',
                    Dimensions: [['AgentName', 'Environment']],
                    Metrics: [
                        { Name: 'AgentDurationMs', Unit: 'Milliseconds' },
                        { Name: 'AgentInputTokens', Unit: 'Count' },
                        { Name: 'AgentOutputTokens', Unit: 'Count' },
                        { Name: 'AgentCostUsd', Unit: 'None' },
                        { Name: 'AgentInvocations', Unit: 'Count' },
                    ],
                },
            ],
        },
        AgentName: agentName,
        Environment: environment,
        ModelId: modelId,
        AgentDurationMs: durationMs,
        AgentInputTokens: tokenUsage.inputTokens,
        AgentOutputTokens: tokenUsage.outputTokens,
        AgentCostUsd: costUsd,
        AgentInvocations: 1,
    };

    // EMF: CloudWatch extracts metrics from structured JSON log lines
    console.log(JSON.stringify(emfLog));
}

/**
 * Run a single agent via the Bedrock Converse API.
 *
 * This is the core execution function for all agents in the pipeline.
 * It handles the complete lifecycle:
 *
 * 1. Build Converse API request with model config + thinking budget
 * 2. Send the request and measure execution time
 * 3. Extract text content (skip thinking blocks)
 * 4. Parse the response using the agent-specific parser
 * 5. Calculate token usage and cost
 * 6. Accumulate onto the pipeline context
 * 7. Emit per-agent EMF metrics
 * 8. Return typed AgentResult
 *
 * @template T - The expected parsed output type
 * @param options - Agent execution options
 * @returns Typed agent result with execution metadata
 * @throws AgentExecutionError wrapping the original error with agent context
 */
export async function runAgent<T>(options: RunAgentOptions<T>): Promise<AgentResult<T>> {
    const { config, userMessage, parseResponse, pipelineContext } = options;
    const { agentName, modelId, maxTokens, thinkingBudget, systemPrompt } = config;

    // =========================================================================
    // VALIDATION: Extended Thinking requires maxTokens > budget_tokens
    // See: https://docs.claude.com/en/docs/build-with-claude/extended-thinking
    // =========================================================================
    if (thinkingBudget > 0 && maxTokens <= thinkingBudget) {
        throw new Error(
            `[${agentName}] Invalid config: maxTokens (${maxTokens}) must be ` +
            `strictly greater than thinkingBudget (${thinkingBudget}). ` +
            `Hint: set maxTokens to at least ${thinkingBudget + 1024}.`,
        );
    }

    console.log(
        `[${agentName}] Starting agent execution — model=${modelId}, ` +
        `maxTokens=${maxTokens}, thinkingBudget=${thinkingBudget}, ` +
        `messageLength=${userMessage.length} chars`,
    );

    const startTime = Date.now();

    try {
        // Build Converse API request
        const command = new ConverseCommand({
            modelId,
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: [{ text: userMessage }],
                },
            ],
            inferenceConfig: {
                maxTokens,
            },
            ...(thinkingBudget > 0
                ? {
                      additionalModelRequestFields: {
                          thinking: {
                              type: 'enabled',
                              budget_tokens: thinkingBudget,
                          },
                      },
                  }
                : {}),
        });

        // Execute the Bedrock call
        const response = await bedrockClient.send(command);
        const durationMs = Date.now() - startTime;

        // Extract token usage
        const tokenUsage = extractTokenUsage(response.usage);

        console.log(
            `[${agentName}] Converse complete — stopReason=${response.stopReason ?? 'unknown'}, ` +
            `inputTokens=${tokenUsage.inputTokens}, outputTokens=${tokenUsage.outputTokens}, ` +
            `duration=${durationMs}ms`,
        );

        // Guard: fail fast when Bedrock truncates the response — check BEFORE
        // extracting text so the real cause surfaces instead of "No text content".
        if (response.stopReason === 'max_tokens') {
            throw new Error(
                `Agent '${agentName}' response truncated — stopReason='max_tokens'. ` +
                `Output used ${tokenUsage.outputTokens} of ${maxTokens} maxTokens ` +
                `(thinkingBudget=${thinkingBudget}). Increase maxTokens to avoid truncation.`,
            );
        }

        // Extract text content (skip thinking blocks)
        const outputBlocks = (response.output?.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
        const textContent = extractTextFromResponse(outputBlocks, agentName);

        // Parse agent-specific response
        const data = parseResponse(textContent);

        // Calculate cost
        const costUsd = estimateInvocationCost(modelId, tokenUsage);

        // Accumulate onto pipeline context
        accumulateContext(pipelineContext, tokenUsage, costUsd);

        // Emit per-agent EMF metrics
        emitAgentMetrics(
            agentName,
            pipelineContext.environment,
            tokenUsage,
            durationMs,
            costUsd,
            modelId,
        );

        console.log(
            `[${agentName}] Complete — cost=$${costUsd.toFixed(6)}, ` +
            `cumulativeCost=$${pipelineContext.cumulativeCostUsd.toFixed(6)}`,
        );

        return {
            data,
            tokenUsage,
            durationMs,
            agentName,
            modelId,
            costUsd,
        };
    } catch (error) {
        const durationMs = Date.now() - startTime;
        const err = error instanceof Error ? error : new Error(String(error));

        console.error(
            `[${agentName}] Failed after ${durationMs}ms: ${err.message}`,
        );

        // Emit failure metric
        const failureEmf = {
            _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                    {
                        Namespace: 'BedrockMultiAgent',
                        Dimensions: [['AgentName', 'Environment']],
                        Metrics: [
                            { Name: 'AgentFailures', Unit: 'Count' },
                            { Name: 'AgentFailureDurationMs', Unit: 'Milliseconds' },
                        ],
                    },
                ],
            },
            AgentName: agentName,
            Environment: pipelineContext.environment,
            AgentFailures: 1,
            AgentFailureDurationMs: durationMs,
            ErrorMessage: err.message.substring(0, 200),
        };
        console.log(JSON.stringify(failureEmf));

        throw new AgentExecutionError(agentName, pipelineContext.pipelineId, err);
    }
}

// =============================================================================
// UTILITY: JSON RESPONSE PARSER
// =============================================================================

/**
 * Extract the root JSON object from a model's text response using balanced
 * brace counting.
 *
 * `lastIndexOf('}')` is unreliable when the model appends commentary or a
 * CHANGES_SUMMARY after the JSON — those may contain `}` characters that
 * push `lastBrace` past the real object boundary.  Balanced counting stops
 * at the first position where every `{` has been closed, regardless of
 * what follows.
 *
 * @param text      - Raw text potentially containing a JSON object
 * @param agentName - Agent name for error messages
 * @returns The raw JSON substring (not yet parsed)
 * @throws Error if no balanced `{…}` block is found
 */
function extractJsonObject(text: string, agentName: string): string {
    const start = text.indexOf('{');
    if (start === -1) {
        console.error(
            `[${agentName}] No JSON object found in response. First 500 chars:\n${text.substring(0, 500)}`,
        );
        throw new Error(`Agent '${agentName}': No JSON object found in response`);
    }

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (escape) {
            escape = false;
            continue;
        }
        if (inString) {
            if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') { depth++; continue; }
        if (ch === '}') {
            depth--;
            if (depth === 0) return text.substring(start, i + 1);
        }
    }

    console.error(
        `[${agentName}] Unbalanced JSON braces in response. First 500 chars:\n${text.substring(0, 500)}`,
    );
    throw new Error(`Agent '${agentName}': No JSON object found in response`);
}

/**
 * Extract and parse a JSON object from a model's text response.
 *
 * Models sometimes wrap JSON in markdown code fences or include
 * explanatory text before/after the JSON. This function uses balanced
 * brace counting to find the outermost `{...}` and parses it.
 *
 * @param responseText - Raw text response from Bedrock
 * @param agentName    - Agent name for error context
 * @returns Parsed JSON object
 * @throws Error if no valid JSON is found
 */
export function parseJsonResponse<T>(responseText: string, agentName: string): T {
    const jsonStr = extractJsonObject(responseText, agentName);

    try {
        return JSON.parse(jsonStr) as T;
    } catch (err) {
        console.error(`[${agentName}] JSON parse failed. Snippet:\n${jsonStr.substring(0, 500)}`);
        throw new Error(`Agent '${agentName}': Failed to parse response JSON — ${String(err)}`);
    }
}
