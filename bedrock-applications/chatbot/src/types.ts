/**
 * @format
 * Chatbot Types
 *
 * Type definitions specific to the chatbot handler and agent.
 * These types define the HTTP API contract between API Gateway
 * and the chatbot Lambda function.
 *
 * Following the gold-standard pattern from the article pipeline,
 * types are extracted to a dedicated module rather than defined
 * inline within the handler.
 */

// =============================================================================
// REQUEST / RESPONSE CONTRACTS
// =============================================================================

/**
 * Parsed request body from API Gateway.
 *
 * @property prompt - The user's question (required, max 10,000 chars)
 * @property sessionId - Optional UUID for conversation continuity
 */
export interface InvokeRequestBody {
    /** The user's question or message */
    readonly prompt: string;
    /** Optional session ID for conversation continuity (UUID v4 format) */
    readonly sessionId?: string;
    /**
     * Optional caller role hint — used to adapt response depth and framing
     * via `promptSessionAttributes` on the Bedrock Agent invocation.
     *
     * @default 'unknown'
     */
    readonly callerRole?: CallerRole;
}

/**
 * Successful response payload returned to the client.
 *
 * @property response - The agent's sanitised text reply
 * @property sessionId - The session ID (generated if not provided in request)
 */
export interface InvokeResponseBody {
    /** The agent's text reply, after output sanitisation */
    readonly response: string;
    /** Session ID for conversation continuity */
    readonly sessionId: string;
}

// =============================================================================
// CALLER CONTEXT (Gap A3)
// =============================================================================

/**
 * Caller role hint — informs the agent how to frame its responses.
 *
 * - `recruiter`: emphasise achievements, outcomes, and team impact
 * - `engineer`: include technical depth, architecture rationale
 * - `unknown`: balanced default; no framing adjustment
 */
export type CallerRole = 'recruiter' | 'engineer' | 'unknown';

/**
 * Caller context passed as `promptSessionAttributes` to the Bedrock Agent.
 *
 * Bedrock surfaces these as session-scoped key–value pairs that the agent
 * instruction can reference via `$session.promptSessionAttributes.callerRole`.
 */
export interface ChatbotCallerContext {
    /** Resolved caller role (never undefined — defaults to 'unknown') */
    readonly callerRole: CallerRole;
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Error response payload returned on validation or server errors.
 *
 * @property error - Machine-readable error code
 * @property message - Human-readable error description
 */
export interface ErrorResponseBody {
    /** Machine-readable error code (e.g. 'BadRequest', 'TooManyRequests') */
    readonly error: string;
    /** Human-readable error description */
    readonly message: string;
}

// =============================================================================
// AGENT TYPES
// =============================================================================

/**
 * Configuration required to invoke the Bedrock Agent.
 *
 * These values come from environment variables, which are set
 * by CDK from SSM parameters during deployment.
 */
export interface ChatbotAgentConfig {
    /** Bedrock Agent ID */
    readonly agentId: string;
    /** Bedrock Agent Alias ID */
    readonly agentAliasId: string;
}

/**
 * Result of a successful chatbot agent invocation.
 *
 * Contains the raw response text (before output sanitisation)
 * and timing information for EMF metrics.
 */
export interface ChatbotInvocationResult {
    /** The raw agent response text (before sanitisation) */
    readonly response: string;
    /** Invocation duration in milliseconds */
    readonly durationMs: number;
}

// =============================================================================
// SECURITY TYPES
// =============================================================================

/**
 * Result of input sanitisation check.
 *
 * @property sanitised - The normalised prompt text (empty if blocked)
 * @property blocked - Whether the input was blocked by a pattern match
 * @property matchedPattern - The label of the matched pattern, if blocked
 */
export interface SanitiseInputResult {
    /** The sanitised (trimmed, normalised) prompt text */
    readonly sanitised: string;
    /** Whether the input was blocked by a pattern match */
    readonly blocked: boolean;
    /** The label of the matched pattern, if blocked */
    readonly matchedPattern?: string;
}
