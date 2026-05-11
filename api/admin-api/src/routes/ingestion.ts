/**
 * @format
 * admin-api — Ingestion trigger route.
 *
 * Phase 3 cut-over: replaces the legacy API Gateway → Trigger Lambda → Fetcher
 * Lambda → Worker Lambda chain with a single in-cluster K8s Job.
 *
 * Routes:
 *   POST /api/admin/ingestion/trigger — accepts { repoFullName, forceReindex? }
 *                                       (userId is sourced from the JWT subject)
 *                                       creates a Job in the ingestion namespace,
 *                                       returns 202 { status, jobName }.
 */
import { createHash } from 'node:crypto';

import type { V1Job } from '@kubernetes/client-node';
import { Hono } from 'hono';
import type { JWTPayload } from 'jose';

import type { AdminApiConfig } from '../lib/config.js';
import { getJobImage, isImageConfigured } from '../lib/config.js';
import { getBatchApi } from '../lib/k8s.js';
import { traceParentEnv } from '../lib/k8s-job-builder.js';

type AdminApiBindings = {
    Variables: { jwtPayload: JWTPayload };
};

const REPO_FULL_NAME_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const MAX_NAME_LEN = 63;

function sanitizeLabel(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_LEN);
}

interface TriggerBody {
    readonly repoFullName?:  string;
    readonly forceReindex?:  boolean;
}

function buildJobSpec(
    cfg: AdminApiConfig,
    image: string,
    userId: string,
    repoFullName: string,
    forceReindex: boolean,
    timestamp: number,
): V1Job {
    const safeUserId = sanitizeLabel(userId);
    const repoSlug   = sanitizeLabel(repoFullName.replace('/', '-'));
    const suffix     = createHash('sha1').update(`${userId}:${repoFullName}:${timestamp}`).digest('hex').slice(0, 8);
    // 'ingestion-' (10) + suffix (8) + 2 hyphens = 20 fixed chars; 43 left for slug
    const slugPart   = sanitizeLabel(`${safeUserId}-${repoSlug}`).slice(0, 43);
    const jobName    = `ingestion-${slugPart}-${suffix}`.slice(0, MAX_NAME_LEN);

    return {
        apiVersion: 'batch/v1',
        kind:       'Job',
        metadata: {
            name:      jobName,
            namespace: cfg.ingestionNamespace,
            labels: {
                app:      'ingestion-worker',
                userId:   safeUserId,
                repoSlug,
            },
        },
        spec: {
            ttlSecondsAfterFinished: 3600,
            backoffLimit:            2,
            activeDeadlineSeconds:   900,
            template: {
                metadata: { labels: { app: 'ingestion-worker', userId: safeUserId, repoSlug } },
                spec: {
                    restartPolicy:      'Never',
                    serviceAccountName: cfg.ingestionServiceAccount,
                    containers: [{
                        name:    'worker',
                        image:   image,
                        command: ['node', 'dist/run-ingestion.js'],
                        env: [
                            { name: 'USER_ID',        value: userId },
                            { name: 'REPO_FULL_NAME', value: repoFullName },
                            { name: 'FORCE_REINDEX',  value: String(forceReindex) },
                            // BedrockChunkEnricher reads ENRICHMENT_MODEL_ID to select the
                            // model for per-chunk skill/technology extraction. Direct
                            // on-demand Claude invocation isn't supported in eu-west-1 —
                            // must use a cross-region inference profile (eu.* prefix).
                            // Overridable via admin-api's own ENRICHMENT_MODEL_ID env var.
                            {
                                name:  'ENRICHMENT_MODEL_ID',
                                value: process.env['ENRICHMENT_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
                            },
                            ...(() => { const tp = traceParentEnv(); return tp ? [tp] : []; })(),
                        ],
                        envFrom: [
                            { secretRef: { name: 'platform-rds-credentials' } },
                            { secretRef: { name: 'ingestion-secrets' } },
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

export function createIngestionRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
    const router = new Hono<AdminApiBindings>();

    router.post('/trigger', async (ctx) => {
        const jwtPayload = ctx.get('jwtPayload');
        const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
        if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);

        let body: TriggerBody;
        try {
            body = await ctx.req.json<TriggerBody>();
        } catch {
            return ctx.json({ error: 'Body must be valid JSON' }, 400);
        }

        const repoFullName = body.repoFullName?.trim();
        const forceReindex = body.forceReindex ?? false;

        if (!repoFullName)                           return ctx.json({ error: '"repoFullName" is required' }, 400);
        if (!REPO_FULL_NAME_RE.test(repoFullName))   return ctx.json({ error: '"repoFullName" must match owner/repo' }, 400);

        // Resolve the current ingestion image URI from the file mount
        // (kubelet auto-updates it when ESO refreshes the upstream Secret).
        const ingestionImage = getJobImage('ingestion');
        if (!isImageConfigured(ingestionImage)) {
            console.error('[ingestion] image URI unresolved — admin-api-job-images Secret not yet synced', { value: ingestionImage });
            return ctx.json({ error: 'Ingestion image not yet configured — wait ~60s for ESO/kubelet sync' }, 502);
        }

        const job = buildJobSpec(config, ingestionImage, userId, repoFullName, forceReindex, Date.now());

        try {
            // @kubernetes/client-node v1.x switched to options-object API.
            await getBatchApi().createNamespacedJob({ namespace: config.ingestionNamespace, body: job });
        } catch (err: unknown) {
            console.error('[ingestion] failed to create K8s Job', err);
            return ctx.json({ error: 'Failed to schedule ingestion Job' }, 502);
        }

        return ctx.json({
            status:       'queued',
            jobName:      job.metadata!.name!,
            userId,
            repoFullName,
            forceReindex,
        }, 202);
    });

    return router;
}
