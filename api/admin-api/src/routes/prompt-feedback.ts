/**
 * @format
 * admin-api — Prompt quality feedback routes.
 *
 * Routes (all under /api/admin/prompt-feedback):
 *   POST /           — submit thumbs-up/down on a generated resume
 *   GET  /stats      — aggregated quality metrics for the admin dashboard
 */
import { Hono } from 'hono';
import type { AdminApiConfig } from '../lib/config.js';
import { getPool } from '../lib/pg.js';
import { requireUserId } from '../lib/types.js';
import type { AdminApiBindings } from '../lib/types.js';
import {
  createPromptFeedback,
  getPromptQualityStats,
} from '../lib/repositories/prompt-observability.js';

export function createPromptFeedbackRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();
  const pool   = getPool(config);

  // ─── POST / ───────────────────────────────────────────────────────────────
  // Submit a thumbs-up (+1) or thumbs-down (-1) rating.
  //
  // Body:
  //   invocationId?       — UUID of the prompt_invocations row (optional)
  //   rating              — 1 or -1
  //   feedbackText?       — free-text note from the user
  //   feedbackCategories? — string[] of issue tags
  // ──────────────────────────────────────────────────────────────────────────
  router.post('/', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    let body: {
      invocationId?: string;
      rating?: unknown;
      feedbackText?: string;
      feedbackCategories?: string[];
    };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json({ error: 'Body must be valid JSON' }, 400);
    }

    if (body.rating !== 1 && body.rating !== -1) {
      return ctx.json({ error: '"rating" must be 1 (thumbs up) or -1 (thumbs down)' }, 400);
    }

    const feedback = await createPromptFeedback(pool, {
      invocationId:       body.invocationId ?? null,
      userId,
      rating:             body.rating as 1 | -1,
      feedbackText:       body.feedbackText ?? null,
      feedbackCategories: body.feedbackCategories ?? [],
    });

    return ctx.json({ feedback }, 201);
  });

  // ─── GET /stats ───────────────────────────────────────────────────────────
  // Aggregated quality metrics grouped by (pipeline, agent).
  // Optional ?days= query param (default: 30).
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/stats', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const days = parseInt(ctx.req.query('days') ?? '30', 10);
    if (isNaN(days) || days < 1 || days > 365) {
      return ctx.json({ error: '"days" must be between 1 and 365' }, 400);
    }

    const stats = await getPromptQualityStats(pool, days);
    return ctx.json({ stats });
  });

  return router;
}
