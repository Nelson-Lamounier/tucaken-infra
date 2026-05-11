/**
 * @format
 * admin-api — GitHub App integration routes.
 *
 * All routes require a valid Cognito JWT. User isolation is enforced at two
 * layers: the DB schema (UNIQUE(user_id, provider) / UNIQUE(user_id, provider,
 * full_name) constraints) and every SQL query (user_id = $userId from users.id).
 *
 * Routes:
 *   GET    /github/installation              — check if GitHub App is installed
 *   POST   /github/installation              — store installation_id after redirect
 *   DELETE /github/installation              — disconnect + cascade-delete repos
 *   GET    /github/repos                     — list repos accessible via installation
 *   GET    /github/connected-repos           — list repos added to KB + sync status
 *   POST   /github/connected-repos           — add repo + write pending + trigger Job
 *   DELETE /github/connected-repos/:fullName — remove repo + embeddings
 *
 * Token model:
 *   Only installation_id is stored in oauth_connections (TEXT column).
 *   Installation tokens (1-hour, read-only) are generated on the fly from the
 *   App private key for repo listing and ingestion Job dispatch.
 *   No long-lived PAT is ever persisted.
 *
 * Quota model:
 *   Free plan: 3 ingestion jobs per calendar month ('ingestion_jobs' feature in usage_quotas).
 *   Pro plan: unlimited.
 *   All three dispatch paths (POST /installation auto-sync, POST /connected-repos,
 *   and push webhook) enforce the same quota via checkAndIncrementQuota().
 *
 * Push debounce:
 *   repo_sync_state.last_sync_triggered_at — skip push re-index if triggered
 *   within the last PUSH_COOLDOWN_MS (30 minutes) or if a job is already running.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import type { Pool } from 'pg';

import type { AdminApiConfig } from '../lib/config.js';
import { getJobImage, isImageConfigured } from '../lib/config.js';
import {
    generateInstallationToken,
    getInstallationInfo,
    listInstallationRepos,
} from '../lib/github-app.js';
import { getBatchApi } from '../lib/k8s.js';
import { traceParentEnv } from '../lib/k8s-job-builder.js';
import { getPool } from '../lib/pg.js';
import { AdminApiBindings, requireUserId } from '../lib/types.js';

// Push events: skip re-index if a job was already triggered within this window.
const PUSH_COOLDOWN_MS = 30 * 60 * 1000;

// Free-tier monthly ingestion job cap.
const FREE_PLAN_LIMIT = 3;

// =============================================================================
// DB HELPERS — all queries are scoped to userId (users.id UUID)
// =============================================================================

interface OAuthRow {
    installation_id: string | null;
    username:        string;
    avatar_url:      string | null;
    connected_at:    Date;
}

async function getConnection(pool: Pool, userId: string): Promise<OAuthRow | null> {
    const { rows } = await pool.query<OAuthRow>(
        `SELECT installation_id, username, avatar_url, connected_at
         FROM oauth_connections
         WHERE user_id = $1::uuid AND provider = 'github'`,
        [userId],
    );
    return rows[0] ?? null;
}

async function upsertConnection(
    pool: Pool,
    userId: string,
    accountId: string,
    installationId: string,
    username: string,
    avatarUrl: string,
): Promise<void> {
    await pool.query(
        `INSERT INTO oauth_connections
           (user_id, provider, provider_user_id, username, access_token_enc, installation_id, avatar_url)
         VALUES ($1::uuid, 'github', $2, $3, '', $4, $5)
         ON CONFLICT (user_id, provider)
         DO UPDATE SET
           provider_user_id = EXCLUDED.provider_user_id,
           installation_id  = EXCLUDED.installation_id,
           username         = EXCLUDED.username,
           avatar_url       = EXCLUDED.avatar_url,
           connected_at     = NOW()`,
        [userId, accountId, username, installationId, avatarUrl],
    );
}

async function deleteConnection(pool: Pool, userId: string): Promise<void> {
    // Cascade: delete connected repos + their sync state + embeddings.
    // Ordering matters — FK-free tables first, then oauth_connections.
    await pool.query(
        `DELETE FROM document_embeddings
         WHERE user_id = $1::uuid
           AND repo_full_name IN (
             SELECT full_name FROM repositories WHERE user_id = $1::uuid AND provider = 'github'
           )`,
        [userId],
    );
    await pool.query(
        `DELETE FROM repo_sync_state
         WHERE user_id = $1::uuid
           AND repo_full_name IN (
             SELECT full_name FROM repositories WHERE user_id = $1::uuid AND provider = 'github'
           )`,
        [userId],
    );
    await pool.query(
        `DELETE FROM repositories WHERE user_id = $1::uuid AND provider = 'github'`,
        [userId],
    );
    await pool.query(
        `DELETE FROM oauth_connections WHERE user_id = $1::uuid AND provider = 'github'`,
        [userId],
    );
}

interface ConnectedRepoRow {
    full_name:      string;
    default_branch: string;
    index_status:   string;
    added_at:       Date;
    sync_status:    string | null;
    last_synced_at: Date | null;
    file_count:     number | null;
    chunk_count:    number | null;
    error_message:  string | null;
}

async function listConnectedRepos(pool: Pool, userId: string): Promise<ConnectedRepoRow[]> {
    const { rows } = await pool.query<ConnectedRepoRow>(
        `SELECT r.full_name, r.default_branch, r.index_status, r.added_at,
                s.sync_status, s.last_synced_at, s.file_count, s.chunk_count, s.error_message
         FROM repositories r
         LEFT JOIN repo_sync_state s
           ON s.user_id = r.user_id AND s.repo_full_name = r.full_name
         WHERE r.user_id = $1::uuid AND r.provider = 'github'
         ORDER BY r.added_at DESC`,
        [userId],
    );
    return rows;
}

async function insertRepository(
    pool: Pool,
    userId: string,
    fullName: string,
    defaultBranch: string,
): Promise<void> {
    await pool.query(
        `INSERT INTO repositories (user_id, provider, full_name, default_branch, index_status)
         VALUES ($1::uuid, 'github', $2, $3, 'pending')
         ON CONFLICT (user_id, provider, full_name) DO NOTHING`,
        [userId, fullName, defaultBranch],
    );
}

async function markRepoPending(pool: Pool, userId: string, fullName: string): Promise<void> {
    await pool.query(
        `INSERT INTO repo_sync_state (user_id, repo_full_name, sync_status)
         VALUES ($1::uuid, $2, 'pending')
         ON CONFLICT (user_id, repo_full_name)
         DO UPDATE SET sync_status = 'pending', error_message = NULL`,
        [userId, fullName],
    );
}

async function deleteRepository(pool: Pool, userId: string, fullName: string): Promise<void> {
    await pool.query(
        `DELETE FROM document_embeddings WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, fullName],
    );
    await pool.query(
        `DELETE FROM repo_sync_state WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, fullName],
    );
    await pool.query(
        `DELETE FROM repositories
         WHERE user_id = $1::uuid AND provider = 'github' AND full_name = $2`,
        [userId, fullName],
    );
}

// =============================================================================
// QUOTA + DEBOUNCE HELPERS
// =============================================================================

function getPlanLimit(plan: string): number {
    return plan === 'pro' ? Infinity : FREE_PLAN_LIMIT;
}

/**
 * Atomically checks and increments the monthly ingestion job counter.
 * Returns true if the job is allowed (quota not exceeded), false otherwise.
 * Pro plan bypasses the check entirely.
 *
 * Uses a single INSERT … ON CONFLICT DO UPDATE … WHERE count < limit RETURNING count
 * so the check and increment are one atomic operation with no TOCTOU window.
 * If RETURNING yields no rows, the WHERE guard rejected the update → quota full.
 */
