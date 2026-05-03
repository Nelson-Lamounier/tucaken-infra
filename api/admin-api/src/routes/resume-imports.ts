/**
 * @format
 * admin-api — Resume import routes.
 *
 * Implements the first step of the career profile pipeline:
 *   1. User requests a presigned S3 PUT URL (GET /upload-url)
 *   2. Frontend uploads PDF/DOCX directly to S3
 *   3. Frontend signals upload complete (POST /:id/complete)
 *   4. admin-api dispatches a K8s Job (resume-import-processor)
 *   5. Frontend polls status (GET /:id) until 'ready_for_review'
 *   6. User reviews extracted career entries (GET /career-entries)
 *   7. Background enrichment runs per role; status reaches 'completed'
 *
 * Quota (free tier):
 *   - 1 import per calendar month
 *   - Enrichment capped at 5 experience entries (enforced by the Job)
 *   - Pro users: unlimited
 *
 * Routes (all under /api/admin/resume-imports):
 *   GET  /upload-url          — presigned S3 PUT URL + create import record
 *   POST /:id/complete        — mark upload done, dispatch K8s Job
 *   GET  /:id                 — status polling
 *   GET  /                    — list user's imports
 *   GET  /career-entries      — list extracted career history
 *   GET  /career-entries/:eid — single career entry
 *   PUT  /career-entries/:eid — update raw_data (user correction)
 *   DELETE /career-entries/:eid — delete entry (cascades embeddings)
 */
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { V1Job } from '@kubernetes/client-node';
import type { AdminApiConfig } from '../lib/config.js';
import { getJobImage, isImageConfigured, isAssetsBucketConfigured } from '../lib/config.js';
import { getBatchApi } from '../lib/k8s.js';
import { getPool } from '../lib/pg.js';
import { getUserPlanStatus } from '../lib/repositories/users.js';
import {
  createResumeImport,
  markUploadComplete,
  resetImportForRetry,
  getResumeImport,
  listResumeImports,
  countImportsThisMonth,
  listCareerEntries,
  getCareerEntry,
  updateCareerEntry,
  deleteCareerEntry,
} from '../lib/repositories/career-history.js';
import { requireUserId } from '../lib/types.js';
import type { AdminApiBindings } from '../lib/types.js';

const s3 = new S3Client({
  region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
});

/** Allowed MIME types for resume uploads. */
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const PRESIGN_EXPIRY_SECONDS = 300;      // 5 minutes
const FREE_TIER_IMPORTS_PER_MONTH = 1;

function buildJobSpec(
  cfg: Pick<AdminApiConfig, 'resumeImportNamespace' | 'resumeImportServiceAccount'>,
  image: string,
  importId: string,
  userId: string,
  s3Key: string,
  contentType: string,
): V1Job {
  const safeUserId  = userId.slice(0, 20).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const suffix      = crypto.createHash('sha1')
    .update(`${userId}:${importId}:${Date.now()}`)
    .digest('hex')
    .slice(0, 8);
  const jobName = `resume-import-${safeUserId}-${suffix}`.slice(0, 63);

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name:      jobName,
      namespace: cfg.resumeImportNamespace,
      labels: { app: 'resume-import-processor', userId: safeUserId, 'import-id': importId },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit:            1,
      activeDeadlineSeconds:   600, // 10-minute max (extraction + enrichment)
      template: {
        metadata: { labels: { app: 'resume-import-processor', userId: safeUserId, 'import-id': importId } },
        spec: {
          restartPolicy:      'Never',
          serviceAccountName: cfg.resumeImportServiceAccount,
          containers: [{
            name:    'processor',
            image:   image,
            command: ['node', 'dist/run-import.js'],
            env: [
              { name: 'IMPORT_ID',    value: importId },
              { name: 'USER_ID',      value: userId },
              { name: 'S3_KEY',       value: s3Key },
              { name: 'CONTENT_TYPE', value: contentType },
            ],
            envFrom: [
              // PG_HOST/PORT/DATABASE/USER/PASSWORD
              { secretRef: { name: 'platform-rds-credentials' } },
              // ASSETS_BUCKET_NAME — for S3 GetObject to fetch the uploaded file
              { secretRef: { name: 'admin-api-bedrock' } },
              // TAVILY_API_KEY — ESO-synced from SSM /bedrock-{env}/tavily-api-key
              // Optional: if Secret absent, enrichment is skipped gracefully
              { secretRef: { name: 'resume-import-secrets', optional: true } },
            ],
            resources: {
              requests: { memory: '512Mi', cpu: '250m' },
              limits:   { memory: '1Gi',   cpu: '500m' },
            },
          }],
        },
      },
    },
  };
}

