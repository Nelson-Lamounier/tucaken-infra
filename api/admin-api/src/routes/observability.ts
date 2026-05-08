/**
 * @format
 * admin-api — Observability endpoints (probes + Prometheus scrape target).
 *
 *   GET /metrics   Prometheus exposition (scraped by Alloy / Prometheus)
 *   GET /livez     Liveness — process is alive. Restart pod on failure.
 *   GET /readyz    Readiness — process AND deps healthy. Withhold traffic.
 *
 * `livez` deliberately does NOT touch the DB. K8s liveness failure restarts
 * the pod; transient PG outages must NOT cause a restart storm.
 *
 * `readyz` runs a 1s-bounded SELECT 1. Slow / failing DB drops the pod from
 * the Service endpoint until recovered, without killing the process.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';

import { registry } from '../lib/observability/metrics.js';

export function createObservabilityRouter(pool: Pool): Hono {
  const router = new Hono();

  router.get('/metrics', async (ctx) => {
    const body = await registry.metrics();
    return ctx.body(body, 200, { 'Content-Type': registry.contentType });
  });

  router.get('/livez', (ctx) => ctx.json({ status: 'ok' }));

  router.get('/readyz', async (ctx) => {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return ctx.json({ status: 'ready' });
    } catch (err) {
      return ctx.json({ status: 'not-ready', reason: (err as Error).message }, 503);
    } finally {
      client.release();
    }
  });

  return router;
}
