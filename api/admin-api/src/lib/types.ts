/**
 * @format
 * Shared Hono context variable bindings for all admin-api authenticated routes.
 *
 * jwtPayload — set by cognitoJwtAuth middleware on every /api/admin/* request.
 * userId     — set by userProvisionMiddleware; resolves to users.id UUID (the FK
 *              anchor for all child tables). Use this — not jwtPayload.sub — as
 *              the user_id value in all DB writes and as the RLS scope in withUser().
 */
import type { JWTPayload } from 'jose';

export type AdminApiBindings = {
  Variables: {
    jwtPayload: JWTPayload;
    /** users.id UUID — the stable FK anchor. Set by userProvisionMiddleware. */
    userId: string;
  };
};

/**
 * Extract the provisioned userId from context or return a 503 Response.
 * Call at the top of any route handler that touches an RLS-protected table.
 */
export function requireUserId(ctx: { get: (key: 'userId') => string | undefined }): string | null {
  return ctx.get('userId') ?? null;
}
