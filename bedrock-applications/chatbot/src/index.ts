/**
 * @format
 * Bedrock Agent Invoke Handler — API Gateway Lambda Proxy
 *
 * Thin handler following the gold-standard article pipeline pattern.
 * HTTP concerns (CORS, request parsing, response building) live here;
 * business logic is delegated to extracted modules:
 *
 * - **agents/chatbot-agent** — Bedrock Agent invocation + streaming
 * - **security/input-sanitiser** — Injection pattern blocking (Layer 2)
 * - **security/output-sanitiser** — Sensitive pattern redaction (Layer 5)
 * - **shared/logger** — Structured JSON logging
 * - **shared/emf** — CloudWatch Embedded Metric Format emission
 *
 * Defence-in-Depth Security Layers:
 *   Layer 1 — API Gateway: Schema validation + rate limiting + API Key
 *   Layer 2 — Lambda Input Guard: Sanitise + injection pattern blocking
 *   Layer 3 — Bedrock Guardrail: Content + topic denial + grounding
 *   Layer 4 — Agent Instruction: Scope fence + security directives
 *   Layer 5 — Output Filter: Regex-based sensitive pattern redaction
 *   Layer 6 — Audit Log: Structured JSON with prompt hash + redaction flags
 *
 * Environment Variables:
 *   AGENT_ID        — Bedrock Agent ID (from SSM)
 *   AGENT_ALIAS_ID  — Bedrock Agent Alias ID (from SSM)
 *   ALLOWED_ORIGINS — Comma-separated CORS origins (default: '*')
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
} from 'aws-lambda';

import { log, emitEmfMetric } from '../../shared/src/index.js';
import { invokeChatbotAgent } from './agents/chatbot-agent.js';
import { sanitiseInput } from './security/input-sanitiser.js';
import { sanitiseOutput } from './security/output-sanitiser.js';
import type {
    InvokeRequestBody,
    InvokeResponseBody,
    ErrorResponseBody,
    CallerRole,
    ChatbotCallerContext,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Maximum prompt length (validated by API Gateway, belt-and-braces check) */
const MAX_PROMPT_LENGTH = 10_000;

/** UUID v4 format regex for session ID validation */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** EMF metric namespace for chatbot observability */
const EMF_NAMESPACE = 'BedrockChatbot';

// =============================================================================
// Environment Variable Validation
// =============================================================================

/**
 * Safely retrieve a required environment variable.
 * Throws a descriptive error if the variable is missing or empty.
 *
 * @param name - Environment variable name
 * @returns The environment variable value
 * @throws Error if the variable is missing or empty
 */
function requireEnvVar(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `Missing required environment variable: ${name}. ` +
            'Ensure the Lambda function is configured with all required environment variables.',
        );
    }
    return value;
}

/**
 * Lazily-validated environment configuration.
 * Variables are validated at first handler invocation, not at module load,
 * to allow test modules to set process.env before importing.
 */
let envConfig: { agentId: string; agentAliasId: string; allowedOrigins: string } | undefined;

/**
 * Retrieve validated environment configuration.
 * Caches the result after first successful validation.
 *
 * @returns Validated environment configuration
 * @throws Error if required variables are missing
 */
function getEnvConfig(): { agentId: string; agentAliasId: string; allowedOrigins: string } {
    envConfig ??= {
        agentId: requireEnvVar('AGENT_ID'),
        agentAliasId: requireEnvVar('AGENT_ALIAS_ID'),
        allowedOrigins: process.env.ALLOWED_ORIGINS ?? '*',
    };
    return envConfig;
}

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Resolve the CORS origin header based on the request origin.
 *
 * @param requestOrigin - The Origin header from the incoming request
 * @returns The origin to set in Access-Control-Allow-Origin
 */
function resolveOrigin(requestOrigin?: string): string {
    const { allowedOrigins } = getEnvConfig();
    if (allowedOrigins === '*') return '*';

    const allowed = allowedOrigins.split(',').map(o => o.trim());
    if (requestOrigin && allowed.includes(requestOrigin)) {
        return requestOrigin;
    }

    return allowed[0] ?? '*';
}

/**
 * Build a standardised API Gateway proxy response.
 *
 * @param statusCode - HTTP status code
 * @param body - Response body object
 * @param origin - CORS origin header value
 * @returns API Gateway proxy result
 */
