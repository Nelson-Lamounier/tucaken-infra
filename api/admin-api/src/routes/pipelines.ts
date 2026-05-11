/**
 * @format
 * admin-api — Pipeline trigger routes (K8s Job-based).
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   POST /api/admin/pipelines/article-job/:slug — Trigger article-pipeline K8s Job
 *   POST /api/admin/pipelines/strategist-job    — Trigger strategist-pipeline K8s Job
 *   GET  /api/admin/pipelines/runs/:id          — Poll pipeline_runs row
 *
 * The legacy Lambda-based article/strategist routes were removed in Phase 5;
 * pipeline execution now runs entirely as Kubernetes Jobs.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import type { AdminApiConfig } from '../lib/config.js';
import { getJobImage, isImageConfigured } from '../lib/config.js';
import { buildPipelineJob, sanitizeLabel } from '../lib/k8s-job-builder.js';
import { getBatchApi } from '../lib/k8s.js';
import { getPool, withUser } from '../lib/pg.js';
import { upsertApplication } from '../lib/repositories/applications.js';
import { insertPipelineRun, getPipelineRun } from '../lib/repositories/pipeline-runs.js';
import type { AdminApiBindings } from '../lib/types.js';

/**
 * Create the pipelines admin router.
 *
 * @param config - Resolved application configuration
 * @returns Hono router with pipeline trigger routes
 */
