/**
 * @format
 * Tests for admin-api routes/applications.ts (PG-only after Phase 5).
 *
 * Covers the CRUD-shaped routes:
 *   GET    /                — list applications
 *   GET    /:slug           — application detail (assembled from PG)
 *   DELETE /:slug           — delete application
 *   POST   /:slug/status    — update kanban status
 *
 * The /:slug/coach and /:slug/coaching/:stage routes are covered by
 * applications-coach.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Repository + pool mocks
// ---------------------------------------------------------------------------

const pgListApplicationsMock     = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const pgGetApplicationMock       = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const pgDeleteApplicationMock    = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const pgUpdateApplicationStatusMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const poolQueryMock = jest.fn() as jest.Mock<any>;
poolQueryMock.mockResolvedValue({ rows: [] });

jest.unstable_mockModule('../../src/lib/repositories/applications.js', () => ({
  listApplications:        pgListApplicationsMock,
  getApplication:          pgGetApplicationMock,
  deleteApplication:       pgDeleteApplicationMock,
  updateApplicationStatus: pgUpdateApplicationStatusMock,
}));

jest.unstable_mockModule('../../src/lib/repositories/pipeline-runs.js', () => ({
  insertPipelineRun: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getPipelineRun:    jest.fn(),
}));

jest.unstable_mockModule('../../src/lib/k8s.js', () => ({
  getBatchApi:    () => ({ createNamespacedJob: jest.fn() }),
  _resetBatchApi: () => {},
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
  getPool:    () => ({ query: poolQueryMock }),
  _resetPool: () => {},
}));

// ---------------------------------------------------------------------------
// Dynamic imports
// ---------------------------------------------------------------------------

const { Hono } = await import('hono');
const { createApplicationsRouter } = await import('../../src/routes/applications.js');

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const testConfig = {
  assetsBucketName: 'b',
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
  strategistPipelineNamespace: 'job-strategist',
  strategistPipelineImage: 'img/strategist:latest',
  strategistPipelineServiceAccount: 'job-strategist-sa',
} as const;

function buildApp() {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).set('jwtPayload', { sub: 'test-user' });
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createApplicationsRouter(testConfig as any));
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const APPLICATION_ROW = {
  id: 'app-uuid-1',
  userId: 'user-1',
  company: 'Acme',
  role: 'Senior Engineer',
  jobUrl: 'https://acme.example/jobs/1',
  jobDescription: 'Cool role',
  kanbanStatus: 'analysing',
  appliedAt: null,
  createdAt: new Date('2026-04-01T00:00:00Z'),
  updatedAt: new Date('2026-04-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// GET / — list
// ---------------------------------------------------------------------------

describe('GET / — list applications', () => {
  beforeEach(() => {
    pgListApplicationsMock.mockReset();
  });

  it('returns 200 with summaries from PG', async () => {
    pgListApplicationsMock.mockResolvedValue([APPLICATION_ROW]);
    const res = await buildApp().request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applications: unknown[]; count: number };
    expect(body.applications).toHaveLength(1);
    expect(body.count).toBe(1);
  });

  it('forwards the status filter to the repository', async () => {
    pgListApplicationsMock.mockResolvedValue([]);
    await buildApp().request('/?status=interviewing');
    expect(pgListApplicationsMock).toHaveBeenCalledWith(expect.anything(), 'interviewing');
  });

  it('omits the status filter when not provided', async () => {
    pgListApplicationsMock.mockResolvedValue([]);
    await buildApp().request('/');
    expect(pgListApplicationsMock).toHaveBeenCalledWith(expect.anything(), undefined);
  });
});

// ---------------------------------------------------------------------------
// GET /:slug — detail
// ---------------------------------------------------------------------------

describe('GET /:slug — application detail', () => {
  beforeEach(() => {
    pgGetApplicationMock.mockReset();
    poolQueryMock.mockReset();
    poolQueryMock.mockResolvedValue({ rows: [] });
  });

  it('returns 404 when the application does not exist', async () => {
    pgGetApplicationMock.mockResolvedValue(null);
    const res = await buildApp().request('/missing');
    expect(res.status).toBe(404);
  });

  it('returns 200 with assembled application detail', async () => {
    pgGetApplicationMock.mockResolvedValue(APPLICATION_ROW);
    poolQueryMock
      // pipeline_runs (analysis)
      .mockResolvedValueOnce({
        rows: [{
          id: 'run-1',
          metadata: { analysis: { fitRating: 'STRONG' } },
          created_at: new Date('2026-04-02T00:00:00Z'),
        }],
      })
      // coaching_content
      .mockResolvedValueOnce({
        rows: [{
          stage_type: 'technical',
          topics_to_study:     { topics: ['x'] },
          expected_questions:  { technical: [] },
          personal_highlights: ['win-1'],
        }],
      })
      // resumes
      .mockResolvedValueOnce({
        rows: [{
          id: 'resume-1',
          content_json: { basics: { name: 'Nelson' } },
          generated_at: new Date('2026-04-03T00:00:00Z'),
        }],
      });

    const res = await buildApp().request('/app-uuid-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { application: Record<string, unknown> };
    expect(body.application['id']).toBe('app-uuid-1');
    expect(body.application['slug']).toBe('app-uuid-1');
    expect(body.application['targetCompany']).toBe('Acme');
    expect(body.application['targetRole']).toBe('Senior Engineer');
    expect(body.application['status']).toBe('analysing');
    expect(body.application['analysis']).toEqual({ fitRating: 'STRONG' });
    expect(body.application['latestAnalysisRunId']).toBe('run-1');
    expect(body.application['tailoredResume']).toEqual({ basics: { name: 'Nelson' } });
    expect(body.application['coaching']).toEqual({
      technical: {
        topics:    { topics: ['x'] },
        questions: { technical: [] },
        personal:  ['win-1'],
      },
    });
  });

  it('returns null analysis/resume when no rows exist', async () => {
    pgGetApplicationMock.mockResolvedValue(APPLICATION_ROW);
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })  // pipeline_runs
      .mockResolvedValueOnce({ rows: [] })  // coaching_content
      .mockResolvedValueOnce({ rows: [] }); // resumes

    const res = await buildApp().request('/app-uuid-1');
    const body = (await res.json()) as { application: Record<string, unknown> };
    expect(body.application['analysis']).toBeNull();
    expect(body.application['latestAnalysisRunId']).toBeNull();
    expect(body.application['tailoredResume']).toBeNull();
    expect(body.application['coaching']).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// DELETE /:slug
// ---------------------------------------------------------------------------

describe('DELETE /:slug — delete application (PG-only)', () => {
  beforeEach(() => {
    pgDeleteApplicationMock.mockReset();
    pgDeleteApplicationMock.mockResolvedValue(undefined);
  });

  it('returns 200 with deleted: true', async () => {
    const res = await buildApp().request('/app-uuid-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; slug: string };
    expect(body.deleted).toBe(true);
    expect(body.slug).toBe('app-uuid-1');
  });

  it('calls deleteApplication exactly once with the slug', async () => {
    await buildApp().request('/app-uuid-1', { method: 'DELETE' });
    expect(pgDeleteApplicationMock).toHaveBeenCalledTimes(1);
    expect(pgDeleteApplicationMock).toHaveBeenCalledWith(expect.anything(), 'app-uuid-1');
  });
});

// ---------------------------------------------------------------------------
// POST /:slug/status
// ---------------------------------------------------------------------------

describe('POST /:slug/status — update kanban status (PG-only)', () => {
  beforeEach(() => {
    pgUpdateApplicationStatusMock.mockReset();
    pgUpdateApplicationStatusMock.mockResolvedValue(undefined);
  });

  it('returns 200 and forwards the status to the repository', async () => {
    const res = await buildApp().request('/app-uuid-1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'interviewing' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; status: string };
    expect(body.success).toBe(true);
    expect(body.status).toBe('interviewing');
    expect(pgUpdateApplicationStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'app-uuid-1',
      'interviewing',
    );
  });

  it('returns 400 for an unknown status', async () => {
    const res = await buildApp().request('/app-uuid-1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'bogus' }),
    });
    expect(res.status).toBe(400);
    expect(pgUpdateApplicationStatusMock).not.toHaveBeenCalled();
  });

  it('returns 400 when status is missing', async () => {
    const res = await buildApp().request('/app-uuid-1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(pgUpdateApplicationStatusMock).not.toHaveBeenCalled();
  });

  it('ignores interviewStage in the body (no PG column)', async () => {
    const res = await buildApp().request('/app-uuid-1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'applied', interviewStage: 'screening' }),
    });
    expect(res.status).toBe(200);
    expect(pgUpdateApplicationStatusMock).toHaveBeenCalledTimes(1);
    // signature is (pool, id, status) — interviewStage must not have leaked in
    expect(pgUpdateApplicationStatusMock.mock.calls[0]?.length).toBe(3);
  });
});
