/**
 * Integration test setup — loads .env from the repo root.
 * Vitest runs from api/admin-api/, so we walk up two levels.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '../../.env');

try {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
  console.log('[setup] Loaded .env from', envPath);
} catch {
  console.warn('[setup] No .env found at', envPath, '— using process.env as-is');
}
