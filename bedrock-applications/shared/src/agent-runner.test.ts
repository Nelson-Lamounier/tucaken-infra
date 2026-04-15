/**
 * @format
 * Agent Runner — Unit Tests
 *
 * Tests the core shared agent-runner module for:
 *
 * 1. **Runtime Validation Guard**: Ensures `maxTokens > thinkingBudget`
 *    when extended thinking is enabled. This guard was added to catch
 *    Claude Extended Thinking constraint violations at config-time
 *    rather than as cryptic Bedrock API errors.
 *
 * 2. **parseJsonResponse**: JSON extraction from raw model output,
 *    including markdown-wrapped responses and error cases.
 *
 * 3. **AgentExecutionError**: Error wrapping with agent context.
 *
 * @see https://docs.claude.com/en/docs/build-with-claude/extended-thinking
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { AgentConfig, PipelineContext } from './types';

// =============================================================================
// MOCKS — Must be declared BEFORE imports that use them
// =============================================================================

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
    ConverseCommand: jest.fn((params: unknown) => ({ input: params })),
}));

jest.mock('./metrics.js', () => ({
    estimateInvocationCost: jest.fn(() => 0.001),
}));

// Import AFTER mocks are set up
import { runAgent, parseJsonResponse, AgentExecutionError } from './agent-runner';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

/** Agent name used consistently across all test cases */
const TEST_AGENT_NAME = 'research' as const;

/** Model ID for tests */
const TEST_MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Valid token configuration: maxTokens > thinkingBudget */
const VALID_MAX_TOKENS = 8192;
const VALID_THINKING_BUDGET = 4096;

/** Invalid: maxTokens === thinkingBudget (the exact production bug) */
const EQUAL_MAX_TOKENS = 4096;
const EQUAL_THINKING_BUDGET = 4096;

/** Invalid: maxTokens < thinkingBudget (severe misconfiguration) */
const LOW_MAX_TOKENS = 4096;
const HIGH_THINKING_BUDGET = 8192;

/** Thinking disabled (budget = 0) — validation should be skipped */
const DISABLED_THINKING_BUDGET = 0;

/** Simple user message for all test invocations */
const TEST_USER_MESSAGE = 'Analyse the draft content for complexity.';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a minimal AgentConfig for testing.
 *
 * @param maxTokens - Maximum output tokens
 * @param thinkingBudget - Extended thinking budget (0 = disabled)
 * @returns A valid AgentConfig object
 */
function buildConfig(maxTokens: number, thinkingBudget: number): AgentConfig {
    return {
        agentName: TEST_AGENT_NAME,
        modelId: TEST_MODEL_ID,
        maxTokens,
        thinkingBudget,
        systemPrompt: [{ text: 'You are a research agent.' }],
    };
}

/**
 * Build a minimal PipelineContext for testing.
 *
 * @returns A fresh PipelineContext with zeroed cumulative fields
 */
function buildPipelineContext(): PipelineContext {
    return {
        pipelineId: 'test-pipeline-001',
        slug: 'test-article',
        sourceKey: 'drafts/test-article.md',
        bucket: 'test-bucket',
        environment: 'development',
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        retryAttempt: 0,
        version: 0,
        startedAt: new Date().toISOString(),
    };
}

/**
 * Build a mock Bedrock Converse API response.
 *
 * @param textContent - The text content to include in the response
 * @returns A mock response matching the Converse API shape
 */
function buildMockBedrockResponse(textContent: string): Record<string, unknown> {
    return {
        output: {
            message: {
                content: [{ text: textContent }],
            },
        },
        usage: {
            inputTokens: 500,
            outputTokens: 200,
        },
        stopReason: 'end_turn',
    };
}

// =============================================================================
// TESTS: Extended Thinking Validation Guard
// =============================================================================

