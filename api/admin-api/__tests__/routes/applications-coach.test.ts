/**
 * @format
 * Tests for the Phase 4 coaching routes added to admin-api/routes/applications.ts:
 *
 *   POST /:slug/coach                     — schedule the coach K8s Job
 *   GET  /:slug/coaching/:stage           — read the coaching_content row
 *
 * Mocking strategy mirrors pipelines.test.ts: ESM-friendly
 * `jest.unstable_mockModule` for k8s, pg, and the pipeline-runs repo.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — declared before `await import()` so the mock registry is hot.
// ---------------------------------------------------------------------------

const createNamespacedJobMock = jest.fn<() => Promise<object>>().mockResolvedValue({});
const insertPipelineRunMock   = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const pgQueryMock             = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });

jest.unstable_mockModule('../../src/lib/k8s.js', () => ({
  getBatchApi:    () => ({ createNamespacedJob: createNamespacedJobMock }),
  _resetBatchApi: () => {},
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
  getPool:    () => ({ query: pgQueryMock }),
  _resetPool: () => {},
}));

jest.unstable_mockModule('../../src/lib/repositories/pipeline-runs.js', () => ({
  insertPipelineRun: insertPipelineRunMock,
  getPipelineRun:    jest.fn(),
}));

// Stub the applications repo — the coach routes don't use it but the module
// imports it at the top level.
jest.unstable_mockModule('../../src/lib/repositories/applications.js', () => ({
  listApplications:        jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
  getApplication:          jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
  updateApplicationStatus: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  deleteApplication:       jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Test config + helpers
// ---------------------------------------------------------------------------

const testConfig = {
  assetsBucketName: 'test-assets-bucket',
  cognitoUserPoolId: 'eu-west-1_X',
  cognitoClientId: 'c',
  cognitoIssuerUrl: 'https://example.com',
  awsRegion: 'eu-west-1',
  port: 3002,
  pgHost: 'pgbouncer',
  pgPort: 5432,
  pgDatabase: 'tucaken',
  pgUser: 'postgres',
  pgPassword: 'secret',
  ingestionNamespace: 'ingestion',
  ingestionServiceAccount: 'ingestion-sa',
  articlePipelineNamespace: 'article-pipeline',
  articlePipelineServiceAccount: 'article-pipeline-sa',
  strategistPipelineNamespace: 'job-strategist',
  strategistPipelineServiceAccount: 'job-strategist-sa',
};

const { Hono } = await import('hono');

async function buildAuthedApp(jwtSub: string | null = 'test-user') {
  const { createApplicationsRouter } = await import('../../src/routes/applications.js');
  const app = new Hono();
  if (jwtSub !== null) {
    app.use('*', async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set('jwtPayload', { sub: jwtSub });
      await next();
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createApplicationsRouter(testConfig as any));
  return app;
}

const validBody = {
  strategistPipelineRunId: 'strat-run-1',
  interviewStage:          'technical',
  applicationId:           'app-123',
  targetCompany:           'Acme',
  targetRole:              'Senior Engineer',
  jobDescription:          'Build cool stuff',
};

// ---------------------------------------------------------------------------
// POST /:slug/coach
// ---------------------------------------------------------------------------

// getJobImage() env-var fallback for tests (no file mount in jest).
process.env['STRATEGIST_PIPELINE_IMAGE'] = '771826808455.dkr.ecr.eu-west-1.amazonaws.com/job-strategist:latest';

describe('POST /:slug/coach', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    createNamespacedJobMock.mockResolvedValue({});
    insertPipelineRunMock.mockResolvedValue(undefined);
    const { _resetJobImageCache } = await import('../../src/lib/config.js');
    _resetJobImageCache();
  });

  it('returns 401 when JWT sub missing', async () => {
    const app = await buildAuthedApp(null);
    const res = await app.request('/acme-eng/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it.each([
    ['strategistPipelineRunId'],
    ['interviewStage'],
    ['applicationId'],
    ['targetCompany'],
    ['targetRole'],
    ['jobDescription'],
  ])('returns 400 when %s missing', async (field) => {
    const body: Record<string, unknown> = { ...validBody };
    delete body[field];
    const app = await buildAuthedApp();
    const res = await app.request('/acme-eng/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const out = await res.json() as { error: string };
    expect(out.error).toContain(field);
  });

  it('returns 500 when PG insert rejects', async () => {
    insertPipelineRunMock.mockRejectedValueOnce(new Error('pg down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = await buildAuthedApp();
    const res = await app.request('/acme-eng/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(500);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns 502 when K8s rejects', async () => {
    createNamespacedJobMock.mockRejectedValueOnce(new Error('k8s down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = await buildAuthedApp();
    const res = await app.request('/acme-eng/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(502);
    consoleSpy.mockRestore();
  });

  it('returns 202 with coachPipelineRunId and creates a Job in job-strategist', async () => {
    const app = await buildAuthedApp();
    const res = await app.request('/acme-eng/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as {
      status: string; coachPipelineRunId: string; jobName: string;
      applicationId: string; interviewStage: string;
    };
    expect(body.status).toBe('queued');
    expect(body.coachPipelineRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.jobName.length).toBeLessThanOrEqual(63);
    expect(body.applicationId).toBe('app-123');
    expect(body.interviewStage).toBe('technical');

    expect(insertPipelineRunMock).toHaveBeenCalledTimes(1);
    expect(createNamespacedJobMock).toHaveBeenCalledTimes(1);

    const callArgs = createNamespacedJobMock.mock.calls[0] as unknown as [
      string,
      { spec: { template: { spec: { containers: Array<{ command: string[]; env: Array<{ name: string; value: string }> }> } } } },
    ];
    expect(callArgs[0]).toBe('job-strategist');
    const container = callArgs[1].spec.template.spec.containers[0]!;
    expect(container.command).toEqual(['node', 'dist/run-coach.js']);
    const envMap = Object.fromEntries(container.env.map(e => [e.name, e.value]));
    expect(envMap['COACH_PIPELINE_RUN_ID']).toBe(body.coachPipelineRunId);
    expect(envMap['STRATEGIST_PIPELINE_RUN_ID']).toBe('strat-run-1');
    expect(envMap['APPLICATION_ID']).toBe('app-123');
    expect(envMap['APPLICATION_SLUG']).toBe('acme-eng');
    expect(envMap['USER_ID']).toBe('test-user');
    expect(envMap['INTERVIEW_STAGE']).toBe('technical');
    expect(envMap['TARGET_COMPANY']).toBe('Acme');
    expect(envMap['TARGET_ROLE']).toBe('Senior Engineer');
    expect(envMap['JOB_DESCRIPTION']).toBe('Build cool stuff');
    expect(envMap['MODE']).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// GET /:slug/coaching/:stage
// ---------------------------------------------------------------------------

describe('GET /:slug/coaching/:stage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pgQueryMock.mockResolvedValue({ rows: [] });
  });

  it('returns 400 when applicationId query param missing', async () => {
    const app = await buildAuthedApp();
    const res = await app.request('/acme-eng/coaching/technical');
    expect(res.status).toBe(400);
    const out = await res.json() as { error: string };
    expect(out.error).toMatch(/applicationId/);
  });

  it('returns 404 when no row exists yet (Job still running)', async () => {
    pgQueryMock.mockResolvedValueOnce({ rows: [] });
    const app = await buildAuthedApp();
    const res = await app.request('/acme-eng/coaching/technical?applicationId=app-123');
    expect(res.status).toBe(404);
  });

  it('returns 200 with coaching content when row exists', async () => {
    const generatedAt = new Date('2026-04-25T12:00:00Z');
    pgQueryMock.mockResolvedValueOnce({
      rows: [{
        topics_to_study:     { stage: 'technical' },
        expected_questions:  { technical: [], behavioural: [], difficult: [] },
        personal_highlights: [],
        generated_at:        generatedAt,
      }],
    });
    const app = await buildAuthedApp();
    const res = await app.request('/acme-eng/coaching/technical?applicationId=app-123');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      applicationId: string; stage: string;
      coaching: unknown; questions: unknown; personalHighlights: unknown;
      generatedAt: string;
    };
    expect(body.applicationId).toBe('app-123');
    expect(body.stage).toBe('technical');
    expect(body.coaching).toEqual({ stage: 'technical' });
    expect(body.questions).toEqual({ technical: [], behavioural: [], difficult: [] });
    expect(body.personalHighlights).toEqual([]);
  });
});
