/**
 * @format
 * admin-api — Pipeline trigger routes.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   POST /api/admin/pipelines/article     — Re-trigger article generation for an existing slug
 *   POST /api/admin/pipelines/strategist  — Trigger the Strategist pipeline Lambda
 *
 * Design:
 *   All invocations use `InvocationType: 'Event'` (fire-and-forget async).
 *   The admin UI gets an immediate 202 Accepted response and polls the article
 *   status or dashboard to detect completion.
 *
 *   The article route builds a synthetic S3 event matching the S3Handler
 *   contract expected by the trigger Lambda (bedrock-*-pipeline-trigger).
 *   This is the same shape that drafts.ts constructs, ensuring consistent
 *   behaviour regardless of which route initiates the pipeline.
 *
 *   Note: The publish pipeline (MDX → S3 → DynamoDB) is exposed separately under
 *         POST /api/admin/articles/:slug/publish, which already exists on the
 *         articles router, because it is tightly coupled to a specific article slug.
 *
 * Environment config:
 *   ARTICLE_TRIGGER_ARN    — Lambda ARN for article pipeline trigger
 *   STRATEGIST_TRIGGER_ARN — Lambda ARN for Strategist pipeline
 *   ASSETS_BUCKET_NAME     — S3 bucket name (used to build the synthetic S3 event)
 */

import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { JWTPayload } from 'jose';
import type { V1Job } from '@kubernetes/client-node';
import type { AdminApiConfig } from '../lib/config.js';
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

/** Singleton Lambda client — credentials from IMDS. */
let _lambdaClient: LambdaClient | undefined;

/**
 * Get or create the singleton Lambda client.
 *
 * @returns Singleton LambdaClient
 */
function getLambdaClient(): LambdaClient {
  if (!_lambdaClient) {
    _lambdaClient = new LambdaClient({
      region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
    });
  }
  return _lambdaClient;
}

/**
 * Invoke a Lambda function asynchronously (fire-and-forget).
 *
 * @param functionArn - The Lambda ARN to invoke
 * @param payload - JSON-serialisable event payload
 */