function buildResponse(
    statusCode: number,
    body: InvokeResponseBody | ErrorResponseBody,
    origin: string,
): APIGatewayProxyResult {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
        },
        body: JSON.stringify(body),
    };
}

// =============================================================================
// Request Parsing & Validation
// =============================================================================

/**
 * Parse and validate the incoming API Gateway event body.
 *
 * @param event - API Gateway proxy event
 * @param origin - Resolved CORS origin
 * @returns Parsed body and session ID, or an error response
 */
function parseAndValidateRequest(
    event: APIGatewayProxyEvent,
    origin: string,
): { body: InvokeRequestBody; sessionId: string } | APIGatewayProxyResult {
    if (!event.body) {
        return buildResponse(400, {
            error: 'BadRequest',
            message: 'Request body is required',
        }, origin);
    }

    let body: InvokeRequestBody;
    try {
        body = JSON.parse(event.body);
    } catch {
        log('WARN', 'Malformed JSON body received', {
            bodyPreview: event.body.substring(0, 100),
        });
        return buildResponse(400, {
            error: 'BadRequest',
            message: 'Request body must be valid JSON',
        }, origin);
    }

    if (!body.prompt || typeof body.prompt !== 'string') {
        return buildResponse(400, {
            error: 'BadRequest',
            message: 'prompt is required and must be a string',
        }, origin);
    }

    if (body.prompt.length > MAX_PROMPT_LENGTH) {
        return buildResponse(400, {
            error: 'BadRequest',
            message: `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`,
        }, origin);
    }

    let sessionId: string;
    if (body.sessionId) {
        if (!UUID_REGEX.test(body.sessionId)) {
            return buildResponse(400, {
                error: 'BadRequest',
                message: 'sessionId must be a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)',
            }, origin);
        }
        sessionId = body.sessionId;
    } else {
        sessionId = randomUUID();
    }

    return { body, sessionId };
}

// =============================================================================
// Error Classification
// =============================================================================

/**
 * Classify a caught error and return the appropriate HTTP response.
 *
 * @param err - The caught error
 * @param durationMs - Time elapsed since handler start
 * @param origin - Resolved CORS origin
 * @returns API Gateway proxy result
 */
function handleAgentError(
    err: unknown,
    durationMs: number,
    origin: string,
): APIGatewayProxyResult {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorName = err instanceof Error ? err.name : 'UnknownError';

    log('ERROR', 'Agent invocation failed', {
        error: errorMessage,
        errorName,
        durationMs,
    });

    emitEmfMetric(
        EMF_NAMESPACE,
        { Environment: process.env.CDK_ENV ?? 'development' },
        [
            { name: 'InvocationErrors', value: 1, unit: 'Count' },
            { name: 'InvocationLatency', value: durationMs, unit: 'Milliseconds' },
        ],
        { errorName },
    );

    if (errorName === 'ValidationException') {
        return buildResponse(400, {
            error: errorName,
            message: errorMessage,
        }, origin);
    }

    if (errorName === 'ThrottlingException') {
        return buildResponse(429, {
            error: 'TooManyRequests',
            message: 'Request rate exceeded. Please try again shortly.',
        }, origin);
    }

    if (errorMessage.startsWith('Missing required environment variable')) {
        log('ERROR', 'Lambda misconfiguration detected', { error: errorMessage });
        return buildResponse(500, {
            error: 'ConfigurationError',
            message: 'Agent not configured',
        }, origin);
    }

    return buildResponse(500, {
        error: 'InternalError',
        message: 'Failed to invoke agent',
    }, origin);
}

// =============================================================================
// Lambda Handler
// =============================================================================

