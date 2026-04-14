/**
 * @format
 * admin-api — Cognito JWT authentication middleware.
 *
 * Validates Cognito-issued JWTs using JWKS (JSON Web Key Sets) from the
 * Cognito User Pool's well-known endpoint. This avoids storing static secrets
 * and ensures token validation always uses the current signing keys.
 *
 * Flow:
 *   Authorization: Bearer <cognito-id-token>
 *     → Extract token
 *     → Fetch JWKS from Cognito (cached by jose)
 *     → Verify signature, issuer, audience, expiry
 *     → Attach decoded payload to ctx.set('jwtPayload', payload)
 *     → Continue to handler
 *
 * JWKS caching: jose's createRemoteJWKSet caches keys in-memory per instance.
 * For long-running processes, keys rotate automatically when a new JWT
 * references a different kid not in the cache.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Context, MiddlewareHandler, Next } from 'hono';

/** JWKS caches per pool ID to avoid redundant HTTP fetches. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Get or create a JWKS key set for the given Cognito User Pool.
 *
 * @param userPoolId - Cognito User Pool ID.
 * @param region - AWS region the pool is in.
 * @returns Cached JWKS key set fetcher.
 */
function getJwks(
  userPoolId: string,
  region: string,
): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache.has(userPoolId)) {
    const url = new URL(
      `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
    );
    jwksCache.set(userPoolId, createRemoteJWKSet(url));
  }
  return jwksCache.get(userPoolId)!;
}

/**
 * Cognito JWT bearer middleware for Hono.
 *
 * Attaches the decoded JWT payload to `ctx.get('jwtPayload')` for use
 * by downstream route handlers.
 *
 * @param userPoolId - Cognito User Pool ID (from COGNITO_USER_POOL_ID env var).
 * @param clientId - Cognito app client ID (from COGNITO_CLIENT_ID env var).
 * @param issuerUrl - Cognito issuer URL (from COGNITO_ISSUER_URL env var).
 * @param region - AWS region (from AWS_DEFAULT_REGION env var).
 * @returns Hono middleware handler.
 */
export function cognitoJwtAuth(
  userPoolId: string,
  clientId: string,
  issuerUrl: string,
  region: string,
): MiddlewareHandler {
  return async (ctx: Context, next: Next): Promise<void> => {
    const authHeader = ctx.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      ctx.res = new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
      return;
    }

    const token = authHeader.slice(7);
    const jwks = getJwks(userPoolId, region);

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: issuerUrl,
        audience: clientId,
      });
      ctx.set('jwtPayload', payload as JWTPayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token validation failed';
      ctx.res = new Response(
        JSON.stringify({ error: 'Unauthorised', detail: message }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
      return;
    }

    await next();
  };
}