describe('runAgent — Extended Thinking Validation Guard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should throw when maxTokens equals thinkingBudget', async () => {
        const config = buildConfig(EQUAL_MAX_TOKENS, EQUAL_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        await expect(
            runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => text,
                pipelineContext: ctx,
            }),
        ).rejects.toThrow(
            `[${TEST_AGENT_NAME}] Invalid config: maxTokens (${EQUAL_MAX_TOKENS}) must be ` +
            `strictly greater than thinkingBudget (${EQUAL_THINKING_BUDGET}).`,
        );

        // Bedrock should never be called — guard fires first
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('should throw when maxTokens is less than thinkingBudget', async () => {
        const config = buildConfig(LOW_MAX_TOKENS, HIGH_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        await expect(
            runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => text,
                pipelineContext: ctx,
            }),
        ).rejects.toThrow(
            `[${TEST_AGENT_NAME}] Invalid config: maxTokens (${LOW_MAX_TOKENS}) must be ` +
            `strictly greater than thinkingBudget (${HIGH_THINKING_BUDGET}).`,
        );

        expect(mockSend).not.toHaveBeenCalled();
    });

    it('should include remediation hint in error message', async () => {
        const config = buildConfig(LOW_MAX_TOKENS, HIGH_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        await expect(
            runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => text,
                pipelineContext: ctx,
            }),
        ).rejects.toThrow(
            `Hint: set maxTokens to at least ${HIGH_THINKING_BUDGET + 1024}.`,
        );
    });

    it('should skip validation when thinking is disabled (budget = 0)', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, DISABLED_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        mockSend.mockResolvedValueOnce(
            buildMockBedrockResponse('Test response without thinking'),
        );

        const result = await runAgent({
            config,
            userMessage: TEST_USER_MESSAGE,
            parseResponse: (text: string) => text,
            pipelineContext: ctx,
        });

        expect(result.data).toBe('Test response without thinking');
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should proceed to Bedrock when maxTokens > thinkingBudget', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, VALID_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        mockSend.mockResolvedValueOnce(
            buildMockBedrockResponse('Valid research analysis output'),
        );

        const result = await runAgent({
            config,
            userMessage: TEST_USER_MESSAGE,
            parseResponse: (text: string) => text,
            pipelineContext: ctx,
        });

        expect(result.data).toBe('Valid research analysis output');
        expect(result.agentName).toBe(TEST_AGENT_NAME);
        expect(result.modelId).toBe(TEST_MODEL_ID);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should not call Bedrock API on validation failure', async () => {
        const config = buildConfig(EQUAL_MAX_TOKENS, EQUAL_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        try {
            await runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => text,
                pipelineContext: ctx,
            });
        } catch {
            // Expected to throw
        }

        expect(mockSend).toHaveBeenCalledTimes(0);
    });
});

// =============================================================================
// TESTS: runAgent — Successful Execution
// =============================================================================

describe('runAgent — Successful Execution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return typed AgentResult with parsed data', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, VALID_THINKING_BUDGET);
        const ctx = buildPipelineContext();
        const mockPayload = { tier: 'MID', reason: 'moderate complexity' };

        mockSend.mockResolvedValueOnce(
            buildMockBedrockResponse(JSON.stringify(mockPayload)),
        );

        const result = await runAgent<{ tier: string; reason: string }>({
            config,
            userMessage: TEST_USER_MESSAGE,
            parseResponse: (text: string) => JSON.parse(text),
            pipelineContext: ctx,
        });

        expect(result.data.tier).toBe('MID');
        expect(result.data.reason).toBe('moderate complexity');
        expect(result.tokenUsage.inputTokens).toBe(500);
        expect(result.tokenUsage.outputTokens).toBe(200);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.costUsd).toBe(0.001);
    });

    it('should accumulate tokens onto pipeline context', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, VALID_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        mockSend.mockResolvedValueOnce(
            buildMockBedrockResponse('test output'),
        );

        await runAgent({
            config,
            userMessage: TEST_USER_MESSAGE,
            parseResponse: (text: string) => text,
            pipelineContext: ctx,
        });

        expect(ctx.cumulativeTokens.input).toBe(500);
        expect(ctx.cumulativeTokens.output).toBe(200);
        expect(ctx.cumulativeCostUsd).toBe(0.001);
    });
});

// =============================================================================
// TESTS: runAgent — Error Handling
// =============================================================================

