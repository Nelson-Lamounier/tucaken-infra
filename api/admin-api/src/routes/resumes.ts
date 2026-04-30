/**
 * @format
 * admin-api — Resume management routes (PG-only after Phase 5).
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   GET    /api/admin/resumes              — List all resume summaries
 *   GET    /api/admin/resumes/active       — Get the currently active resume (with data)
 *   GET    /api/admin/resumes/:id          — Get a single resume by ID (with data)
 *   POST   /api/admin/resumes              — Create a new resume
 *   PUT    /api/admin/resumes/:id          — Update label and/or data
 *   DELETE /api/admin/resumes/:id          — Delete (guards against deleting the active one)
 *   POST   /api/admin/resumes/:id/activate — Set a resume as the publicly displayed one
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { AdminApiConfig } from '../lib/config.js';
import { getPool } from '../lib/pg.js';
import type { AdminApiBindings } from '../lib/types.js';
import {
    upsertResume,
    getResume as pgGetResume,
    listResumes,
    getActiveResume,
    deleteResume as pgDeleteResume,
    setActiveResume,
} from '../lib/repositories/resumes.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the resumes admin router.
 *
 * @param config - Resolved application configuration
 * @returns Hono router with full resume CRUD + activation routes
 */
export function createResumesRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes — list summaries
  // -------------------------------------------------------------------------
  router.get('/', async (ctx) => {
    const resumes = await listResumes(getPool(config));
    return ctx.json({ resumes, count: resumes.length });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes/active — active resume
  // Must be defined BEFORE /:id to take route precedence.
  // -------------------------------------------------------------------------
  router.get('/active', async (ctx) => {
    const resume = await getActiveResume(getPool(config));
    if (!resume) return ctx.json({ error: 'No active resume configured' }, 404);
    return ctx.json({ resume });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes/:id — fetch one
  // -------------------------------------------------------------------------
  router.get('/:id', async (ctx) => {
    const id = ctx.req.param('id');
    const resume = await pgGetResume(getPool(config), id);
    if (!resume) return ctx.json({ error: `Resume not found: ${id}` }, 404);
    return ctx.json({ resume });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/resumes — create
  // -------------------------------------------------------------------------
  router.post('/', async (ctx) => {
    const body = await ctx.req.json<{ label?: string; data?: Record<string, unknown> }>();

    if (!body.label || typeof body.label !== 'string' || body.label.trim().length === 0) {
      return ctx.json({ error: '"label" is required and must be a non-empty string' }, 400);
    }

    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return ctx.json({ error: '"data" is required and must be an object' }, 400);
    }

    const resumeId = randomUUID();
    const pool = getPool(config);
    await upsertResume(pool, {
      id:               resumeId,
      userId:           null,
      jobApplicationId: null,
      label:            body.label.trim(),
      isActive:         false,
      contentJson:      body.data,
      renderedHtml:     null,
    });
    const created = await pgGetResume(pool, resumeId);
    return ctx.json({ resume: created }, 201);
  });

  // -------------------------------------------------------------------------
  // PUT /api/admin/resumes/:id — update
  // -------------------------------------------------------------------------
  router.put('/:id', async (ctx) => {
    const id = ctx.req.param('id');
    const body = await ctx.req.json<{ label?: string; data?: Record<string, unknown> }>();

    if (!body.label && !body.data) {
      return ctx.json({ error: 'At least one of "label" or "data" must be provided' }, 400);
    }

    const pool = getPool(config);
    const existing = await pgGetResume(pool, id);
    if (!existing) return ctx.json({ error: `Resume not found: ${id}` }, 404);

    await upsertResume(pool, {
      ...existing,
      label:       body.label?.trim() ?? existing.label,
      contentJson: body.data          ?? existing.contentJson,
    });
    const updated = await pgGetResume(pool, id);
    return ctx.json({ resume: updated });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/admin/resumes/:id — delete (guards active)
  // -------------------------------------------------------------------------
  router.delete('/:id', async (ctx) => {
    const id = ctx.req.param('id');
    const pool = getPool(config);
    const existing = await pgGetResume(pool, id);
    if (!existing) return ctx.json({ error: `Resume not found: ${id}` }, 404);
    if (existing.isActive) {
      return ctx.json(
        { error: 'Cannot delete the active resume. Activate another resume first.' },
        409,
      );
    }
    await pgDeleteResume(pool, id);
    return ctx.json({ deleted: true, resumeId: id });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/resumes/:id/activate — set as active
  // -------------------------------------------------------------------------
  router.post('/:id/activate', async (ctx) => {
    const id = ctx.req.param('id');
    const pool = getPool(config);
    const target = await pgGetResume(pool, id);
    if (!target) return ctx.json({ error: `Resume not found: ${id}` }, 404);
    const currentActive = await getActiveResume(pool);
    await setActiveResume(pool, currentActive?.id ?? null, id);
    const activated = await pgGetResume(pool, id);
    return ctx.json({ resume: activated });
  });

  return router;
}
