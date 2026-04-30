/**
 * @format
 * admin-api — Cognito JWT authentication + admin group enforcement middleware.
 *
 * Validates Cognito-issued JWTs using JWKS from the User Pool's well-known
 * endpoint, then enforces membership in the Cognito 'admin' group.
 *
 * Flow:
 *   Authorization: Bearer <cognito-id-token>
 *     → Extract token
 *     → Fetch JWKS from Cognito (cached by jose)
 *     → Verify signature, issuer, audience, expiry
 *     → Check cognito:groups includes 'admin'  ← 403 if not a member
 *     → Attach decoded payload to ctx.set('jwtPayload', payload)
 *     → Continue to handler
 *
 * Why Cognito Groups instead of a DB role check:
 *   Group membership travels in the signed JWT — no extra DB round-trip on
 *   every request. Adding/removing an admin is a single Cognito API call;
 *   the next token refresh automatically reflects the change.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Context, MiddlewareHandler, Next } from 'hono';

const REQUIRED_GROUP = 'admin';

/** JWKS caches per pool ID to avoid redundant HTTP fetches. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(userPoolId: string, region: string): ReturnType<typeof createRemoteJWKSet> {
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
 * by downstream route handlers. Rejects tokens not in the 'admin' group.
 *
 * @param userPoolId - Cognito User Pool ID (COGNITO_USER_POOL_ID env var).
 * @param clientId   - Cognito app client ID (COGNITO_CLIENT_ID env var).
 * @param issuerUrl  - Cognito issuer URL (COGNITO_ISSUER_URL env var).
 * @param region     - AWS region (AWS_DEFAULT_REGION env var).
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
    const jwks  = getJwks(userPoolId, region);

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer:   issuerUrl,
        audience: clientId,
      });
      payload = result.payload as JWTPayload;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token validation failed';
      ctx.res = new Response(
        JSON.stringify({ error: 'Unauthorised', detail: message }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
      return;
    }

    // Enforce Cognito group membership — admin-api is staff-only.
    const groups = (payload['cognito:groups'] as string[] | undefined) ?? [];
    if (!groups.includes(REQUIRED_GROUP)) {
      ctx.res = new Response(
        JSON.stringify({ error: 'Forbidden', detail: `Requires '${REQUIRED_GROUP}' group membership` }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
      return;
    }

    ctx.set('jwtPayload', payload);
    await next();
  };
}