describe('runAgent — Error Handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should wrap Bedrock errors in AgentExecutionError', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, VALID_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        mockSend.mockRejectedValueOnce(
            new Error('ThrottlingException: Rate exceeded'),
        );

        await expect(
            runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => text,
                pipelineContext: ctx,
            }),
        ).rejects.toThrow(AgentExecutionError);
    });

    it('should include agent name and pipeline ID in wrapped error', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, VALID_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        mockSend.mockRejectedValueOnce(new Error('Internal server error'));

        await expect(
            runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => text,
                pipelineContext: ctx,
            }),
        ).rejects.toThrow(
            `Agent '${TEST_AGENT_NAME}' failed in pipeline '${ctx.pipelineId}'`,
        );
    });

    it('should throw AgentExecutionError when stopReason is max_tokens', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, VALID_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        // Simulate a truncated response — Bedrock returns stopReason='max_tokens'
        mockSend.mockResolvedValueOnce({
            output: {
                message: {
                    content: [{ text: '{"truncated": "respon' }],
                },
            },
            usage: { inputTokens: 1000, outputTokens: 8192 },
            stopReason: 'max_tokens',
        });

        try {
            await runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => JSON.parse(text),
                pipelineContext: ctx,
            });
            fail('Expected AgentExecutionError to be thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(AgentExecutionError);
            const agentErr = error as InstanceType<typeof AgentExecutionError>;
            expect(agentErr.cause.message).toContain('response truncated');
            expect(agentErr.cause.message).toContain("stopReason='max_tokens'");
        }
    });

    it('should include token budget details in max_tokens truncation error', async () => {
        const config = buildConfig(VALID_MAX_TOKENS, VALID_THINKING_BUDGET);
        const ctx = buildPipelineContext();

        mockSend.mockResolvedValueOnce({
            output: {
                message: {
                    content: [{ text: '{"incomplete": true' }],
                },
            },
            usage: { inputTokens: 500, outputTokens: 8192 },
            stopReason: 'max_tokens',
        });

        try {
            await runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => JSON.parse(text),
                pipelineContext: ctx,
            });
            fail('Expected AgentExecutionError to be thrown');
        } catch (error) {
            const agentErr = error as InstanceType<typeof AgentExecutionError>;
            expect(agentErr.cause.message).toContain(
                `Output used 8192 of ${VALID_MAX_TOKENS} maxTokens`,
            );
            expect(agentErr.cause.message).toContain(
                `thinkingBudget=${VALID_THINKING_BUDGET}`,
            );
        }
    });
});

// =============================================================================
// TESTS: parseJsonResponse
// =============================================================================

/** Complete JSON object for parse testing */
const COMPLETE_JSON = JSON.stringify({ key: 'value', nested: { a: 1 } });

/** JSON wrapped in markdown code fences */
const WRAPPED_JSON = `Here is my analysis:\n\n\`\`\`json\n${COMPLETE_JSON}\n\`\`\`\n\nEnd of analysis.`;

/** JSON with surrounding prose */
const PROSE_JSON = `After careful analysis, I found: ${COMPLETE_JSON} That concludes my review.`;

describe('parseJsonResponse', () => {
    it('should parse a standalone JSON object', () => {
        const result = parseJsonResponse<{ key: string }>(COMPLETE_JSON, 'test');
        expect(result.key).toBe('value');
    });

    it('should extract JSON from markdown code fences', () => {
        const result = parseJsonResponse<{ key: string }>(WRAPPED_JSON, 'test');
        expect(result.key).toBe('value');
    });

    it('should extract JSON surrounded by prose', () => {
        const result = parseJsonResponse<{ key: string }>(PROSE_JSON, 'test');
        expect(result.key).toBe('value');
    });

    it('should throw for response with no JSON object', () => {
        expect(() => parseJsonResponse('No JSON here at all', 'test'))
            .toThrow('No JSON object found in response');
    });

    it('should throw for malformed JSON', () => {
        expect(() => parseJsonResponse('{ broken json: }', 'test'))
            .toThrow('Failed to parse response JSON');
    });

    it('should include agent name in error messages', () => {
        expect(() => parseJsonResponse('No JSON', 'my-agent'))
            .toThrow("Agent 'my-agent'");
    });
});

// =============================================================================
// TESTS: AgentExecutionError
// =============================================================================

describe('AgentExecutionError', () => {
    it('should include agent name and pipeline ID in message', () => {
        const cause = new Error('Something went wrong');
        const error = new AgentExecutionError('writer', 'pipeline-123', cause);

        expect(error.message).toContain("Agent 'writer' failed in pipeline 'pipeline-123'");
        expect(error.message).toContain('Something went wrong');
    });

    it('should preserve the original cause', () => {
        const cause = new Error('Root cause error');
        const error = new AgentExecutionError('qa', 'pipeline-456', cause);

        expect(error.cause).toBe(cause);
        expect(error.agentName).toBe('qa');
        expect(error.pipelineId).toBe('pipeline-456');
    });

    it('should have the correct error name', () => {
        const error = new AgentExecutionError(
            'research',
            'pipeline-789',
            new Error('test'),
        );
        expect(error.name).toBe('AgentExecutionError');
    });
});

