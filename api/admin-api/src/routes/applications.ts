/**
 * @format
 * admin-api — Applications routes (PG-only after Phase 5).
 *
 * Exposes CRUD operations for the Job Applications pipeline data stored
 * in PostgreSQL. All routes are protected by Cognito JWT middleware
 * mounted at the parent level.
 *
 * Routes:
 *   GET    /                              — list applications (optional ?status= filter)
 *   GET    /:slug                         — full application detail (PG-assembled)
 *   DELETE /:slug                         — delete application
 *   POST   /:slug/status                  — update application status
 *   POST   /:slug/coach                   — schedule the coach K8s Job
 *   GET    /:slug/coaching/:stage         — read coaching_content row
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { JWTPayload } from 'jose';
import type { AdminApiConfig } from '../lib/config.js';
import { getJobImage, isImageConfigured } from '../lib/config.js';
import { getBatchApi } from '../lib/k8s.js';
import { buildPipelineJob, sanitizeLabel } from '../lib/k8s-job-builder.js';
import { getPool } from '../lib/pg.js';
import { insertPipelineRun } from '../lib/repositories/pipeline-runs.js';
import {
  listApplications,
  getApplication,
  updateApplicationStatus as pgUpdateStatus,
  deleteApplication as pgDeleteApplication,
} from '../lib/repositories/applications.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Application status values matching the pipeline contract. */
const VALID_STATUSES = new Set([
  'analysing',
  'analysis-ready',
  'failed',
  'interview-prep',
  'applied',
  'interviewing',
  'offer-received',
  'accepted',
  'withdrawn',
  'rejected',
]);

// ── Router factory ────────────────────────────────────────────────────────────

type AdminApiBindings = {
  Variables: { jwtPayload: JWTPayload };
};

/**
 * Creates the Hono router for application management routes.
 *
 * @param config - Validated admin-api configuration
 * @returns Hono router instance
 */
