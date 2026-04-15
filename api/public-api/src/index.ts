/**
 * @file index.ts
 * @description Entry point for the public-api Hono service.
 *
 * Assembles the application by mounting:
 *   - CORS middleware (all routes)
 *   - Health route   → GET /healthz
 *   - Articles route → GET /api/articles, GET /api/articles/:slug
 *   - Tags route     → GET /api/tags
 *   - Resumes route  → GET /api/resumes/active
 *
 * ## Credential Chain
 *
 * No AWS credentials are configured in code. The AWS SDK v3 default
 * credential provider chain resolves credentials automatically via
 * the EC2 Instance Profile (IMDS) attached to the Kubernetes node.
 * The `AWS_DEFAULT_REGION` environment variable (from `nextjs-config`
 * ConfigMap) is used by the SDK to determine the target region.
 *
 * ## Port
 *
 * Defaults to `3001`. Override via the `PORT` environment variable.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { loadConfig } from './lib/config.js';
import health from './routes/health.js';
import articles from './routes/articles.js';
import chatbot from './routes/chatbot.js';
import tags from './routes/tags.js';
import resumes from './routes/resumes.js';

const cfg = loadConfig();

const app = new Hono();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

/** Structured request logging to stdout. */
app.use('*', logger());

/** CORS — allow portfolio origin and local dev. */
app.use(
  '*',
  cors({
    origin: ['https://nelsonlamounier.com', 'http://localhost:3000'],
    // POST added for /api/chatbot/invoke (BFF proxy — Gap S2)
    allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
    allowHeaders: ['Content-Type', 'Accept'],
    credentials: false,
    maxAge: 86_400,
  }),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.route('/', health);
app.route('/', articles);
app.route('/', chatbot);
app.route('/', tags);
app.route('/', resumes);

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json({ error: 'Not found', path: c.req.path }, 404);
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('[public-api] Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

console.log(`[public-api] Starting on port ${cfg.port}`);
console.log(`[public-api] Region: ${cfg.awsRegion}`);
console.log(`[public-api] Table: ${cfg.dynamoTableName}`);

serve({
  fetch: app.fetch,
  port: cfg.port,
});
