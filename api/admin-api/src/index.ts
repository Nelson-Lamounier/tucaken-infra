/**
 * @format
 * admin-api — Hono application entrypoint.
 *
 * BFF (Backend for Frontend) for the tucaken-app TanStack application.
 *
 * Architecture:
 *   - All routes under /api/admin/* are protected by Cognito JWT middleware
 *   - /healthz is exempt from auth (Kubernetes probes cannot send JWTs)
 *   - AWS credentials come from EC2 Instance Profile (IMDS) — no secrets in pod
 *   - Port 3002 (public-api uses 3001, admin-api uses 3002)
 *
 * Credential model:
 *   Secret   (admin-api-secrets)  — Cognito IDs only
 *   ConfigMap (admin-api-config)  — DynamoDB tables, bucket, Lambda ARNs, region
 *   IMDS                         — AWS SDK credentials (DynamoDB, S3, Lambda)
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { loadConfig } from './lib/config.js';
import { logger as appLogger } from './lib/observability/logger.js';
import { getPool } from './lib/pg.js';
import { cognitoJwtAuth, requireAdminGroup } from './middleware/auth.js';
import { observabilityMiddleware } from './middleware/observability.js';
import { userProvisionMiddleware } from './middleware/user-provision.js';
import { createApplicationsRouter } from './routes/applications.js';
import { createArticlesRouter } from './routes/articles.js';
import { createAssetsRouter } from './routes/assets.js';
import { createBedrockUsageRouter } from './routes/bedrock-usage.js';
import { createFinopsRouter } from './routes/finops.js';
import { createGitHubRouter, createGitHubWebhookRouter } from './routes/github.js';
import { createHealthRouter } from './routes/health.js';
import { createIngestionRouter } from './routes/ingestion.js';
import { createMeRouter } from './routes/me.js';
import { createObservabilityRouter } from './routes/observability.js';
import { createPipelinesRouter } from './routes/pipelines.js';
import { createPromptFeedbackRouter } from './routes/prompt-feedback.js';
import { createPublicRouter } from './routes/public.js';
import { createResumeImportsRouter } from './routes/resume-imports.js';
import { createResumesRouter } from './routes/resumes.js';

// ── Startup Validation ───────────────────────────────────────────────────────
// loadConfig() throws immediately if any required env var is absent.
// This ensures misconfiguration surfaces as a CrashLoopBackOff (visible in
// ArgoCD) rather than a runtime error hours later on the first request.
const config = loadConfig();

// ── Application ──────────────────────────────────────────────────────────────
const app = new Hono();

// Structured logging + RED metrics + request_id + Server-Timing.
// Replaces hono/logger — emits pino JSON with trace_id/span_id from
// the active OTel span, recorded as one line per request at completion.
app.use('*', observabilityMiddleware);

// CORS — allow only the tucaken-app TanStack origin.
// The public-api has its own CORS configuration for portfolio visitors.
app.use(
  '/api/admin/*',
  cors({
    origin: [
      // tucaken-app TanStack application — served at the canonical domain.
      // CloudFront's tucaken.com distribution 301-redirects to tucaken.io at the
      // edge, so browsers never send cross-origin requests from .com after the
      // first hop. www.tucaken.io is also redirected at CloudFront.
      //
      // Note: after the BFF migration all API calls originate from server functions
      // (pod-to-pod), so the browser never sends cross-origin requests to admin-api.
      // This origin config is enforced as a defence-in-depth measure for any future
      // client-side fetch, not for the current server-function pattern.
      'https://tucaken.io',
      // local TanStack dev server
      'http://localhost:3000',
      'http://localhost:5001',
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
);

// ── Health + observability endpoints (unauthenticated) ──────────────────────
// /healthz   — legacy, kept for existing Dockerfile HEALTHCHECK
// /livez     — K8s liveness probe (process alive)
// /readyz    — K8s readiness probe (DB reachable)
// /metrics   — Prometheus scrape target (NetworkPolicy restrict to monitoring ns)
app.route('/healthz', createHealthRouter());
app.route('/',        createObservabilityRouter(getPool(config)));

// ── GitHub webhook (unauthenticated — HMAC-verified) ─────────────────────────
// Must be registered BEFORE the JWT middleware which guards /api/admin/*.
// GitHub posts to /api/github/webhook; does not carry a Cognito token.
app.route('/api/github', createGitHubWebhookRouter(config));

// ── Public routes (unauthenticated — read-only, non-sensitive) ───────────────
// Registered before the JWT middleware so sign-up flows can call these
// without a session token (e.g. email-exists check before Cognito SignUp).
app.route('/api/public', createPublicRouter(config));

// ── Cognito JWT guard — applied to all /api/admin/* routes ───────────────────
const jwtMiddleware = cognitoJwtAuth(
  config.cognitoUserPoolId,
  config.cognitoClientId,
  config.cognitoIssuerUrl,
  config.awsRegion,
);

app.use('/api/admin/*', jwtMiddleware);

// ── User provisioning — runs after JWT auth, before route handlers ────────────
// Upserts the users row on first request per Cognito sub, then caches the
// resolved users.id UUID in ctx for downstream handlers.
app.use('/api/admin/*', userProvisionMiddleware(getPool(config)));

// ── Staff-only gates ──────────────────────────────────────────────────────────
app.use('/api/admin/bedrock-usage/*', requireAdminGroup());
app.use('/api/admin/finops/*',        requireAdminGroup());
app.use('/api/admin/ingestion/*',     requireAdminGroup());

// ── Protected routes ─────────────────────────────────────────────────────────
app.route('/api/admin/bedrock-usage', createBedrockUsageRouter(config));
app.route('/api/admin/me',           createMeRouter(config));
app.route('/api/admin/github',       createGitHubRouter(config));
app.route('/api/admin/articles', createArticlesRouter(config));
app.route('/api/admin/applications', createApplicationsRouter(config));
app.route('/api/admin/assets', createAssetsRouter(config));
app.route('/api/admin/finops', createFinopsRouter(config));
app.route('/api/admin/ingestion', createIngestionRouter(config));
app.route('/api/admin/pipelines', createPipelinesRouter(config));
app.route('/api/admin/resumes', createResumesRouter(config));
app.route('/api/admin/resume-imports', createResumeImportsRouter(config));
app.route('/api/admin/prompt-feedback', createPromptFeedbackRouter(config));

// ── 404 handler ──────────────────────────────────────────────────────────────
app.notFound((ctx) => ctx.json({ error: 'Not found' }, 404));

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, ctx) => {
  // Use the request-bound logger when available so trace_id + request_id
  // are attached automatically; fall back to root logger pre-middleware.
  const log = ctx.get('logger') ?? appLogger;
  log.error({ err, path: ctx.req.path }, 'unhandled error');
  return ctx.json({ error: 'Internal server error' }, 500);
});

// ── Server ───────────────────────────────────────────────────────────────────
serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    appLogger.info({ port: info.port, cognito_pool: config.cognitoUserPoolId }, 'admin-api listening');
  },
);