export function createApplicationsRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const app = new Hono<AdminApiBindings>();

  // ── GET / — list applications ─────────────────────────────────────────────
  app.get('/', async (ctx) => {
    const rawStatus = ctx.req.query('status');
    const apps = await listApplications(getPool(config), rawStatus ?? undefined);
    const summaries = apps.map((a) => ({
        slug:           a.id,
        targetCompany:  a.company,
        targetRole:     a.role,
        status:         a.kanbanStatus,
        jobUrl:         a.jobUrl ?? null,
        fitRating:      null,
        recommendation: null,
        interviewStage: 'applied',
        costUsd:        null,
        appliedAt:      a.appliedAt ?? null,
        createdAt:      a.createdAt ?? null,
        updatedAt:      a.updatedAt ?? null,
    }));
    return ctx.json({ applications: summaries, count: summaries.length });
  });

  // ── GET /:slug — application detail (PG) ─────────────────────────────────
  /**
   * Retrieves the full detail for a single application.
   *
   * Note: applications.id is UUID; the admin UI passes the UUID via the
   * `:slug` path parameter (no slug column exists today).
   *
   * Assembles:
   *  - job_applications row (metadata)
   *  - latest pipeline_runs row (analysis JSON in metadata)
   *  - coaching_content rows (one per stage)
   *  - latest resumes row (tailored resume content_json)
   */
  app.get('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');
    const pool = getPool(config);

    const application = await getApplication(pool, slug);
    if (!application) return ctx.json({ error: `Application not found: ${slug}` }, 404);

    const analysisResult = await pool.query<{
      id:         string;
      metadata:   { analysis?: unknown } | null;
      created_at: Date;
    }>(
      `SELECT id, metadata, created_at
         FROM pipeline_runs
        WHERE pipeline_type = 'strategist' AND reference_id = $1 AND status = 'complete'
        ORDER BY created_at DESC
        LIMIT 1`,
      [slug],
    );
    const latestAnalysis = analysisResult.rows[0] ?? null;

    const coachingResult = await pool.query<{
      stage_type:          string;
      topics_to_study:     unknown;
      expected_questions:  unknown;
      personal_highlights: unknown;
    }>(
      `SELECT stage_type, topics_to_study, expected_questions, personal_highlights
         FROM coaching_content WHERE job_application_id = $1`,
      [slug],
    );

    const resumeResult = await pool.query<{
      id:           string;
      content_json: unknown;
      generated_at: Date;
    }>(
      `SELECT id, content_json, generated_at
         FROM resumes WHERE job_application_id = $1
        ORDER BY generated_at DESC LIMIT 1`,
      [slug],
    );

    return ctx.json({
      application: {
        id:                  application.id,
        slug:                application.id,
        targetCompany:       application.company,
        targetRole:          application.role,
        jobUrl:              application.jobUrl,
        jobDescription:      application.jobDescription,
        status:              application.kanbanStatus,
        interviewStage:      'applied',
        createdAt:           application.createdAt,
        updatedAt:           application.updatedAt,
        analysis:            latestAnalysis?.metadata?.analysis ?? null,
        latestAnalysisRunId: latestAnalysis?.id ?? null,
        tailoredResume:      resumeResult.rows[0]?.content_json ?? null,
        coaching:            coachingResult.rows.reduce<Record<string, unknown>>((acc, row) => {
          acc[row.stage_type] = {
            topics:    row.topics_to_study,
            questions: row.expected_questions,
            personal:  row.personal_highlights,
          };
          return acc;
        }, {}),
      },
    });
  });

  // ── DELETE /:slug — delete application ────────────────────────────────────
  app.delete('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');
    await pgDeleteApplication(getPool(config), slug);
    return ctx.json({ deleted: true, slug });
  });

  // ── POST /:slug/status — update status ────────────────────────────────────
  app.post('/:slug/status', async (ctx) => {
    const slug = ctx.req.param('slug');
    const body = await ctx.req.json<{ status?: string; interviewStage?: string }>();
    if (!body.status || !VALID_STATUSES.has(body.status)) {
      return ctx.json({ error: `Invalid or missing status: ${body.status ?? '(none)'}` }, 400);
    }
    await pgUpdateStatus(getPool(config), slug, body.status);
    return ctx.json({ success: true, status: body.status });
  });

  // ── POST /:slug/coach — schedule the coach K8s Job ───────────────────────
  app.post('/:slug/coach', async (ctx) => {
    const slug = ctx.req.param('slug');
    const jwtPayload = ctx.get('jwtPayload');
    const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
    if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);

    let body: {
      strategistPipelineRunId?: string;
      interviewStage?:          string;
      applicationId?:           string;
      targetCompany?:           string;
      targetRole?:              string;
      jobDescription?:          string;
      mode?:                    string;
    };
    try { body = await ctx.req.json(); }
    catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

    const f = {
      strategistPipelineRunId: body.strategistPipelineRunId?.trim(),
      interviewStage:          body.interviewStage?.trim(),
      applicationId:           body.applicationId?.trim(),
      targetCompany:           body.targetCompany?.trim(),
      targetRole:              body.targetRole?.trim(),
      jobDescription:          body.jobDescription?.trim(),
    };
    for (const [k, v] of Object.entries(f)) {
      if (!v) return ctx.json({ error: `"${k}" is required` }, 400);
    }
    const mode = body.mode?.trim() || 'standard';

    const strategistPipelineImage = getJobImage('job-strategist');
    if (!isImageConfigured(strategistPipelineImage)) {
      console.error('[applications/coach] image URI unresolved — admin-api-job-images Secret not yet synced', { value: strategistPipelineImage });
      return ctx.json({ error: 'Strategist pipeline image not yet configured — wait ~60s for ESO/kubelet sync' }, 502);
    }

    const coachPipelineRunId = randomUUID();
    try {
      await insertPipelineRun(getPool(config), {
        id:           coachPipelineRunId,
        userId,
        pipelineType: 'coach',
        referenceId:  f.applicationId!,
        metadata: {
          applicationSlug:         slug,
          interviewStage:          f.interviewStage,
          strategistPipelineRunId: f.strategistPipelineRunId,
        },
      });
    } catch (err: unknown) {
      console.error('[applications/coach] failed to insert pipeline_run', err);
      return ctx.json({ error: 'Failed to record pipeline run' }, 500);
    }

    const job = buildPipelineJob({
      namespace:          config.strategistPipelineNamespace,
      image:              strategistPipelineImage,
      serviceAccountName: config.strategistPipelineServiceAccount,
      nameStem:           `coach-${sanitizeLabel(slug)}-${sanitizeLabel(f.interviewStage!)}`,
      suffixInput:        `${coachPipelineRunId}:${f.applicationId}:${f.interviewStage}:${Date.now()}`,
      labels: {
        app:    'coach-pipeline',
        userId,
        slug:   sanitizeLabel(slug),
        stage:  sanitizeLabel(f.interviewStage!),
      },
      command: ['node', 'dist/run-coach.js'],
      env: [
        { name: 'COACH_PIPELINE_RUN_ID',      value: coachPipelineRunId },
        { name: 'STRATEGIST_PIPELINE_RUN_ID', value: f.strategistPipelineRunId! },
        { name: 'APPLICATION_ID',             value: f.applicationId! },
        { name: 'APPLICATION_SLUG',           value: slug },
        { name: 'USER_ID',                    value: userId },
        { name: 'TARGET_COMPANY',             value: f.targetCompany! },
        { name: 'TARGET_ROLE',                value: f.targetRole! },
        { name: 'JOB_DESCRIPTION',            value: f.jobDescription! },
        { name: 'INTERVIEW_STAGE',            value: f.interviewStage! },
        { name: 'MODE',                       value: mode },
      ],
      envFromSecretRefs: ['platform-rds-credentials'],
    });

    try { await getBatchApi().createNamespacedJob(config.strategistPipelineNamespace, job); }
    catch (err: unknown) {
      console.error('[applications/coach] failed to create K8s Job', err);
      return ctx.json({ error: 'Failed to schedule coach Job' }, 502);
    }

    return ctx.json({
      status:             'queued',
      coachPipelineRunId,
      jobName:            job.metadata!.name!,
      applicationId:      f.applicationId,
      interviewStage:     f.interviewStage,
    }, 202);
  });

  // ── GET /:slug/coaching/:stage — read coaching_content row ────────────────
  app.get('/:slug/coaching/:stage', async (ctx) => {
    const stage = ctx.req.param('stage');

    const applicationId = ctx.req.query('applicationId');
    if (!applicationId) {
      return ctx.json({ error: 'applicationId query param required' }, 400);
    }

    const pool = getPool(config);
    const result = await pool.query<{
      topics_to_study:     unknown;
      expected_questions:  unknown;
      personal_highlights: unknown;
      generated_at:        Date;
    }>(
      `SELECT topics_to_study, expected_questions, personal_highlights, generated_at
       FROM coaching_content WHERE job_application_id = $1 AND stage_type = $2`,
      [applicationId, stage],
    );
    if (result.rows.length === 0) {
      return ctx.json({ error: 'Coaching content not yet ready' }, 404);
    }

    const row = result.rows[0]!;
    return ctx.json({
      applicationId,
      stage,
      coaching:           row.topics_to_study,
      questions:          row.expected_questions,
      personalHighlights: row.personal_highlights,
      generatedAt:        row.generated_at,
    });
  });

  return app;
}