async function invokeAsync(
  functionArn: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: 'Event', // async — does not wait for result
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

/**
 * Invoke a Lambda function synchronously and return its parsed response body.
 *
 * The trigger Lambda is typed as an APIGatewayProxyEventV2 handler and returns
 * `{ statusCode, headers, body: JSON.stringify({...}) }`. We parse the outer
 * envelope and surface the inner `body` to the caller.
 *
 * Use this for routes that need to return data from the Lambda (e.g. applicationSlug).
 * The trigger Lambda is fast (<3 s): DynamoDB write + StartExecution — synchronous
 * invocation is safe.
 *
 * @param functionArn - The Lambda ARN to invoke
 * @param payload - JSON-serialisable event payload
 * @returns Parsed inner response body
 * @throws Error if the Lambda returns a non-2xx status or a FunctionError
 */
async function invokeSync<T>(
  functionArn: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const result = await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

  // FunctionError indicates the Lambda threw an unhandled exception
  if (result.FunctionError) {
    let detail = '';
    try {
      const raw = result.Payload ? JSON.parse(Buffer.from(result.Payload).toString('utf-8')) : {};
      detail = (raw as { errorMessage?: string }).errorMessage ?? JSON.stringify(raw);
    } catch { /* ignore */ }
    throw new Error(`Lambda function error: ${detail}`);
  }

  // Parse the API GW envelope the trigger Lambda wraps its response in
  const envelope = result.Payload
    ? (JSON.parse(Buffer.from(result.Payload).toString('utf-8')) as {
        statusCode?: number;
        body?: string;
      })
    : { statusCode: 500, body: '{}' };

  const statusCode = envelope.statusCode ?? 500;
  const body = envelope.body ? (JSON.parse(envelope.body) as Record<string, unknown>) : {};

  if (statusCode < 200 || statusCode >= 300) {
    const message = (body['error'] as string | undefined) ?? `Lambda returned ${statusCode}`;
    const details = body['details'] ? ` — ${body['details'] as string}` : '';
    throw new Error(`${message}${details}`);
  }

  return body as unknown as T;
}

/**
 * Create the pipelines admin router.
 *
 * @param config - Resolved application configuration
 * @returns Hono router with pipeline trigger routes
 */
export function createPipelinesRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/article
  // Re-trigger article generation for an existing draft slug.
  //
  // Required body: { slug: string }
  //   slug — the article slug whose source file already exists at
  //          s3://<assetsBucket>/drafts/<slug>.md.
  //
  // The trigger Lambda (bedrock-*-pipeline-trigger) is typed as an S3Handler.
  // It iterates event.Records[n].s3.object.key and extracts the slug via the
  // regex /^drafts\/(.+)\.md$/. A flat payload (without a Records array) causes
  // the handler to silently no-op — this was the original bug.
  //
  // This route constructs the same synthetic S3 event shape that drafts.ts uses,
  // ensuring consistent Lambda invocation regardless of trigger origin.
  //
  // InvocationType: 'Event' — async fire-and-forget.
  // The admin dashboard polls GET /api/admin/articles/:slug for status updates.
  //
  // Response: 202 { queued: true, pipeline: 'article', slug, key }
  // -------------------------------------------------------------------------
  router.post('/article', async (ctx) => {
    const body = await ctx.req.json<{ slug?: string }>().catch(() => ({ slug: undefined }));

    // slug is required — without it we cannot construct the S3 object key
    if (!body.slug || typeof body.slug !== 'string' || body.slug.trim().length === 0) {
      return ctx.json({ error: 'slug is required in the request body' }, 400);
    }

    const slug = body.slug.trim();
    const key = `drafts/${slug}.md`;

    // Build a synthetic S3 event matching the S3Handler / S3Event contract.
    // The trigger Lambda reads event.Records[n].s3.bucket.name and
    // event.Records[n].s3.object.key — these two fields are the minimum required.
    const syntheticS3Event = {
      Records: [
        {
          s3: {
            bucket: { name: config.assetsBucketName },
            object: { key },
          },
        },
      ],
    };

    await invokeAsync(config.articleTriggerArn, syntheticS3Event as Record<string, unknown>);

    console.log(`[pipelines] Article re-trigger queued — slug=${slug} key=${key}`);

    return ctx.json({ queued: true, pipeline: 'article', slug, key }, 202);
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/strategist
  // Trigger the Strategist pipeline Lambda asynchronously.
  //
  // The Strategist trigger Lambda's handler is typed as APIGatewayProxyEventV2.
  // It reads `event.body` as a JSON string and parses it through a Zod
  // discriminated union that requires `{ operation, targetCompany, targetRole, ... }`.
  //
  // This route forwards the admin dashboard's request body by wrapping it in the
  // correct APIGatewayProxyEventV2 envelope. A flat payload (without body/requestContext)
  // would fail Zod validation inside the Lambda silently due to async invocation.
  //
  // Required body fields (forwarded verbatim):
  //   operation     — 'analyse' | 'coach'
  //   targetCompany — e.g. 'Acme Corp'
  //   targetRole    — e.g. 'Senior Engineer'
  //   jobDescription — full JD text
  //   resumeId      — DynamoDB RESUME# record ID (for 'analyse')
  //   applicationSlug — existing slug (for 'coach')
  //   interviewStage — 'applied' | 'screening' | 'technical' | ... (for 'coach')
  //
  // InvocationType: 'Event' — async fire-and-forget.
  // Response: 202 { queued: true, pipeline: 'strategist' }
  // -------------------------------------------------------------------------
  router.post('/strategist', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));

    const operation = String(body['operation'] ?? 'unknown');

    // The Strategist trigger Lambda is an APIGatewayProxyEventV2 handler.
    // We wrap the request body in the correct APIGatewayProxyEventV2 envelope
    // so the Lambda can parse it from event.body.
    //
    // We use synchronous invocation (RequestResponse) for the strategist route
    // so we can capture the Lambda's response and return `applicationSlug` to the
    // admin dashboard for real-time progress tracking. The trigger Lambda is fast
    // (<3 s: DynamoDB write + StartExecution) — blocking is acceptable here.
    const lambdaEvent = {
      requestContext: {
        http: { method: 'POST' },
      },
      body: JSON.stringify(body),
    };

    const result = await invokeSync<{
      pipelineId: string;
      applicationSlug: string;
      operation: string;
      status: string;
      executionArn?: string;
    }>(config.strategistTriggerArn, lambdaEvent as Record<string, unknown>);

    console.log(`[pipelines] Strategist trigger complete — operation=${operation} slug=${result.applicationSlug}`);

    return ctx.json(result, 200);
  });

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
      image:               config.articlePipelineImage,
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
      image:               config.strategistPipelineImage,
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
