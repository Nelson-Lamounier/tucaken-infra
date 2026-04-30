/**
 * @format
 * admin-api — User provisioning middleware.
 *
 * Runs after cognitoJwtAuth on every /api/admin/* request.
 * On the first request for a given Cognito sub, upserts a row into users
 * and caches the resolved users.id for the lifetime of the pod.
 *
 * Cache rationale:
 *   - Avoids a DB write on every request for already-provisioned users.
 *   - A pod restart re-runs the upsert (idempotent — safe).
 *   - Sub → users.id mapping never changes after provisioning.
 *
 * Failure handling:
 *   - Provisioning failure is logged but never blocks the request.
 *   - Worst case: the users row is missing and child-table inserts will fail
 *     at the FK constraint — surfacing as a 500 from the relevant route rather
 *     than silently corrupting data.
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { Pool } from 'pg';
import type { AdminApiBindings } from '../lib/types.js';
import { upsertUser } from '../lib/repositories/users.js';

/** sub → users.id cache, lives for the lifetime of the pod process. */
const subToUserId = new Map<string, string>();

export function userProvisionMiddleware(pool: Pool): MiddlewareHandler<AdminApiBindings> {
  return async (ctx: Context<AdminApiBindings>, next: Next): Promise<void> => {
    const payload = ctx.get('jwtPayload');
    const sub     = payload?.sub;

    if (!sub) {
      await next();
      return;
    }

    // Fast path — already provisioned in this pod's lifetime
    const cached = subToUserId.get(sub);
    if (cached) {
      ctx.set('userId', cached);
      await next();
      return;
    }

    // Slow path — first request for this sub in this pod
    try {
      const { id } = await upsertUser(pool, {
        cognitoSub: sub,
        email:      (payload['email']   as string) ?? '',
        fullName:   (payload['name']    as string) ?? undefined,
        avatarUrl:  (payload['picture'] as string) ?? undefined,
      });
      subToUserId.set(sub, id);
      ctx.set('userId', id);
    } catch (err) {
      console.error('[user-provision] upsert failed', { sub, err });
    }

    await next();
  };
}