/**
 * API Gateway Lambda proxy handler for Bedrock Agent invocation.
 *
 * Implements defence-in-depth security:
 * - Input sanitisation (injection pattern blocking)
 * - Session ID format validation
 * - Output sanitisation (sensitive pattern redaction)
 * - EMF metric emission
 * - Structured audit logging
 *
 * Expects a JSON body with:
 * - `prompt` (string, required) — the user's question
 * - `sessionId` (string, optional) — for conversation continuity (UUID format)
 *
 * Returns:
 * - `response` (string) — the agent's text reply (sanitised)
 * - `sessionId` (string) — the session ID (generated if not provided)
 *
 * @param event - API Gateway proxy event
 * @returns API Gateway proxy result
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const origin = resolveOrigin(event.headers?.origin ?? event.headers?.Origin);
    const startTime = Date.now();

    try {
        // Validate environment (lazy initialisation)
        const config = getEnvConfig();

        // =====================================================================
        // Parse + validate request
        // =====================================================================
        const parsed = parseAndValidateRequest(event, origin);
        if ('statusCode' in parsed) return parsed;

        const { body, sessionId } = parsed;

        // =====================================================================
        // Input sanitisation (Layer 2: Injection pattern blocking)
        // =====================================================================
        const inputCheck = sanitiseInput(body.prompt);
        if (inputCheck.blocked) {
            log('WARN', 'Input blocked by security filter', {
                sessionId,
                matchedPattern: inputCheck.matchedPattern,
                promptLength: body.prompt.length,
                origin: event.headers?.origin ?? 'unknown',
            });

            emitEmfMetric(
                EMF_NAMESPACE,
                { Environment: process.env.CDK_ENV ?? 'development' },
                [{ name: 'BlockedInputs', value: 1, unit: 'Count' }],
                { sessionId, matchedPattern: inputCheck.matchedPattern },
            );

            // Return a friendly message — do NOT mention "blocked" or security
            return buildResponse(200, {
                response: 'I can only help with questions about Nelson\'s portfolio projects, ' +
                    'skills, and career experience. Could you rephrase your question? ' +
                    'You can also visit nelsonlamounier.com for more information.',
                sessionId,
            }, origin);
        }

        log('INFO', 'Invoking Bedrock Agent', {
            agentId: config.agentId,
            sessionId,
            promptLength: body.prompt.length,
        });

        // =====================================================================
        // Resolve caller context (Gap A3)
        // =====================================================================
        const validCallerRoles: ReadonlyArray<CallerRole> = ['recruiter', 'engineer', 'unknown'];
        const resolvedRole: CallerRole =
            body.callerRole !== undefined && validCallerRoles.includes(body.callerRole)
                ? body.callerRole
                : 'unknown';
        const callerContext: ChatbotCallerContext = { callerRole: resolvedRole };

        // =====================================================================
        // Invoke the agent (delegated to agents/ module)
        // =====================================================================
        const result = await invokeChatbotAgent(
            { agentId: config.agentId, agentAliasId: config.agentAliasId },
            inputCheck.sanitised,
            sessionId,
            callerContext,
        );

        // =====================================================================
        // Output sanitisation (Layer 5: Sensitive pattern redaction)
        // =====================================================================
        const sanitisedResponse = sanitiseOutput(result.response);
        const wasRedacted = sanitisedResponse !== result.response;

        const durationMs = Date.now() - startTime;

        // =====================================================================
        // Structured audit log (Layer 6)
        // =====================================================================
        log('INFO', 'Agent invocation completed', {
            sessionId,
            promptLength: body.prompt.length,
            promptHash: createHash('sha256').update(body.prompt).digest('hex').substring(0, 16),
            responseLength: sanitisedResponse.length,
            durationMs,
            inputBlocked: false,
            outputRedacted: wasRedacted,
            callerRole: resolvedRole,
            origin: event.headers?.origin ?? 'unknown',
            userAgent: event.headers?.['user-agent']?.substring(0, 200) ?? 'unknown',
            ip: event.requestContext?.identity?.sourceIp ?? 'unknown',
        });

        // =====================================================================
        // EMF metrics
        // =====================================================================
        emitEmfMetric(
            EMF_NAMESPACE,
            { Environment: process.env.CDK_ENV ?? 'development' },
            [
                { name: 'InvocationCount', value: 1, unit: 'Count' },
                { name: 'InvocationLatency', value: durationMs, unit: 'Milliseconds' },
                { name: 'ResponseLength', value: sanitisedResponse.length, unit: 'Count' },
                { name: 'PromptLength', value: body.prompt.length, unit: 'Count' },
            ],
            { sessionId },
        );

        if (wasRedacted) {
            emitEmfMetric(
                EMF_NAMESPACE,
                { Environment: process.env.CDK_ENV ?? 'development' },
                [{ name: 'RedactedOutputs', value: 1, unit: 'Count' }],
                { sessionId },
            );
        }

        return buildResponse(200, {
            response: sanitisedResponse,
            sessionId,
        }, origin);

    } catch (err) {
        return handleAgentError(err, Date.now() - startTime, origin);
    }
}

// =============================================================================
// Re-exports for testing
// =============================================================================

export { sanitiseInput } from './security/input-sanitiser.js';
export { sanitiseOutput } from './security/output-sanitiser.js';