export function createResumeImportsRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();
  const pool   = getPool(config);

  // ─── GET /upload-url ───────────────────────────────────────────────────────
  // Validate quota → create import record → return presigned PUT URL.
  //
  // Query params:
  //   filename     — original filename (for display; sanitised server-side)
  //   contentType  — 'application/pdf' | 'application/vnd.openxmlformats-...'
  //   fileSizeBytes — used to enforce 20 MB limit before issuing the URL
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/upload-url', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    if (!isAssetsBucketConfigured(config.assetsBucketName)) {
      return ctx.json({ error: 'Resume uploads unavailable — S3 bucket not configured' }, 503);
    }

    const filename      = ctx.req.query('filename') ?? '';
    const contentType   = ctx.req.query('contentType') ?? '';
    const fileSizeBytes = parseInt(ctx.req.query('fileSizeBytes') ?? '0', 10);

    if (!filename)
      return ctx.json({ error: '"filename" query param is required' }, 400);
    if (!ALLOWED_CONTENT_TYPES.has(contentType))
      return ctx.json({ error: 'Only PDF and DOCX files are accepted' }, 415);
    if (!fileSizeBytes || fileSizeBytes > MAX_FILE_SIZE)
      return ctx.json({ error: `File must be between 1 byte and ${MAX_FILE_SIZE / 1024 / 1024} MB` }, 413);

    // Quota check — free tier only; role='admin' has unlimited imports
    const planStatus = await getUserPlanStatus(pool, userId);
    const isAdmin = planStatus?.role === 'admin';
    if (!isAdmin && planStatus?.effectivePlan === 'free') {
      const used = await countImportsThisMonth(pool, userId);
      if (used >= FREE_TIER_IMPORTS_PER_MONTH) {
        return ctx.json({
          error: 'Free tier allows 1 resume import per month. Upgrade to Pro for unlimited imports.',
          upgradeUrl: '/pricing',
        }, 429);
      }
    }

    // Build presigned URL before inserting the DB record — avoids stale
    // awaiting_upload rows when S3 / network errors occur
    const ext    = contentType === 'application/pdf' ? 'pdf' : 'docx';
    const fileId = crypto.randomUUID();
    const s3Key  = `resume-imports/${userId}/${fileId}.${ext}`;

    const command = new PutObjectCommand({
      Bucket:        config.assetsBucketName!,
      Key:           s3Key,
      ContentType:   contentType,
      ContentLength: fileSizeBytes,
      // SSE-S3 is the bucket default (BucketEncryption.S3_MANAGED in CDK).
      // Not included here so it doesn't appear in SignedHeaders — the browser
      // fetch would need to send the header too, which would require CORS preflight.
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });

    const importRecord = await createResumeImport(pool, {
      userId,
      s3Key,
      originalFilename: filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255),
      contentType,
      fileSizeBytes,
    });

    return ctx.json({
      importId:  importRecord.id,
      uploadUrl,
      s3Key,
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    }, 200);
  });

  // ─── POST /:id/complete ────────────────────────────────────────────────────
  // Frontend calls this after a successful S3 PUT.
  // Transitions import status queued → dispatches K8s Job.
  // ──────────────────────────────────────────────────────────────────────────
  router.post('/:id/complete', async (ctx) => {
    const userId   = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const importId = ctx.req.param('id');

    const importRecord = await markUploadComplete(pool, importId, userId);
    if (!importRecord) {
      return ctx.json({ error: 'Import not found or already in progress' }, 404);
    }

    const image = getJobImage('resume-import-processor');
    if (!isImageConfigured(image)) {
      console.error('[resume-imports] image URI unresolved — ESO not yet synced', { image });
      return ctx.json({ error: 'Resume import processor image not configured — wait ~60s for ESO/kubelet sync' }, 502);
    }

    const job = buildJobSpec(
      config,
      image,
      importRecord.id,
      userId,
      importRecord.s3Key,
      importRecord.contentType,
    );

    try {
      await getBatchApi().createNamespacedJob({ namespace: config.resumeImportNamespace, body: job });
    } catch (err) {
      console.error('[resume-imports] failed to create K8s Job', err);
      return ctx.json({ error: 'Failed to schedule resume import job' }, 502);
    }

    return ctx.json({ importId: importRecord.id, status: 'queued' }, 202);
  });

  // ─── POST /:id/retry ──────────────────────────────────────────────────────
  // Re-dispatches a failed import. Resets status to queued and creates a new
  // K8s Job to re-run the resume-import-processor.
  // ──────────────────────────────────────────────────────────────────────────
  router.post('/:id/retry', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const importId = ctx.req.param('id');

    const importRecord = await resetImportForRetry(pool, importId, userId);
    if (!importRecord) {
      return ctx.json({ error: 'Import not found or not in failed state' }, 404);
    }

    const image = getJobImage('resume-import-processor');
    if (!isImageConfigured(image)) {
      console.error('[resume-imports] retry: image URI unresolved', { image });
      return ctx.json({ error: 'Resume import processor image not configured' }, 502);
    }

    const job = buildJobSpec(
      config,
      image,
      importRecord.id,
      userId,
      importRecord.s3Key,
      importRecord.contentType,
    );

    try {
      await getBatchApi().createNamespacedJob({ namespace: config.resumeImportNamespace, body: job });
    } catch (err) {
      console.error('[resume-imports] retry: failed to create K8s Job', err);
      return ctx.json({ error: 'Failed to schedule resume import job' }, 502);
    }

    return ctx.json({ importId: importRecord.id, status: 'queued' }, 202);
  });

  // ─── GET / ────────────────────────────────────────────────────────────────
  // List all resume imports for the authenticated user.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const imports = await listResumeImports(pool, userId);
    return ctx.json({ imports });
  });

  // ─── GET /career-entries ──────────────────────────────────────────────────
  // List all extracted career entries. Optional ?type= filter.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/career-entries', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const typeParam = ctx.req.query('type') as string | undefined;
    const entries   = await listCareerEntries(pool, userId, typeParam as never);
    return ctx.json({ entries });
  });

  // ─── GET /career-entries/:eid ─────────────────────────────────────────────
  router.get('/career-entries/:eid', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const entry = await getCareerEntry(pool, ctx.req.param('eid'), userId);
    if (!entry) return ctx.json({ error: 'Entry not found' }, 404);
    return ctx.json({ entry });
  });

  // ─── PUT /career-entries/:eid ─────────────────────────────────────────────
  // User corrects extracted data (raw_data JSONB only — enriched_data is
  // written exclusively by the K8s Job).
  // ──────────────────────────────────────────────────────────────────────────
  router.put('/career-entries/:eid', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    let body: { rawData?: Record<string, unknown> };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json({ error: 'Body must be valid JSON' }, 400);
    }

    if (!body.rawData || typeof body.rawData !== 'object') {
      return ctx.json({ error: '"rawData" object is required' }, 400);
    }

    const entry = await updateCareerEntry(pool, ctx.req.param('eid'), userId, body.rawData);
    if (!entry) return ctx.json({ error: 'Entry not found' }, 404);
    return ctx.json({ entry });
  });

  // ─── DELETE /career-entries/:eid ──────────────────────────────────────────
  // Deletes a career entry and all its experience_embeddings (CASCADE).
  // ──────────────────────────────────────────────────────────────────────────
  router.delete('/career-entries/:eid', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const deleted = await deleteCareerEntry(pool, ctx.req.param('eid'), userId);
    if (!deleted) return ctx.json({ error: 'Entry not found' }, 404);
    return ctx.json({ deleted: true }, 200);
  });

  // ─── GET /:id ─────────────────────────────────────────────────────────────
  // Status polling — frontend calls every 2-3s until status is
  // 'ready_for_review' (fast) or 'completed' (after enrichment).
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/:id', async (ctx) => {
    const userId = requireUserId(ctx);
    if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

    const importRecord = await getResumeImport(pool, ctx.req.param('id'), userId);
    if (!importRecord) return ctx.json({ error: 'Import not found' }, 404);
    return ctx.json({ import: importRecord });
  });

  return router;
}
