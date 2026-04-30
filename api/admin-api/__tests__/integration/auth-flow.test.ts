/**
 * Integration — sign-in / sign-up provisioning flow.
 *
 * Prerequisites (run in separate terminals before this test):
 *   just db-tunnel      — port-forwards RDS to localhost:5433
 *   just pf-admin-api   — port-forwards admin-api to localhost:3002
 *
 * Required env vars (loaded from repo-root .env by setup.ts):
 *   COGNITO_USER_POOL_ID   — eu-west-1_mNRJM2InT
 *   COGNITO_CLIENT_ID      — 3jtefdlkq4ipg7mlrkhprmob06
 *   TEST_USER_EMAIL        — a real Cognito user's email
 *   TEST_USER_PASSWORD     — their password
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD — RDS via port-forward
 *
 * What this covers:
 *   1. Cognito USER_PASSWORD_AUTH → obtain real ID token
 *   2. GET /api/admin/me with Bearer token → 200
 *   3. users row created with correct email, role, plan, trial dates
 *   4. user_identities row linked to Cognito sub
 *   5. plan_events 'trial_started' audit row created
 *   6. GET /api/admin/me again (returning user) → still 200, same id
 *   7. Missing / invalid tokens → 401
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ─── Config ──────────────────────────────────────────────────────────────────

const ADMIN_API      = process.env['ADMIN_API_URL']           ?? 'http://localhost:3002';
const POOL_ID        = process.env['COGNITO_USER_POOL_ID']    ?? '';
const CLIENT_ID      = process.env['COGNITO_CLIENT_ID']       ?? '';
const TEST_EMAIL     = process.env['TEST_USER_EMAIL']         ?? '';
const TEST_PASSWORD  = process.env['TEST_USER_PASSWORD']      ?? '';
const REGION         = POOL_ID.split('_')[0] ?? 'eu-west-1';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCognitoIdToken(): Promise<{ idToken: string; sub: string }> {
  console.log(`\n[cognito] Signing in as ${TEST_EMAIL} via USER_PASSWORD_AUTH...`);

  const client = new CognitoIdentityProviderClient({ region: REGION });
  const res = await client.send(
    new InitiateAuthCommand({
      AuthFlow:        'USER_PASSWORD_AUTH',
      ClientId:        CLIENT_ID,
      AuthParameters:  { USERNAME: TEST_EMAIL, PASSWORD: TEST_PASSWORD },
    }),
  );

  const idToken = res.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw new Error(
      `[cognito] Auth failed — no IdToken. ChallengeName: ${res.ChallengeName ?? 'none'}`,
    );
  }

  // Decode sub from the JWT payload (no verification needed here — admin-api does that)
  const payloadB64 = idToken.split('.')[1] ?? '';
  const payload    = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as Record<string, unknown>;
  const sub        = payload['sub'] as string;

  console.log(`[cognito] ✓ Token obtained. sub=${sub}`);
  return { idToken, sub };
}

async function callMe(token: string): Promise<Response> {
  const url = `${ADMIN_API}/api/admin/me`;
  console.log(`[http] GET ${url}`);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  console.log(`[http] → ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[http] Response body: ${body}`);
  }
  return res;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let pool:    Pool;
let idToken: string;
let sub:     string;

beforeAll(async () => {
  // Validate required env vars before spending time on network calls
  const missing = [
    !POOL_ID      && 'COGNITO_USER_POOL_ID',
    !CLIENT_ID    && 'COGNITO_CLIENT_ID',
    !TEST_EMAIL   && 'TEST_USER_EMAIL',
    !TEST_PASSWORD && 'TEST_USER_PASSWORD',
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  pool = new Pool({
    host:     process.env['PGHOST']     ?? 'localhost',
    port:     parseInt(process.env['PGPORT'] ?? '5433', 10),
    database: process.env['PGDATABASE'] ?? 'tucaken',
    user:     process.env['PGUSER']     ?? 'postgres',
    password: process.env['PGPASSWORD'] ?? '',
  });

  // Verify DB connection before running tests
  try {
    await pool.query('SELECT 1');
    console.log('[db] ✓ Connected to RDS via port-forward');
  } catch (err) {
    throw new Error(
      `[db] Cannot connect to RDS — is "just db-tunnel" running?\n${String(err)}`,
    );
  }

  // Verify admin-api is reachable
  try {
    const health = await fetch(`${ADMIN_API}/healthz`);
    console.log(`[http] ✓ admin-api /healthz → ${health.status}`);
  } catch (err) {
    throw new Error(
      `[http] Cannot reach admin-api at ${ADMIN_API} — is "just pf-admin-api" running?\n${String(err)}`,
    );
  }

  // Obtain Cognito token once — shared across all tests in this file
  ({ idToken, sub } = await getCognitoIdToken());
});

afterAll(async () => {
  await pool.end();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/admin/me', () => {
  it('returns 200 with valid Cognito token', async () => {
    const res = await callMe(idToken);
    expect(res.status).toBe(200);
  });

  it('response body has id, email, and plan fields', async () => {
    const res  = await callMe(idToken);
    const body = await res.json() as Record<string, unknown>;

    console.log('[me] Response:', JSON.stringify(body, null, 2));

    expect(body).toMatchObject({
      id:    expect.any(String),
      email: TEST_EMAIL,
      plan:  expect.objectContaining({
        plan:          expect.stringMatching(/^(free|pro)$/),
        effectivePlan: expect.stringMatching(/^(free|pro|trial)$/),
      }),
    });
  });

  it('is idempotent — second call returns same users.id', async () => {
    const res1 = await callMe(idToken);
    const res2 = await callMe(idToken);
    const b1   = await res1.json() as { id: string };
    const b2   = await res2.json() as { id: string };

    expect(b1.id).toBe(b2.id);
  });

  it('returns 401 with no Authorization header', async () => {
    const res = await fetch(`${ADMIN_API}/api/admin/me`);
    console.log(`[http] No-auth → ${res.status}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 with a malformed token', async () => {
    const res = await fetch(`${ADMIN_API}/api/admin/me`, {
      headers: { Authorization: 'Bearer not.a.real.token' },
    });
    console.log(`[http] Bad-token → ${res.status}`);
    expect(res.status).toBe(401);
  });
});

describe('Database provisioning', () => {
  it('users row exists with correct email and role', async () => {
    const { rows } = await pool.query<{
      id: string; email: string; role: string; plan: string;
      trial_started_at: Date | null; trial_ends_at: Date | null;
    }>(
      `SELECT id, email, role, plan, trial_started_at, trial_ends_at
         FROM users WHERE email = $1`,
      [TEST_EMAIL],
    );

    console.log('[db] users row:', rows[0]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(TEST_EMAIL);
    expect(rows[0]!.role).toBe('user');
    expect(rows[0]!.plan).toBe('free');
  });

  it('trial dates are set (14-day window)', async () => {
    const { rows } = await pool.query<{
      trial_started_at: Date; trial_ends_at: Date;
    }>(
      `SELECT trial_started_at, trial_ends_at FROM users WHERE email = $1`,
      [TEST_EMAIL],
    );

    const { trial_started_at, trial_ends_at } = rows[0]!;
    console.log('[db] trial_started_at:', trial_started_at, 'trial_ends_at:', trial_ends_at);

    expect(trial_started_at).not.toBeNull();
    expect(trial_ends_at).not.toBeNull();

    const diffDays =
      (new Date(trial_ends_at).getTime() - new Date(trial_started_at).getTime()) /
      (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(14, 0);
  });

  it('user_identities row links the Cognito sub', async () => {
    const { rows } = await pool.query<{
      cognito_sub: string; provider: string;
    }>(
      `SELECT ui.cognito_sub, ui.provider
         FROM user_identities ui
         JOIN users u ON u.id = ui.user_id
        WHERE u.email = $1`,
      [TEST_EMAIL],
    );

    console.log('[db] user_identities rows:', rows);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.cognito_sub === sub)).toBe(true);
  });

  it('plan_events has a trial_started row', async () => {
    const { rows } = await pool.query<{ event_type: string; reason: string }>(
      `SELECT pe.event_type, pe.reason
         FROM plan_events pe
         JOIN users u ON u.id = pe.user_id
        WHERE u.email = $1 AND pe.event_type = 'trial_started'`,
      [TEST_EMAIL],
    );

    console.log('[db] plan_events:', rows);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('new_user_signup');
  });
});
