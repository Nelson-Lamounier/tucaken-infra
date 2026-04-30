/**
 * Integration test setup — loads .env files in priority order.
 * Vitest runs from api/admin-api/, so paths are relative to that dir.
 *
 * Load order (first wins for each key):
 *   1. api/admin-api/.env  — Cognito IDs, local service URLs
 *   2. ../../.env           — RDS port-forward vars, TEST_USER_* credentials
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(path: string): void {
  try {
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
    console.log('[setup] Loaded', path);
  } catch {
    console.warn('[setup] No .env at', path, '— skipping');
  }
}

loadEnvFile(resolve(process.cwd(), '.env'));          // api/admin-api/.env
loadEnvFile(resolve(process.cwd(), '../../.env'));    // repo root .env
