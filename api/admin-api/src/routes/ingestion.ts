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
import { Hono } from 'hono';
import type { JWTPayload } from 'jose';
import type { V1Job } from '@kubernetes/client-node';
import type { AdminApiConfig } from '../lib/config.js';
import { getBatchApi } from '../lib/k8s.js';

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
                        image:   cfg.ingestionImage,
                        command: ['node', 'dist/run-ingestion.js'],
                        env: [
                            { name: 'USER_ID',        value: userId },
                            { name: 'REPO_FULL_NAME', value: repoFullName },
                            { name: 'FORCE_REINDEX',  value: String(forceReindex) },
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

        const job = buildJobSpec(config, userId, repoFullName, forceReindex, Date.now());

        try {
            await getBatchApi().createNamespacedJob(config.ingestionNamespace, job);
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