export function createPipelinesRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/article-job/:slug
  // Phase 4: K8s-Job-based article pipeline trigger.
  // -------------------------------------------------------------------------
  router.post('/article-job/:slug', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    const slug = ctx.req.param('slug');

    let body: { mode?: string; s3Bucket?: string; s3SourceKey?: string };
    try { body = await ctx.req.json(); }
    catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

    const s3Bucket    = body.s3Bucket?.trim();
    const s3SourceKey = body.s3SourceKey?.trim();
    if (!s3Bucket)    return ctx.json({ error: '"s3Bucket" is required' }, 400);
    if (!s3SourceKey) return ctx.json({ error: '"s3SourceKey" is required' }, 400);
    const mode = body.mode?.trim() || 'kb-augmented';

    const articlePipelineImage = getJobImage('article-pipeline');
    if (!isImageConfigured(articlePipelineImage)) {
      console.error('[pipelines/article-job] image URI unresolved — admin-api-job-images Secret not yet synced', { value: articlePipelineImage });
      return ctx.json({ error: 'Article pipeline image not yet configured — wait ~60s for ESO/kubelet sync' }, 502);
    }

    const pipelineRunId = randomUUID();

    return withUser(getPool(config), userId, async (db) => {
      try {
        await insertPipelineRun(db, {
          id:            pipelineRunId,
          userId,
          pipelineType:  'article',
          referenceId:   slug,
          metadata:      { s3Bucket, s3SourceKey, mode },
        });
      } catch (err: unknown) {
        console.error('[pipelines/article-job] failed to insert pipeline_run', err);
        return ctx.json({ error: 'Failed to record pipeline run' }, 500);
      }

      const suffixInput = `${pipelineRunId}:${slug}:${Date.now()}`;
      const job = buildPipelineJob({
        namespace:           config.articlePipelineNamespace,
        image:               articlePipelineImage,
        serviceAccountName:  config.articlePipelineServiceAccount,
        nameStem:            `article-${sanitizeLabel(slug)}`,
        suffixInput,
        labels:              { app: 'article-pipeline', userId, slug: sanitizeLabel(slug) },
        command:             ['node', 'dist/run-pipeline.js'],
        env: [
          { name: 'PIPELINE_RUN_ID', value: pipelineRunId },
          { name: 'SLUG',            value: slug },
          { name: 'S3_BUCKET',       value: s3Bucket },
          { name: 'S3_SOURCE_KEY',   value: s3SourceKey },
          { name: 'MODE',            value: mode },
        ],
        envFromSecretRefs:   ['platform-rds-credentials'],
      });

      try { await getBatchApi().createNamespacedJob({ namespace: config.articlePipelineNamespace, body: job }); }
      catch (err: unknown) {
        console.error('[pipelines/article-job] failed to create K8s Job', err);
        return ctx.json({ error: 'Failed to schedule pipeline Job' }, 502);
      }

      return ctx.json({ status: 'queued', pipelineRunId, jobName: job.metadata!.name!, slug }, 202);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/strategist-job
  // Phase 4: K8s-Job-based strategist pipeline trigger.
  // -------------------------------------------------------------------------
  router.post('/strategist-job', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    let body: { targetCompany?: string; targetRole?: string; jobDescription?: string; mode?: string; resumeId?: string };
    try { body = await ctx.req.json(); }
    catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

    const targetCompany  = body.targetCompany?.trim();
    const targetRole     = body.targetRole?.trim();
    const jobDescription = body.jobDescription?.trim();

    for (const [k, v] of Object.entries({ targetCompany, targetRole, jobDescription })) {
      if (!v) return ctx.json({ error: `"${k}" is required` }, 400);
    }
    const mode = body.mode?.trim() || 'standard';

    const resumeId = body.resumeId?.trim() || '';

    // Guard against K8s env-var 128KB limit — truncate at 100KB with a warning.
    const MAX_JD_BYTES = 100_000;
    const jdBytes = Buffer.byteLength(jobDescription!, 'utf8');
    const truncatedJd = jdBytes > MAX_JD_BYTES
      ? (() => {
          console.warn('[pipelines/strategist-job] job description truncated', { originalBytes: jdBytes });
          return jobDescription!.substring(0, MAX_JD_BYTES);
        })()
      : jobDescription!;

    const strategistPipelineImage = getJobImage('job-strategist');
    if (!isImageConfigured(strategistPipelineImage)) {
      console.error('[pipelines/strategist-job] image URI unresolved — admin-api-job-images Secret not yet synced', { value: strategistPipelineImage });
      return ctx.json({ error: 'Strategist pipeline image not yet configured — wait ~60s for ESO/kubelet sync' }, 502);
    }

    const applicationId = randomUUID();
    const pipelineRunId = randomUUID();

    return withUser(getPool(config), userId, async (db) => {
      // Create the job_applications row before dispatching the K8s Job so the
      // pipeline can UPDATE kanban_status as it progresses.
      try {
        await upsertApplication(db, {
          id:             applicationId,
          userId,
          company:        targetCompany!,
          role:           targetRole!,
          jobUrl:         null,
          jobDescription: jobDescription!,
          kanbanStatus:   'analysing',
          appliedAt:      null,
        });
      } catch (err: unknown) {
        console.error('[pipelines/strategist-job] failed to insert job_application', err);
        return ctx.json({ error: 'Failed to create application record' }, 500);
      }

      try {
        await insertPipelineRun(db, {
          id:           pipelineRunId,
          userId,
          pipelineType: 'strategist',
          referenceId:  applicationId,
          metadata:     { applicationSlug: applicationId, targetCompany, targetRole, mode },
        });
      } catch (err: unknown) {
        console.error('[pipelines/strategist-job] failed to insert pipeline_run', err);
        return ctx.json({ error: 'Failed to record pipeline run' }, 500);
      }

      const suffixInput = `${pipelineRunId}:${applicationId}:${Date.now()}`;
      const job = buildPipelineJob({
        namespace:           config.strategistPipelineNamespace,
        image:               strategistPipelineImage,
        serviceAccountName:  config.strategistPipelineServiceAccount,
        nameStem:            `strategist-${sanitizeLabel(applicationId)}`,
        suffixInput,
        labels:              { app: 'strategist-pipeline', userId, applicationSlug: sanitizeLabel(applicationId) },
        command:             ['node', 'dist/run-pipeline.js'],
        env: [
          { name: 'PIPELINE_RUN_ID',    value: pipelineRunId },
          { name: 'APPLICATION_ID',     value: applicationId },
          { name: 'APPLICATION_SLUG',   value: applicationId },
          { name: 'USER_ID',            value: userId },
          { name: 'TARGET_COMPANY',     value: targetCompany! },
          { name: 'TARGET_ROLE',        value: targetRole! },
          { name: 'JOB_DESCRIPTION',    value: truncatedJd },
          { name: 'MODE',               value: mode },
          ...(resumeId ? [{ name: 'RESUME_ID', value: resumeId }] : []),
        ],
        envFromSecretRefs: ['platform-rds-credentials'],
      });

      try { await getBatchApi().createNamespacedJob({ namespace: config.strategistPipelineNamespace, body: job }); }
      catch (err: unknown) {
        console.error('[pipelines/strategist-job] failed to create K8s Job', err);
        return ctx.json({ error: 'Failed to schedule pipeline Job' }, 502);
      }

      return ctx.json({
        status:           'queued',
        pipelineRunId,
        jobName:          job.metadata!.name!,
        applicationId,
        applicationSlug:  applicationId,
      }, 202);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/pipelines/runs/:id
  // Phase 4: poll the pipeline_runs row.
  // -------------------------------------------------------------------------
  router.get('/runs/:id', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    const id = ctx.req.param('id');

    return withUser(getPool(config), userId, async (db) => {
      const run = await getPipelineRun(db, id);
      if (!run) return ctx.json({ error: 'Pipeline run not found' }, 404);
      // RLS already isolates to this user's rows; explicit check retained as defence-in-depth.
      if (run.userId !== userId) return ctx.json({ error: 'Forbidden' }, 403);
      return ctx.json({ run });
    });
  });

  return router;
}
