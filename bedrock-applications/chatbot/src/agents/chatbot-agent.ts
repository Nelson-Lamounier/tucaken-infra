/**
 * @format
 * Chatbot Agent — Bedrock Agent Runtime Invocation
 *
 * Encapsulates the Bedrock Agent invocation logic, separated from
 * the Lambda handler following the gold-standard article pipeline
 * pattern (agents/ directory holds business logic, handlers/ holds
 * HTTP glue).
 *
 * This agent uses the Bedrock Agent Runtime API (`InvokeAgentCommand`)
 * with streaming responses, which is fundamentally different from
 * the article pipeline's `ConverseCommand`-based `runAgent()` in shared.
 * The InvokeAgent API calls a managed Bedrock Agent (with guardrails,
 * instructions, and knowledge base), while Converse calls the model
 * directly with custom prompt engineering.
 *
 * @example
 * ```typescript
 * import { invokeChatbotAgent } from '../agents/chatbot-agent.js';
 *
 * const result = await invokeChatbotAgent(
 *     { agentId: 'abc123', agentAliasId: 'alias456' },
 *     'Tell me about the infrastructure',
 *     '550e8400-e29b-41d4-a716-446655440000',
 * );
 *
 * console.log(result.response);   // Agent's text reply
 * console.log(result.durationMs); // Invocation timing
 * ```
 */

import {
    BedrockAgentRuntimeClient,
    InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

import type { ChatbotAgentConfig, ChatbotCallerContext, ChatbotInvocationResult } from '../types.js';

// =============================================================================
// CLIENT INITIALISATION
// =============================================================================

/**
 * Bedrock Agent Runtime client instance.
 *
 * Initialised at module scope so it is reused across warm Lambda
 * invocations, benefiting from connection pooling and credential caching.
 */
const client = new BedrockAgentRuntimeClient({});

// =============================================================================
// AGENT INVOCATION
// =============================================================================

/**
 * Invoke the Bedrock Agent and collect the streaming response.
 *
 * The InvokeAgent API returns an event stream. Each `chunk` event
 * contains a `bytes` field with a UTF-8 encoded fragment of the
 * agent's response text. All chunks are concatenated to build the
 * complete response.
 *
 * This function contains **only** agent invocation logic — no HTTP
 * concerns, no CORS, no request parsing. Those remain in the handler.
 *
 * @param config - Agent ID and alias ID configuration
 * @param prompt - The sanitised user prompt text
 * @param sessionId - Session ID for conversation continuity
 * @param callerContext - Optional caller context for response framing (Gap A3)
 * @returns The agent's complete text response with timing
 * @throws Error if no completion stream is returned
 */
export async function invokeChatbotAgent(
    config: ChatbotAgentConfig,
    prompt: string,
    sessionId: string,
    callerContext?: ChatbotCallerContext,
): Promise<ChatbotInvocationResult> {
    const startTime = Date.now();

    const command = new InvokeAgentCommand({
        agentId: config.agentId,
        agentAliasId: config.agentAliasId,
        sessionId,
        inputText: prompt,
        // Gap A3: Inject caller context as session attributes so the agent
        // instruction can adapt response framing via:
        // $session.promptSessionAttributes.callerRole
        promptSessionAttributes: callerContext
            ? { callerRole: callerContext.callerRole }
            : undefined,
    });

    const response = await client.send(command);

    if (!response.completion) {
        throw new Error('No completion stream returned from Bedrock Agent');
    }

    const chunks: string[] = [];

    for await (const event of response.completion) {
        if ('chunk' in event && event.chunk?.bytes) {
            const text = new TextDecoder('utf-8').decode(event.chunk.bytes);
            chunks.push(text);
        }
    }

    return {
        response: chunks.join(''),
        durationMs: Date.now() - startTime,
    };
}
