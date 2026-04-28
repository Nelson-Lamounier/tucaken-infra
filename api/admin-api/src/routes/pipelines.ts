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

import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { JWTPayload } from 'jose';
import type { V1Job } from '@kubernetes/client-node';
import type { AdminApiConfig } from '../lib/config.js';
import { getJobImage, isImageConfigured } from '../lib/config.js';
import { getBatchApi } from '../lib/k8s.js';
import { getPool } from '../lib/pg.js';
import { insertPipelineRun, getPipelineRun } from '../lib/repositories/pipeline-runs.js';

const MAX_NAME_LEN = 63;

function sanitizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_LEN);
}

interface BuildJobInput {
  namespace:           string;
  image:               string;
  serviceAccountName:  string;
  nameStem:            string;
  timestamp:           number;
  suffixInput:         string;
  labels:              Record<string, string>;
  command:             string[];
  env:                 { name: string; value: string }[];
  envFromSecretRefs:   string[];
}

function buildPipelineJob(input: BuildJobInput): V1Job {
  const suffix  = createHash('sha1').update(input.suffixInput).digest('hex').slice(0, 8);
  const stem    = sanitizeLabel(input.nameStem).slice(0, 50);
  const jobName = `${stem}-${suffix}`.slice(0, MAX_NAME_LEN);
  const sanitisedLabels = Object.fromEntries(
    Object.entries(input.labels).map(([k, v]) => [k, sanitizeLabel(v).slice(0, 63) || 'unknown']),
  );
  return {
    apiVersion: 'batch/v1',
    kind:       'Job',
    metadata: { name: jobName, namespace: input.namespace, labels: sanitisedLabels },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit:            2,
      activeDeadlineSeconds:   1800,
      template: {
        metadata: { labels: sanitisedLabels },
        spec: {
          restartPolicy:      'Never',
          serviceAccountName: input.serviceAccountName,
          containers: [{
            name:    'pipeline',
            image:   input.image,
            command: input.command,
            env:     input.env,
            envFrom: input.envFromSecretRefs.map(name => ({ secretRef: { name } })),
            resources: {
              requests: { memory: '768Mi', cpu: '300m' },
              limits:   { memory: '2Gi',   cpu: '1000m' },
            },
          }],
        },
      },
    },
  };
}

/** Hono context variable bindings for authenticated routes. */
type AdminApiBindings = {
  Variables: {
    jwtPayload: JWTPayload;
  };
};

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
    const slug = ctx.req.param('slug');
    const jwtPayload = ctx.get('jwtPayload');
    const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
    if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);

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
    try {
      await insertPipelineRun(getPool(config), {
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

    const timestamp = Date.now();
    const job = buildPipelineJob({
      namespace:           config.articlePipelineNamespace,
      image:               articlePipelineImage,
      serviceAccountName:  config.articlePipelineServiceAccount,
      nameStem:            `article-${sanitizeLabel(slug)}`,
      timestamp,
      suffixInput:         `${pipelineRunId}:${slug}:${timestamp}`,
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

    try { await getBatchApi().createNamespacedJob(config.articlePipelineNamespace, job); }
    catch (err: unknown) {
      console.error('[pipelines/article-job] failed to create K8s Job', err);
      return ctx.json({ error: 'Failed to schedule pipeline Job' }, 502);
    }

    return ctx.json({ status: 'queued', pipelineRunId, jobName: job.metadata!.name!, slug }, 202);
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/strategist-job
  // Phase 4: K8s-Job-based strategist pipeline trigger.
  // -------------------------------------------------------------------------
  router.post('/strategist-job', async (ctx) => {
    const jwtPayload = ctx.get('jwtPayload');
    const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
    if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);

    let body: { applicationId?: string; applicationSlug?: string; targetCompany?: string; targetRole?: string; jobDescription?: string; mode?: string };
    try { body = await ctx.req.json(); }
    catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

    const applicationId   = body.applicationId?.trim();
    const applicationSlug = body.applicationSlug?.trim();
    const targetCompany   = body.targetCompany?.trim();
    const targetRole      = body.targetRole?.trim();
    const jobDescription  = body.jobDescription?.trim();

    for (const [k, v] of Object.entries({ applicationId, applicationSlug, targetCompany, targetRole, jobDescription })) {
      if (!v) return ctx.json({ error: `"${k}" is required` }, 400);
    }
    const mode = body.mode?.trim() || 'standard';

    const strategistPipelineImage = getJobImage('job-strategist');
    if (!isImageConfigured(strategistPipelineImage)) {
      console.error('[pipelines/strategist-job] image URI unresolved — admin-api-job-images Secret not yet synced', { value: strategistPipelineImage });
      return ctx.json({ error: 'Strategist pipeline image not yet configured — wait ~60s for ESO/kubelet sync' }, 502);
    }

    const pipelineRunId = randomUUID();
    try {
      await insertPipelineRun(getPool(config), {
        id:           pipelineRunId,
        userId,
        pipelineType: 'strategist',
        referenceId:  applicationId!,
        metadata:     { applicationSlug, targetCompany, targetRole, mode },
      });
    } catch (err: unknown) {
      console.error('[pipelines/strategist-job] failed to insert pipeline_run', err);
      return ctx.json({ error: 'Failed to record pipeline run' }, 500);
    }

    const timestamp = Date.now();
    const job = buildPipelineJob({
      namespace:           config.strategistPipelineNamespace,
      image:               strategistPipelineImage,
      serviceAccountName:  config.strategistPipelineServiceAccount,
      nameStem:            `strategist-${sanitizeLabel(applicationSlug!)}`,
      timestamp,
      suffixInput:         `${pipelineRunId}:${applicationId}:${timestamp}`,
      labels:              { app: 'strategist-pipeline', userId, applicationSlug: sanitizeLabel(applicationSlug!) },
      command:             ['node', 'dist/run-pipeline.js'],
      env: [
        { name: 'PIPELINE_RUN_ID',   value: pipelineRunId },
        { name: 'APPLICATION_ID',    value: applicationId! },
        { name: 'APPLICATION_SLUG',  value: applicationSlug! },
        { name: 'USER_ID',           value: userId },
        { name: 'TARGET_COMPANY',    value: targetCompany! },
        { name: 'TARGET_ROLE',       value: targetRole! },
        { name: 'JOB_DESCRIPTION',   value: jobDescription! },
        { name: 'MODE',              value: mode },
      ],
      envFromSecretRefs: ['platform-rds-credentials'],
    });

    try { await getBatchApi().createNamespacedJob(config.strategistPipelineNamespace, job); }
    catch (err: unknown) {
      console.error('[pipelines/strategist-job] failed to create K8s Job', err);
      return ctx.json({ error: 'Failed to schedule pipeline Job' }, 502);
    }

    return ctx.json({ status: 'queued', pipelineRunId, jobName: job.metadata!.name!, applicationId }, 202);
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/pipelines/runs/:id
  // Phase 4: poll the pipeline_runs row.
  // -------------------------------------------------------------------------
  router.get('/runs/:id', async (ctx) => {
    const id = ctx.req.param('id');
    const run = await getPipelineRun(getPool(config), id);
    if (!run) return ctx.json({ error: 'Pipeline run not found' }, 404);

    const jwtPayload = ctx.get('jwtPayload');
    const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
    if (run.userId !== userId) return ctx.json({ error: 'Forbidden' }, 403);

    return ctx.json({ run });
  });

  return router;
}
