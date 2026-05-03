/**
 * @format
 * /api/public/* — unauthenticated endpoints safe to call before sign-in.
 *
 * These routes are registered BEFORE the Cognito JWT middleware in index.ts
 * and carry no user context. Keep them read-only and non-sensitive.
 *
 * GET /email-exists?email=<address>
 *   Returns { exists: boolean } — used by the sign-up form to detect
 *   cross-provider duplicates (e.g. Google user trying to register with
 *   email/password) before Cognito creates a conflicting native user.
 */
import { Hono } from 'hono';
import type { AdminApiConfig } from '../lib/config.js';
import { getPool } from '../lib/pg.js';
import { userExistsByEmail } from '../lib/repositories/users.js';

export function createPublicRouter(config: AdminApiConfig): Hono {
  const router = new Hono();

  router.get('/email-exists', async (ctx) => {
    const email = ctx.req.query('email')?.trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return ctx.json({ error: 'Valid email required' }, 400);
    }

    const exists = await userExistsByEmail(getPool(config), email);
    return ctx.json({ exists });
  });

  return router;
}
