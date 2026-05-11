/**
 * @format
 * admin-api — Bedrock cost tracking routes (admin-only).
 *
 * Routes (all under /api/admin/bedrock-usage, guarded by requireAdminGroup):
 *   GET  /summary          — prompt_invocations rows + aggregates for the Cost tab
 *   GET  /budget/:userId   — monthly limit and alert threshold for a user
 *   PUT  /budget/:userId   — update a user's monthly limit and alert threshold
 */
import { Hono } from 'hono';

import type { AdminApiConfig } from '../lib/config.js';
import { getPool } from '../lib/pg.js';
import {
  getUsageSummary,
  getUserBudget,
  setUserBudget,
} from '../lib/repositories/bedrock-usage.js';
import type { AdminApiBindings } from '../lib/types.js';

export function createBedrockUsageRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();
  const pool   = getPool(config);

  // ─── GET /summary ──────────────────────────────────────────────────────────
  // Returns prompt_invocations rows for the Cost tab with aggregated totals.
  //
  // Query params:
  //   userId? — filter to a single user UUID
  //   month?  — YYYY-MM (defaults to current calendar month)
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/summary', async (ctx) => {
    const userId = ctx.req.query('userId') || undefined;
    const month  = ctx.req.query('month')  || undefined;

    if (userId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return ctx.json({ error: '"userId" must be a valid UUID' }, 400);
    }
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      return ctx.json({ error: '"month" must be in YYYY-MM format' }, 400);
    }

    const summary = await getUsageSummary(pool, userId, month);
    return ctx.json(summary);
  });

  // ─── GET /budget/:userId ───────────────────────────────────────────────────
  // Returns the monthly token budget for a specific user.
  // Returns 404 if no budget row exists yet (user has not triggered a Bedrock call).
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/budget/:userId', async (ctx) => {
    const { userId } = ctx.req.param();
    const budget = await getUserBudget(pool, userId);
    if (!budget) return ctx.json({ error: 'No budget record found for this user' }, 404);
    return ctx.json(budget);
  });

  // ─── PUT /budget/:userId ───────────────────────────────────────────────────
  // Upserts monthly limit and alert threshold for a user.
  //
  // Body:
  //   monthlyLimitCents  — integer cents (0–100 000)
  //   alertThresholdPct  — integer percentage (1–100)
  // ──────────────────────────────────────────────────────────────────────────
  router.put('/budget/:userId', async (ctx) => {
    const { userId } = ctx.req.param();

    let body: { monthlyLimitCents?: unknown; alertThresholdPct?: unknown };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json({ error: 'Body must be valid JSON' }, 400);
    }

    const { monthlyLimitCents, alertThresholdPct } = body;

    if (
      typeof monthlyLimitCents !== 'number' ||
      !Number.isInteger(monthlyLimitCents) ||
      monthlyLimitCents < 0 ||
      monthlyLimitCents > 100_000
    ) {
      return ctx.json({ error: '"monthlyLimitCents" must be an integer between 0 and 100 000' }, 400);
    }
    if (
      typeof alertThresholdPct !== 'number' ||
      !Number.isInteger(alertThresholdPct) ||
      alertThresholdPct < 1 ||
      alertThresholdPct > 100
    ) {
      return ctx.json({ error: '"alertThresholdPct" must be an integer between 1 and 100' }, 400);
    }

    await setUserBudget(pool, userId, monthlyLimitCents, alertThresholdPct);
    return ctx.json({ ok: true });
  });

  return router;
}
