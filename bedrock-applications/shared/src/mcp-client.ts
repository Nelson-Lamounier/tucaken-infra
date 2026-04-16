/**
 * @format
 * MCP HTTP Client — Streamable HTTP transport wrapper for Lambda functions.
 *
 * Calls tools on a remote MCP server (e.g. wiki-mcp on K8s) using the
 * Model Context Protocol Streamable HTTP transport.
 *
 * Each call opens a fresh session (connect → callTool → close) — safe for
 * Lambda where execution contexts are reused but MCP sessions have no TTL.
 *
 * Auth header (e.g. "Basic <base64>") is forwarded on every HTTP request
 * made by the transport (initialize, call, terminate).
 *
 * Usage:
 *   const text = await callMcpTool(
 *     'https://ops.example.com/wiki-mcp',
 *     'Basic dXNlcjpwYXNz',
 *     'get_resume_constraints',
 *     {},
 *   );
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Call a single tool on a remote MCP server and return its text output.
 *
 * @param serverUrl   - Base URL of the MCP server (e.g. `https://ops.example.com/wiki-mcp`).
 *                      `/mcp` is appended automatically.
 * @param authHeader  - Authorization header value (e.g. `"Basic dXNlcjpwYXNz"`).
 * @param toolName    - Registered tool name on the server.
 * @param toolArgs    - Tool arguments (must match the tool's input schema).
 * @param timeoutMs   - Per-call timeout in milliseconds (default: 15 000).
 * @returns Concatenated text content from the tool result.
 * @throws If the connection fails, the tool is not found, or the call times out.
 */
export async function callMcpTool(
    serverUrl: string,
    authHeader: string,
    toolName: string,
    toolArgs: Record<string, unknown> = {},
    timeoutMs = 15_000,
): Promise<string> {
    // Append '/mcp' as a relative segment — preserves the path prefix (e.g. /wiki-mcp/mcp).
    // new URL('/mcp', base) would strip the prefix because leading '/' makes it absolute.
    const base = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`;
    const mcpUrl = new URL('mcp', base);

    const client = new Client({ name: 'strategist-lambda', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: {
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(timeoutMs),
        },
    });

    try {
        await client.connect(transport);
        const result = await client.callTool({ name: toolName, arguments: toolArgs });
        // The SDK return type has `[x: string]: unknown` as an index signature,
        // so `.content` resolves to `unknown`. Cast via the documented shape.
        return extractText(result.content as ContentBlock[] | undefined);
    } finally {
        // Always close — releases the underlying SSE connection.
        await client.close().catch(() => { /* ignore close errors */ });
    }
}

// =============================================================================
// HELPERS
// =============================================================================

type ContentBlock = { type: string; text?: string };

/**
 * Extract plain text from MCP tool result content blocks.
 * Non-text blocks (image, resource) are skipped.
 */
function extractText(content: ContentBlock[] | undefined): string {
    if (!content?.length) return '';
    return content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
}
