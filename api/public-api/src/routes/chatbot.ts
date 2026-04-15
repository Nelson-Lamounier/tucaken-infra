/**
 * @file chatbot.ts
 * @description BFF proxy route for the Bedrock chatbot API (Gap S2).
 *
 * Proxies POST /api/chatbot/invoke to the Bedrock API Gateway, injecting
 * the API key server-side so the browser never sees it.
 *
 * ## Key flow
 *
 * 1. Browser  → POST /api/chatbot/invoke  (no x-api-key header)
 * 2. public-api fetches the API key from Secrets Manager on first request
 *    (cached in module scope; EC2 instance profile provides credentials)
 * 3. public-api → POST {BEDROCK_API_URL}invoke  (with x-api-key header)
 * 4. Response forwarded back to browser
 *
 * ## Configuration (from ConfigMap — both optional)
 *
 *   BEDROCK_API_URL           — e.g. https://id.execute-api.eu-west-1.amazonaws.com/v1/
 *   BEDROCK_API_KEY_SECRET_ARN — Secrets Manager ARN for the chatbot API key
 *
 * If either is absent the route returns 503 so misconfiguration is visible
 * immediately rather than failing silently at query time.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Hono } from 'hono';

import { loadConfig } from '../lib/config.js';

// =============================================================================
// Secrets Manager client — credentials resolved via EC2 instance profile
// =============================================================================

const secretsClient = new SecretsManagerClient({});

/**
 * Re-fetch interval for the cached API key.
 *
 * On each request the cache age is checked. When the TTL has elapsed the
 * next call transparently re-fetches from Secrets Manager, so a rotated key
 * is picked up within KEY_TTL_MS without a pod restart.
 *
 * 15 minutes is well below any realistic rotation schedule (90 days) while
 * keeping Secrets Manager API calls negligible (~96 calls/day per pod).
 */
const KEY_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CachedKey {
  readonly value: string;
  /** Absolute timestamp (Date.now()) after which the cache is stale. */
  readonly expiresAt: number;
}

let _cache: CachedKey | undefined;

/**
 * Retrieve (and TTL-cache) the Bedrock API key from Secrets Manager.
 *
 * Returns the cached value while fresh. Re-fetches transparently once the
 * TTL expires so rotated keys propagate without restarting the pod.
 *
 * @param secretArn - Full ARN of the Secrets Manager secret
 * @returns The plain-string API key value
 * @throws Error if the secret has no value
 */
async function getApiKey(secretArn: string): Promise<string> {
  if (_cache !== undefined && Date.now() < _cache.expiresAt) return _cache.value;

  const resp = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  if (!resp.SecretString) {
    throw new Error(`[chatbot-bff] Secrets Manager secret has no value: ${secretArn}`);
  }

  _cache = { value: resp.SecretString, expiresAt: Date.now() + KEY_TTL_MS };
  return _cache.value;
}

// =============================================================================
// Route
// =============================================================================

const chatbot = new Hono();

/**
 * POST /api/chatbot/invoke
 *
 * Proxies the request body to the Bedrock chatbot API Gateway.
 * Accepts the same payload as the upstream Lambda:
 *   { prompt: string, sessionId?: string, callerRole?: string }
 *
 * Returns the upstream response body and status code unchanged.
 */
chatbot.post('/api/chatbot/invoke', async (c) => {
  const cfg = loadConfig();

  if (!cfg.bedrockApiUrl || !cfg.bedrockApiKeySecretArn) {
    console.error(
      '[chatbot-bff] BEDROCK_API_URL or BEDROCK_API_KEY_SECRET_ARN not configured',
    );
    return c.json(
      { error: 'ChatbotUnavailable', message: 'Chatbot service is not configured' },
      503,
    );
  }

  let apiKey: string;
  try {
    apiKey = await getApiKey(cfg.bedrockApiKeySecretArn);
  } catch (err) {
    console.error('[chatbot-bff] Failed to retrieve API key from Secrets Manager:', err);
    return c.json(
      { error: 'InternalError', message: 'Failed to initialise chatbot service' },
      500,
    );
  }

  // Ensure the upstream URL ends with a slash before appending 'invoke'
  const upstreamUrl = cfg.bedrockApiUrl.endsWith('/')
    ? `${cfg.bedrockApiUrl}invoke`
    : `${cfg.bedrockApiUrl}/invoke`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API key stays server-side — the browser only talks to /api/chatbot/invoke
        'x-api-key': apiKey,
      },
      body: c.req.raw.body,
    });
  } catch (err) {
    console.error('[chatbot-bff] Upstream fetch failed:', err);
    return c.json(
      { error: 'UpstreamError', message: 'Failed to reach chatbot upstream' },
      502,
    );
  }

  const data: unknown = await upstream.json();
  return c.json(data, upstream.status as Parameters<typeof c.json>[1]);
});

export default chatbot;