// =============================================================================
// TESTS: Token Configuration Regression Suite
// =============================================================================

describe('Token Configuration — Regression Suite', () => {
    /**
     * Testing the specific configurations that caused production failures.
     * Each case represents a real misconfiguration that was deployed.
     */
    const REGRESSION_CASES = [
        {
            label: 'research-agent (4096 == 4096)',
            maxTokens: 4096,
            thinkingBudget: 4096,
        },
        {
            label: 'qa-agent (4096 < 8192)',
            maxTokens: 4096,
            thinkingBudget: 8192,
        },
        {
            label: 'writer-agent (8192 < 16000)',
            maxTokens: 8192,
            thinkingBudget: 16000,
        },
        {
            label: 'qa-legacy-bridge (4096 == 4096)',
            maxTokens: 4096,
            thinkingBudget: 4096,
        },
    ] satisfies Array<{ label: string; maxTokens: number; thinkingBudget: number }>;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each(REGRESSION_CASES)(
        'should reject $label',
        async ({ maxTokens, thinkingBudget }) => {
            const config = buildConfig(maxTokens, thinkingBudget);
            const ctx = buildPipelineContext();

            await expect(
                runAgent({
                    config,
                    userMessage: TEST_USER_MESSAGE,
                    parseResponse: (text: string) => text,
                    pipelineContext: ctx,
                }),
            ).rejects.toThrow('must be strictly greater than thinkingBudget');

            expect(mockSend).not.toHaveBeenCalled();
        },
    );

    /**
     * The CORRECTED configurations that should pass validation.
     */
    const CORRECTED_CASES = [
        {
            label: 'research-agent (8192 > 4096)',
            maxTokens: 8192,
            thinkingBudget: 4096,
        },
        {
            label: 'qa-agent (16384 > 8192)',
            maxTokens: 16384,
            thinkingBudget: 8192,
        },
        {
            label: 'writer-agent (32768 > 16000)',
            maxTokens: 32768,
            thinkingBudget: 16000,
        },
        {
            label: 'qa-legacy-bridge (8192 > 4096)',
            maxTokens: 8192,
            thinkingBudget: 4096,
        },
    ] satisfies Array<{ label: string; maxTokens: number; thinkingBudget: number }>;

    it.each(CORRECTED_CASES)(
        'should accept $label',
        async ({ maxTokens, thinkingBudget }) => {
            const config = buildConfig(maxTokens, thinkingBudget);
            const ctx = buildPipelineContext();

            mockSend.mockResolvedValueOnce(
                buildMockBedrockResponse('Valid output'),
            );

            const result = await runAgent({
                config,
                userMessage: TEST_USER_MESSAGE,
                parseResponse: (text: string) => text,
                pipelineContext: ctx,
            });

            expect(result.data).toBe('Valid output');
            expect(mockSend).toHaveBeenCalledTimes(1);
        },
    );
});

// =============================================================================
// TESTS: Edge Cases
// =============================================================================

describe('runAgent — Edge Cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should accept maxTokens exactly 1 more than thinkingBudget', async () => {
        const config = buildConfig(4097, 4096);
        const ctx = buildPipelineContext();

        mockSend.mockResolvedValueOnce(
            buildMockBedrockResponse('Minimal margin output'),
        );

        const result = await runAgent({
            config,
            userMessage: TEST_USER_MESSAGE,
            parseResponse: (text: string) => text,
            pipelineContext: ctx,
        });

        expect(result.data).toBe('Minimal margin output');
    });

    it('should accept large token budgets when constraint is satisfied', async () => {
        const config = buildConfig(65536, 32768);
        const ctx = buildPipelineContext();

        mockSend.mockResolvedValueOnce(
            buildMockBedrockResponse('Large budget output'),
        );

        const result = await runAgent({
            config,
            userMessage: TEST_USER_MESSAGE,
            parseResponse: (text: string) => text,
            pipelineContext: ctx,
        });

        expect(result.data).toBe('Large budget output');
    });
});
