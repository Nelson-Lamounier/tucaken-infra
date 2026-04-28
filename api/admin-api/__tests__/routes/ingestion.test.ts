/**
 * @format
 * Tests for admin-api routes/ingestion.ts
 *
 * Mocks `../../src/lib/k8s.js` so the route is exercised against a fake
 * BatchV1Api client. Covers validation, successful Job creation, and error
 * propagation when the K8s API call rejects.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared K8s mock — captured by unstable_mockModule
// ---------------------------------------------------------------------------

const createNamespacedJobMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

jest.unstable_mockModule('../../src/lib/k8s.js', () => ({
    getBatchApi: () => ({ createNamespacedJob: createNamespacedJobMock }),
    _resetBatchApi: () => {},
}));

// ---------------------------------------------------------------------------
// Dynamic imports — resolved AFTER mocks are registered
// ---------------------------------------------------------------------------

const { Hono } = await import('hono');
const { createIngestionRouter } = await import('../../src/routes/ingestion.js');

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const testConfig = {
  assetsBucketName: 'test-bucket',
  cognitoUserPoolId: 'eu-west-1_TestPool',
  cognitoClientId: 'testClient',
  cognitoIssuerUrl: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  awsRegion: 'eu-west-1',
  port: 3002,
  pgHost: 'pgbouncer.platform.svc.cluster.local',
  pgPort: 5432,
  pgDatabase: 'tucaken',
  pgUser: 'postgres',
  pgPassword: 'secret',
  ingestionNamespace: 'ingestion',
  ingestionServiceAccount: 'ingestion-sa',
} as const;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).set('jwtPayload', { sub: 'test-user' });
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createIngestionRouter(testConfig as any));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /trigger — create ingestion Job', () => {
  beforeEach(async () => {
    createNamespacedJobMock.mockReset();
    createNamespacedJobMock.mockResolvedValue({});
    // getJobImage() resolves env-var fallback when JOB_IMAGES_DIR is unset
    // or empty; tests set INGESTION_IMAGE so the trigger guard succeeds.
    process.env['INGESTION_IMAGE'] = '771826808455.dkr.ecr.eu-west-1.amazonaws.com/ingestion:latest';
    const { _resetJobImageCache } = await import('../../src/lib/config.js');
    _resetJobImageCache();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const res = await buildApp().request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/valid JSON/);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 400 when repoFullName is missing', async () => {
    const res = await buildApp().request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/repoFullName/);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 400 when repoFullName does not match owner/repo', async () => {
    const res = await buildApp().request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'invalid' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/owner\/repo/);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 202 with jobName and creates a Job whose env contains USER_ID/REPO_FULL_NAME/FORCE_REINDEX', async () => {
    const res = await buildApp().request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'octocat/hello-world', forceReindex: true }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      jobName: string;
      userId: string;
      repoFullName: string;
      forceReindex: boolean;
    };
    expect(body.status).toBe('queued');
    expect(body.jobName).toMatch(/^ingestion-test-user-octocat-hello-world-[0-9a-f]{8}$/);
    expect(body.jobName.length).toBeLessThanOrEqual(63);
    expect(body.userId).toBe('test-user');
    expect(body.repoFullName).toBe('octocat/hello-world');
    expect(body.forceReindex).toBe(true);

    expect(createNamespacedJobMock).toHaveBeenCalledTimes(1);
    const callArgs = createNamespacedJobMock.mock.calls[0] as unknown as [string, { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } }];
    expect(callArgs[0]).toBe('ingestion');

    const env = callArgs[1].spec.template.spec.containers[0]!.env;
    const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(envMap['USER_ID']).toBe('test-user');
    expect(envMap['REPO_FULL_NAME']).toBe('octocat/hello-world');
    expect(envMap['FORCE_REINDEX']).toBe('true');
  });

  it('defaults forceReindex to false when omitted', async () => {
    const res = await buildApp().request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'octocat/hello-world' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { forceReindex: boolean };
    expect(body.forceReindex).toBe(false);
  });

  it('caps the Job name at 63 chars even for very long repoFullName', async () => {
    const longRepo = `${'a'.repeat(100)}/${'b'.repeat(100)}`;
    const res = await buildApp().request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: longRepo }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobName: string };
    expect(body.jobName.length).toBeLessThanOrEqual(63);
    expect(body.jobName).toMatch(/^ingestion-/);
    expect(body.jobName).toMatch(/-[0-9a-f]{8}$/);
  });

  it('returns 502 when the K8s API rejects', async () => {
    createNamespacedJobMock.mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await buildApp().request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'octocat/hello-world' }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Failed to schedule/);
    consoleSpy.mockRestore();
  });
});
