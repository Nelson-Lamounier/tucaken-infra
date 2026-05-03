/**
 * @format
 * /api/admin/me — current user profile + plan status.
 *
 * Called by the frontend once after login to trigger user provisioning and
 * hydrate the UI with profile and plan data. Safe to call on every page load —
 * userProvisionMiddleware makes the upsert idempotent.
 */
import { Hono } from 'hono';
import type { AdminApiConfig } from '../lib/config.js';
import type { AdminApiBindings } from '../lib/types.js';
import { getPool } from '../lib/pg.js';
import { getUserPlanStatus } from '../lib/repositories/users.js';

export function createMeRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  /**
   * GET /api/admin/me
   *
   * Returns the authenticated user's profile and plan status.
   * The act of calling this endpoint triggers userProvisionMiddleware,
   * which creates the users row on first sign-in.
   */
  router.get('/', async (ctx) => {
    const userId    = ctx.get('userId');
    const isNewUser = ctx.get('isNewUser') ?? false;
    const payload   = ctx.get('jwtPayload');

    if (!userId) {
      return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);
    }

    // Query users directly on the superuser pool — no RLS needed here.
    // tucaken_app role may not have SELECT on users; this is a scoped
    // read already protected by the userId from auth middleware.
    const plan = await getUserPlanStatus(getPool(config), userId);

    return ctx.json({
      id:        userId,
      email:     payload['email']   as string,
      name:      payload['name']    as string | undefined,
      avatarUrl: payload['picture'] as string | undefined,
      isNew:     isNewUser,
      plan:      plan ?? {
        plan:                 'free',
        effectivePlan:        'free',
        trialStartedAt:       null,
        trialEndsAt:          null,
        trialDaysRemaining:   null,
        subscriptionStatus:   null,
        stripeCustomerId:     null,
        stripeSubscriptionId: null,
      },
    });
  });

  return router;
}