async function checkAndIncrementQuota(
    pool: Pool,
    userId: string,
    limit: number,
): Promise<boolean> {
    if (!isFinite(limit)) return true;

    const { rows } = await pool.query<{ count: number }>(
        `INSERT INTO usage_quotas (user_id, feature, period_month, count)
         VALUES ($1::uuid, 'ingestion_jobs', DATE_TRUNC('month', NOW()), 1)
         ON CONFLICT (user_id, feature, period_month)
         DO UPDATE SET count      = usage_quotas.count + 1,
                       updated_at = NOW()
         WHERE usage_quotas.count < $2
         RETURNING count`,
        [userId, limit],
    );
    // Empty RETURNING → WHERE clause was false → quota already at or above limit.
    return rows.length > 0;
}

/**
 * Stamp last_sync_triggered_at on a repo so the push cooldown is enforced.
 * Called immediately before dispatching any ingestion job.
 */
async function markSyncTriggered(
    pool: Pool,
    userId: string,
    repoFullName: string,
): Promise<void> {
    await pool.query(
        `UPDATE repo_sync_state
         SET last_sync_triggered_at = NOW()
         WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, repoFullName],
    );
}

/**
 * Resolve user_id (users.id UUID) and plan from a GitHub App installation_id.
 * Used by the webhook handler which has no Cognito JWT to pull user context from.
 */
async function lookupUserByInstallation(
    pool: Pool,
    installationId: string,
): Promise<{ userId: string; plan: string } | null> {
    const { rows } = await pool.query<{ user_id: string; plan: string }>(
        `SELECT oc.user_id::text, u.plan
         FROM oauth_connections oc
         JOIN users u ON u.id = oc.user_id
         WHERE oc.provider = 'github' AND oc.installation_id = $1`,
        [installationId],
    );
    const row = rows[0];
    return row ? { userId: row.user_id, plan: row.plan } : null;
}

/**
 * Dispatch ingestion Jobs for a list of repos, respecting the user's plan quota.
 * Stops as soon as the quota is exhausted — does not wrap around to the next month.
 *
 * forceReindex=true on re-installs so the full index is rebuilt even for repos
 * whose content_hashes are already in RDS.
 */
async function autoDispatchRepos(
    config:       AdminApiConfig,
    pool:         Pool,
    userId:       string,
    plan:         string,
    repos:        Array<{ full_name: string; default_branch: string }>,
    token:        string,
    forceReindex: boolean,
): Promise<string[]> {
    const limit   = getPlanLimit(plan);
    const queued: string[] = [];

    for (const repo of repos) {
        const allowed = await checkAndIncrementQuota(pool, userId, limit);
        if (!allowed) {
            console.log(`[github/auto-dispatch] quota reached for user ${userId} — stopping`);
            break;
        }

        await insertRepository(pool, userId, repo.full_name, repo.default_branch ?? 'main');
        await markRepoPending(pool, userId, repo.full_name);
        await markSyncTriggered(pool, userId, repo.full_name);

        try {
            await dispatchIngestionJob(config, userId, repo.full_name, token, forceReindex);
            queued.push(repo.full_name);
            console.log(`[github/auto-dispatch] queued ${repo.full_name} (forceReindex=${forceReindex})`);
        } catch (err) {
            console.error(`[github/auto-dispatch] dispatch failed for ${repo.full_name}`, (err as Error).message);
        }
    }

    return queued;
}

// =============================================================================
// JOB DISPATCH HELPER
// =============================================================================

const MAX_NAME_LEN = 63;
function sanitizeLabel(v: string): string {
    return v.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_LEN);
}

async function dispatchIngestionJob(
    config: AdminApiConfig,
    userId: string,
    repoFullName: string,
    githubToken: string,
    forceReindex = false,
): Promise<{ jobName: string }> {
    const { createHash } = await import('node:crypto');
    const image = getJobImage('ingestion');
    if (!isImageConfigured(image)) {
        throw Object.assign(new Error('Ingestion image not yet configured'), { status: 502 });
    }

    const timestamp = Date.now();
    const safeUser  = sanitizeLabel(userId);
    const repoSlug  = sanitizeLabel(repoFullName.replace('/', '-'));
    const suffix    = createHash('sha1').update(`${userId}:${repoFullName}:${timestamp}`).digest('hex').slice(0, 8);
    const slugPart  = sanitizeLabel(`${safeUser}-${repoSlug}`).slice(0, 43);
    const jobName   = `ingestion-${slugPart}-${suffix}`.slice(0, MAX_NAME_LEN);

    const job = {
        apiVersion: 'batch/v1',
        kind:       'Job',
        metadata: {
            name:      jobName,
            namespace: config.ingestionNamespace,
            labels:      { app: 'ingestion-worker', userId: safeUser, repoSlug },
            annotations: { 'argocd.argoproj.io/compare-options': 'IgnoreExtraneous' },
        },
        spec: {
            ttlSecondsAfterFinished: 3600,
            backoffLimit:            2,
            activeDeadlineSeconds:   900,
            template: {
                metadata: { labels: { app: 'ingestion-worker', userId: safeUser, repoSlug } },
                spec: {
                    restartPolicy:      'Never',
                    serviceAccountName: config.ingestionServiceAccount,
                    containers: [{
                        name:    'worker',
                        image,
                        command: ['node', 'dist/run-ingestion.js'],
                        // Explicit env vars take precedence over envFrom in K8s.
                        // GITHUB_TOKEN here overrides any static token in ingestion-secrets,
                        // ensuring each Job uses the per-user installation token.
                        env: [
                            { name: 'USER_ID',            value: userId },
                            { name: 'REPO_FULL_NAME',     value: repoFullName },
                            { name: 'FORCE_REINDEX',      value: String(forceReindex) },
                            { name: 'GITHUB_TOKEN',       value: githubToken },
                            // Cross-region inference profile for BedrockChunkEnricher.
                            // Direct on-demand Claude invocation unsupported in eu-west-1.
                            {
                                name:  'ENRICHMENT_MODEL_ID',
                                value: process.env['ENRICHMENT_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
                            },
                            ...(() => { const tp = traceParentEnv(); return tp ? [tp] : []; })(),
                        ],
                        envFrom: [{ secretRef: { name: 'platform-rds-credentials' } }],
                        resources: {
                            requests: { memory: '512Mi', cpu: '250m' },
                            limits:   { memory: '1Gi',   cpu: '500m' },
                        },
                    }],
                },
            },
        },
    };

    await getBatchApi().createNamespacedJob({ namespace: config.ingestionNamespace, body: job });
    return { jobName };
}

// =============================================================================
// ROUTER
// =============================================================================

/** Return [appId, privateKey] or throw 503. */
function requireGitHubConfig(config: AdminApiConfig): [string, string] {
    const { githubAppId, githubPrivateKey } = config;
    if (!githubAppId || !githubPrivateKey) {
        throw Object.assign(
            new Error('GitHub App not configured — GITHUB_APP_ID / GITHUB_PRIVATE_KEY missing'),
            { status: 503 },
        );
    }
    return [githubAppId, githubPrivateKey];
}

export function createGitHubRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
    const router = new Hono<AdminApiBindings>();

    // -------------------------------------------------------------------------
    // Error boundary — consistent JSON error shape
    // -------------------------------------------------------------------------
    router.onError((err, ctx) => {
        const status = (err as { status?: number }).status ?? 500;
        console.error(`[github] ${ctx.req.method} ${ctx.req.path}`, err.message);
        return ctx.json({ error: err.message }, status as 400 | 401 | 403 | 404 | 500 | 502 | 503);
    });

    // -------------------------------------------------------------------------
    // GET /installation — check connection status
    // -------------------------------------------------------------------------
    router.get('/installation', async (ctx) => {
        const pool = getPool(config);
        const uid  = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn?.installation_id) return ctx.json({ error: 'Not connected' }, 404);

        // Fetch live repo count using a fresh installation token.
        const [appId, key] = requireGitHubConfig(config);
        const token = await generateInstallationToken(appId, key, conn.installation_id);
        const repos  = await listInstallationRepos(token);

        return ctx.json({
            installation: {
                installationId:     conn.installation_id,
                accountLogin:       conn.username,
                accountAvatarUrl:   conn.avatar_url ?? '',
                repositoryCount:    repos.length,
                connectedAt:        conn.connected_at.toISOString(),
            },
        });
    });

    // -------------------------------------------------------------------------
    // POST /installation — store installation_id from GitHub redirect.
    //
    // Auto-sync behaviour:
    //   Fresh install  — just store the connection. UI picker adds repos.
    //   Re-install     — re-dispatch all previously connected repos with
    //                    FORCE_REINDEX=true so RDS embeddings are rebuilt.
    //                    Counted against the monthly quota.
    //
    // Body: { installationId: string }
    // -------------------------------------------------------------------------
    router.post('/installation', async (ctx) => {
        const pool = getPool(config);
        const uid  = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const [appId, key] = requireGitHubConfig(config);

        let body: { installationId?: string };
        try { body = await ctx.req.json(); }
        catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

        const installationId = body.installationId?.trim();
        if (!installationId) return ctx.json({ error: '"installationId" is required' }, 400);

        // Detect re-install BEFORE upsert so isReinstall is accurate.
        // Require an existing installation_id: a row with no installation_id is a
        // partial/failed prior connect, not a real previous session.
        const existing    = await getConnection(pool, uid);
        const isReinstall = existing !== null && existing.installation_id !== null;

        const info = await getInstallationInfo(appId, key, installationId);
        await upsertConnection(pool, uid, info.accountId, installationId, info.accountLogin, info.accountAvatarUrl);

        if (!isReinstall) {
            // Fresh install — return immediately; user picks repos via the UI picker.
            return ctx.json({ success: true, queued: [] });
        }

        // Re-install: re-dispatch previously connected repos with full re-index.
        const connected = await listConnectedRepos(pool, uid);
        if (connected.length === 0) {
            return ctx.json({ success: true, queued: [] });
        }

        const token = await generateInstallationToken(appId, key, installationId);

        const { rows: planRows } = await pool.query<{ plan: string }>(
            `SELECT plan FROM users WHERE id = $1::uuid`,
            [uid],
        );
        const plan = planRows[0]?.plan ?? 'free';

        const queued = await autoDispatchRepos(
            config, pool, uid, plan,
            connected.map(r => ({ full_name: r.full_name, default_branch: r.default_branch })),
            token,
            true, // forceReindex
        );

        console.log(`[github/installation] re-install for ${uid}: queued ${queued.length}/${connected.length} repos`);
        return ctx.json({ success: true, queued });
    });

    // -------------------------------------------------------------------------
    // DELETE /installation — disconnect GitHub + cascade-delete all repo data
    // -------------------------------------------------------------------------
    router.delete('/installation', async (ctx) => {
        const pool = getPool(config);
        const uid  = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn) return ctx.json({ error: 'Not connected' }, 404);

        await deleteConnection(pool, uid);
        return ctx.json({ success: true });
    });

    // -------------------------------------------------------------------------
    // GET /repos — list repos accessible via the App installation
    // -------------------------------------------------------------------------
    router.get('/repos', async (ctx) => {
        const pool = getPool(config);
        const uid  = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn?.installation_id) return ctx.json({ error: 'GitHub not connected' }, 404);

        const [appId, key] = requireGitHubConfig(config);
        const token = await generateInstallationToken(appId, key, conn.installation_id);
        const raw   = await listInstallationRepos(token);

        const repos = raw.map(r => ({
            id:            r.id,
            fullName:      r.full_name,
            owner:         r.owner.login,
            name:          r.name,
            defaultBranch: r.default_branch,
            private:       r.private,
            updatedAt:     r.updated_at,
        }));

        return ctx.json({ repos });
    });

    // -------------------------------------------------------------------------
    // GET /connected-repos — list repos added to KB with sync status
    // -------------------------------------------------------------------------
    router.get('/connected-repos', async (ctx) => {
        const pool = getPool(config);
        const uid  = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const rows = await listConnectedRepos(pool, uid);

        const repos = rows.map(r => {
            const [owner, name] = r.full_name.split('/');
            return {
                repoFullName:   r.full_name,
                owner:          owner ?? '',
                name:           name  ?? '',
                defaultBranch:  r.default_branch,
                syncStatus:     r.sync_status ?? r.index_status,
                lastSyncedAt:   r.last_synced_at?.toISOString(),
                fileCount:      r.file_count ?? 0,
                chunkCount:     r.chunk_count ?? 0,
                errorMessage:   r.error_message,
                addedAt:        r.added_at.toISOString(),
            };
        });

        return ctx.json({ repos });
    });

    // -------------------------------------------------------------------------
    // POST /connected-repos — add repo to KB + write pending + dispatch Job
    // Body: { repoFullName: string, defaultBranch?: string, forceReindex?: boolean }
    // -------------------------------------------------------------------------
    router.post('/connected-repos', async (ctx) => {
        const pool = getPool(config);
        const uid  = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn?.installation_id) return ctx.json({ error: 'GitHub not connected' }, 400);

        let body: { repoFullName?: string; defaultBranch?: string; forceReindex?: boolean };
        try { body = await ctx.req.json(); }
        catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

        const repoFullName = body.repoFullName?.trim();
        if (!repoFullName || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoFullName)) {
            return ctx.json({ error: '"repoFullName" must match owner/repo' }, 400);
        }
        const defaultBranch = body.defaultBranch?.trim() || 'main';
        const forceReindex  = body.forceReindex === true;

        const [appId, key] = requireGitHubConfig(config);

        // Quota check before any DB write — fail fast without side effects.
        const { rows: planRows } = await pool.query<{ plan: string }>(
            `SELECT plan FROM users WHERE id = $1::uuid`,
            [uid],
        );
        const plan  = planRows[0]?.plan ?? 'free';
        const limit = getPlanLimit(plan);
        const allowed = await checkAndIncrementQuota(pool, uid, limit);
        if (!allowed) {
            return ctx.json({ error: `Monthly ingestion limit of ${FREE_PLAN_LIMIT} reached. Upgrade to Pro for unlimited syncs.` }, 429);
        }

        // Insert repo row + mark pending before Job dispatch so the UI
        // shows "Queued" immediately even if pod startup takes a few seconds.
        await insertRepository(pool, uid, repoFullName, defaultBranch);
        await markRepoPending(pool, uid, repoFullName);
        await markSyncTriggered(pool, uid, repoFullName);

        // Generate a fresh installation token scoped to this user's repos.
        const githubToken = await generateInstallationToken(appId, key, conn.installation_id);
        const { jobName } = await dispatchIngestionJob(config, uid, repoFullName, githubToken, forceReindex);

        return ctx.json({ status: 'queued', repoFullName, jobName }, 202);
    });

    // -------------------------------------------------------------------------
    // DELETE /connected-repos/:fullName — remove repo + all KB data
    // :fullName is URL-encoded "owner%2Frepo"
    // -------------------------------------------------------------------------
    router.delete('/connected-repos/:fullName', async (ctx) => {
        const pool        = getPool(config);
        const uid         = requireUserId(ctx);
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const repoFullName = decodeURIComponent(ctx.req.param('fullName'));

        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoFullName)) {
            return ctx.json({ error: 'Invalid repo name' }, 400);
        }

        await deleteRepository(pool, uid, repoFullName);
        return ctx.json({ success: true });
    });

    return router;
}

// =============================================================================
// WEBHOOK ROUTER — unauthenticated, mounted outside /api/admin/*
// =============================================================================

/**
 * POST /webhook
 *
 * Receives GitHub App webhook events. No Cognito JWT required — GitHub signs
 * payloads with HMAC-SHA256 using the webhook secret instead.
 *
 * Handled events:
 *   installation.created  — Option B: if user already known, auto-sync repos
 *                           in payload (safety net for GitHub-initiated installs).
 *                           Fresh installs: no-op (user goes through UI redirect
 *                           which triggers POST /installation = Option A).
 *   installation.deleted  — remove oauth_connections row(s) for the installation
 *   installation.suspend / installation.unsuspend — no-op (acknowledged)
 *   push                  — incremental re-index for connected repos (debounced,
 *                           quota-checked, 30-minute cooldown per repo)
 *   *                     — acknowledged with 200, not processed
 *
 * GitHub retries on any non-2xx. Always return 200 once signature is verified,
 * even for unhandled event types, to avoid spurious retries.
 */
export function createGitHubWebhookRouter(config: AdminApiConfig): Hono {
    const router = new Hono();

    router.post('/webhook', async (ctx) => {
        // ── 1. Require webhook secret to be configured ────────────────────────
        const { githubWebhookSecret } = config;
        if (!githubWebhookSecret) {
            console.warn('[github/webhook] GITHUB_WEBHOOK_SECRET not set — endpoint inactive');
            return ctx.json({ error: 'Webhook not configured' }, 501);
        }

        // ── 2. Verify HMAC-SHA256 signature ───────────────────────────────────
        // GitHub sends: X-Hub-Signature-256: sha256=<hex>
        const sigHeader = ctx.req.header('X-Hub-Signature-256') ?? '';
        const rawBody   = await ctx.req.text();

        const expected = 'sha256=' + createHmac('sha256', githubWebhookSecret)
            .update(rawBody)
            .digest('hex');

        // Compare raw buffers — no padding. Length mismatch is itself a rejection signal.
        const sigBuf = Buffer.from(sigHeader);
        const expBuf = Buffer.from(expected);
        const valid  = sigBuf.length === expBuf.length &&
                       timingSafeEqual(sigBuf, expBuf);

        if (!valid) {
            console.warn('[github/webhook] signature mismatch');
            return ctx.json({ error: 'Invalid signature' }, 401);
        }

        // ── 3. Parse event type ───────────────────────────────────────────────
        const eventType = ctx.req.header('X-GitHub-Event') ?? 'unknown';
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(rawBody) as Record<string, unknown>; }
        catch { return ctx.json({ error: 'Invalid JSON payload' }, 400); }

        const action = typeof payload['action'] === 'string' ? payload['action'] : '';

        console.log(`[github/webhook] event=${eventType} action=${action}`);

        // ── 4. installation.deleted — cascade-remove user data ────────────────
        if (eventType === 'installation' && action === 'deleted') {
            const inst = payload['installation'] as Record<string, unknown> | undefined;
            const installationId = String(inst?.['id'] ?? '');

            if (installationId) {
                const pool = getPool(config);
                // Resolve user first so we can cascade via the same deleteConnection helper.
                const user = await lookupUserByInstallation(pool, installationId);
                if (user) {
                    await deleteConnection(pool, user.userId);
                    console.log(`[github/webhook] deleted installation ${installationId} for user ${user.userId}`);
                } else {
                    // Fallback: direct delete by installation_id (no cascades through app helpers).
                    await pool.query(
                        `DELETE FROM oauth_connections
                         WHERE provider = 'github' AND installation_id = $1`,
                        [installationId],
                    );
                    console.log(`[github/webhook] removed installation ${installationId} (user not found — direct delete)`);
                }
            }
            return ctx.json({ ok: true });
        }

        // ── 5. installation.created — Option B safety net ─────────────────────
        // Fires immediately after GitHub App install. The UI redirect (Option A)
        // usually wins the race for fresh installs. This handler only acts when
        // the user is ALREADY known (e.g. GitHub-initiated reinstall bypassing the UI).
        //
        // Dispatches for repos already in the KB (not for payload.repositories),
        // so we never create new KB entries or dispatch jobs for repos the user
        // never explicitly added.
        if (eventType === 'installation' && action === 'created') {
            const inst           = payload['installation'] as Record<string, unknown> | undefined;
            const installationId = String(inst?.['id'] ?? '');

            if (installationId) {
                const pool = getPool(config);
                const user = await lookupUserByInstallation(pool, installationId);

                if (user) {
                    // User already linked — re-dispatch their existing KB repos.
                    const connected = await listConnectedRepos(pool, user.userId);
                    if (connected.length > 0) {
                        const [appId, key] = requireGitHubConfig(config);
                        const token = await generateInstallationToken(appId, key, installationId);
                        const queued = await autoDispatchRepos(
                            config, pool, user.userId, user.plan,
                            connected.map(r => ({ full_name: r.full_name, default_branch: r.default_branch })),
                            token,
                            false,
                        );
                        console.log(`[github/webhook] installation.created: queued ${queued.length} KB repos for user ${user.userId}`);
                    }
                } else {
                    // Fresh install — user not yet linked. Option A (POST /installation) handles this.
                    console.log(`[github/webhook] installation.created: user not yet linked for ${installationId} — awaiting UI redirect`);
                }
            }
            return ctx.json({ ok: true });
        }

        // ── 6. push — incremental re-index (debounced, quota-enforced) ────────
        if (eventType === 'push') {
            const inst         = payload['installation'] as Record<string, unknown> | undefined;
            const repo         = payload['repository']   as Record<string, unknown> | undefined;
            const installationId  = String(inst?.['id']       ?? '');
            const repoFullName    = String(repo?.['full_name'] ?? '');

            if (!installationId || !repoFullName) {
                return ctx.json({ ok: true });
            }

            const pool = getPool(config);

            // Resolve user
            const user = await lookupUserByInstallation(pool, installationId);
            if (!user) return ctx.json({ ok: true });

            // Check repo is actively connected to the KB
            const { rows: repoRows } = await pool.query<{ full_name: string }>(
                `SELECT full_name FROM repositories
                 WHERE user_id = $1::uuid AND provider = 'github' AND full_name = $2`,
                [user.userId, repoFullName],
            );
            if (!repoRows[0]) return ctx.json({ ok: true });

            // Debounce: skip if already running or within cooldown window
            const { rows: syncRows } = await pool.query<{
                sync_status:          string | null;
                last_sync_triggered_at: Date | null;
            }>(
                `SELECT sync_status, last_sync_triggered_at
                 FROM repo_sync_state
                 WHERE user_id = $1::uuid AND repo_full_name = $2`,
                [user.userId, repoFullName],
            );
            const syncState = syncRows[0];

            if (syncState?.sync_status === 'pending' || syncState?.sync_status === 'syncing') {
                console.log(`[github/webhook] push skipped — job already running for ${repoFullName}`);
                return ctx.json({ ok: true });
            }

            if (syncState?.last_sync_triggered_at) {
                const elapsed = Date.now() - new Date(syncState.last_sync_triggered_at).getTime();
                if (elapsed < PUSH_COOLDOWN_MS) {
                    console.log(`[github/webhook] push skipped — cooldown active for ${repoFullName} (${Math.round(elapsed / 60000)}m elapsed)`);
                    return ctx.json({ ok: true });
                }
            }

            // Quota check
            const limit   = getPlanLimit(user.plan);
            const allowed = await checkAndIncrementQuota(pool, user.userId, limit);
            if (!allowed) {
                console.log(`[github/webhook] push skipped — quota exceeded for user ${user.userId}`);
                return ctx.json({ ok: true });
            }

            // Dispatch incremental re-index
            const [appId, key] = requireGitHubConfig(config);
            const token = await generateInstallationToken(appId, key, installationId);

            await markRepoPending(pool, user.userId, repoFullName);
            await markSyncTriggered(pool, user.userId, repoFullName);

            try {
                const { jobName } = await dispatchIngestionJob(
                    config, user.userId, repoFullName, token,
                    false, // incremental — hash-dedup skips unchanged chunks
                );
                console.log(`[github/webhook] push re-index queued for ${repoFullName}: job=${jobName}`);
            } catch (err) {
                console.error(`[github/webhook] push dispatch failed for ${repoFullName}`, (err as Error).message);
            }

            return ctx.json({ ok: true });
        }

        // ── 7. All other events — acknowledge without processing ──────────────
        return ctx.json({ ok: true });
    });

    return router;
}
