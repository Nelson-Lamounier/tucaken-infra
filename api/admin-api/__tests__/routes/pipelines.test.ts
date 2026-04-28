/**
 * @format
 * Tests for admin-api routes/pipelines.ts (Phase 5 — K8s Job-only).
 *
 * The legacy Lambda-based article/strategist routes were removed in Phase 5;
 * these tests cover only the K8s Job-based replacements.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// K8s + PG + repo mocks for K8s-Job routes
// ---------------------------------------------------------------------------

const createNamespacedJobMock = jest.fn<() => Promise<object>>().mockResolvedValue({});
const insertPipelineRunMock   = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const getPipelineRunMock      = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../../src/lib/k8s.js', () => ({
  getBatchApi:     () => ({ createNamespacedJob: createNamespacedJobMock }),
  _resetBatchApi:  () => {},
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
  getPool:   () => ({}),
  _resetPool: () => {},
}));

jest.unstable_mockModule('../../src/lib/repositories/pipeline-runs.js', () => ({
  insertPipelineRun: insertPipelineRunMock,
  getPipelineRun:    getPipelineRunMock,
}));

// ---------------------------------------------------------------------------
// Module imports — after mocks
// ---------------------------------------------------------------------------

/** Resolved application configuration stub for tests. */
const testConfig = {
  assetsBucketName: 'test-assets-bucket',
  cognitoUserPoolId: 'eu-west-1_TestPool',
  cognitoClientId: 'test-client-id',
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
  articlePipelineNamespace: 'article-pipeline',
  articlePipelineServiceAccount: 'article-pipeline-sa',
  strategistPipelineNamespace: 'job-strategist',
  strategistPipelineServiceAccount: 'job-strategist-sa',
};

// ---------------------------------------------------------------------------
// Phase 4 — K8s-Job-based pipeline routes
// ---------------------------------------------------------------------------

const { Hono } = await import('hono');

async function buildAuthedApp(jwtSub: string | null = 'test-user') {
  const { createPipelinesRouter } = await import('../../src/routes/pipelines.js');
  const app = new Hono();
  if (jwtSub !== null) {
    app.use('*', async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set('jwtPayload', { sub: jwtSub });
      await next();
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createPipelinesRouter(testConfig as any));
  return app;
}

// getJobImage() falls back to env vars when no file mount is present.
// Setting these globally keeps the trigger-route guards happy in tests.
process.env['ARTICLE_PIPELINE_IMAGE']    = '771826808455.dkr.ecr.eu-west-1.amazonaws.com/article-pipeline:latest';
process.env['STRATEGIST_PIPELINE_IMAGE'] = '771826808455.dkr.ecr.eu-west-1.amazonaws.com/job-strategist:latest';

describe('POST /article-job/:slug — K8s Job article pipeline', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    createNamespacedJobMock.mockResolvedValue({});
    insertPipelineRunMock.mockResolvedValue(undefined);
    const { _resetJobImageCache } = await import('../../src/lib/config.js');
    _resetJobImageCache();
  });

  it('returns 401 when JWT sub is missing', async () => {
    const app = await buildAuthedApp(null);
    const res = await app.request('/article-job/my-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3Bucket: 'b', s3SourceKey: 'k' }),
    });
    expect(res.status).toBe(401);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 400 when s3Bucket missing', async () => {
    const app = await buildAuthedApp();
    const res = await app.request('/article-job/my-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3SourceKey: 'k' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/s3Bucket/);
  });

  it('returns 400 when s3SourceKey missing', async () => {
    const app = await buildAuthedApp();
    const res = await app.request('/article-job/my-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3Bucket: 'b' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/s3SourceKey/);
  });

  it('returns 202 with pipelineRunId and creates a Job carrying expected env vars', async () => {
    const app = await buildAuthedApp();
    const res = await app.request('/article-job/my-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3Bucket: 'my-bucket', s3SourceKey: 'drafts/foo.md' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { status: string; pipelineRunId: string; jobName: string; slug: string };
    expect(body.status).toBe('queued');
    expect(body.pipelineRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.jobName.length).toBeLessThanOrEqual(63);
    expect(body.slug).toBe('my-slug');

    expect(insertPipelineRunMock).toHaveBeenCalledTimes(1);
    expect(createNamespacedJobMock).toHaveBeenCalledTimes(1);

    const callArgs = createNamespacedJobMock.mock.calls[0] as unknown as [string, { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } }];
    expect(callArgs[0]).toBe('article-pipeline');
    const env = callArgs[1].spec.template.spec.containers[0]!.env;
    const envMap = Object.fromEntries(env.map(e => [e.name, e.value]));
    expect(envMap['PIPELINE_RUN_ID']).toBe(body.pipelineRunId);
    expect(envMap['SLUG']).toBe('my-slug');
    expect(envMap['S3_BUCKET']).toBe('my-bucket');
    expect(envMap['S3_SOURCE_KEY']).toBe('drafts/foo.md');
    expect(envMap['MODE']).toBe('kb-augmented');
  });

  it('returns 500 when PG insert rejects', async () => {
    insertPipelineRunMock.mockRejectedValueOnce(new Error('pg down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = await buildAuthedApp();
    const res = await app.request('/article-job/my-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3Bucket: 'b', s3SourceKey: 'k' }),
    });
    expect(res.status).toBe(500);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns 502 when K8s rejects', async () => {
    createNamespacedJobMock.mockRejectedValueOnce(new Error('k8s down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = await buildAuthedApp();
    const res = await app.request('/article-job/my-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3Bucket: 'b', s3SourceKey: 'k' }),
    });
    expect(res.status).toBe(502);
    consoleSpy.mockRestore();
  });
});

describe('POST /strategist-job — K8s Job strategist pipeline', () => {
  const validBody = {
    applicationId:   'app-123',
    applicationSlug: 'acme-senior-engineer',
    targetCompany:   'Acme',
    targetRole:      'Senior Engineer',
    jobDescription:  'Build cool stuff',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    createNamespacedJobMock.mockResolvedValue({});
    insertPipelineRunMock.mockResolvedValue(undefined);
  });

  it.each([
    ['applicationId',   { ...validBody, applicationId:   undefined }],
    ['applicationSlug', { ...validBody, applicationSlug: undefined }],
    ['targetCompany',   { ...validBody, targetCompany:   undefined }],
    ['targetRole',      { ...validBody, targetRole:      undefined }],
    ['jobDescription',  { ...validBody, jobDescription:  undefined }],
  ])('returns 400 when %s is missing', async (field, body) => {
    const app = await buildAuthedApp();
    const res = await app.request('/strategist-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const out = await res.json() as { error: string };
    expect(out.error).toContain(field);
  });

  it('returns 202 with env vars containing application + target metadata', async () => {
    const app = await buildAuthedApp();
    const res = await app.request('/strategist-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { status: string; pipelineRunId: string; jobName: string; applicationId: string };
    expect(body.status).toBe('queued');
    expect(body.applicationId).toBe('app-123');

    const callArgs = createNamespacedJobMock.mock.calls[0] as unknown as [string, { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } }];
    expect(callArgs[0]).toBe('job-strategist');
    const env = callArgs[1].spec.template.spec.containers[0]!.env;
    const envMap = Object.fromEntries(env.map(e => [e.name, e.value]));
    expect(envMap['PIPELINE_RUN_ID']).toBe(body.pipelineRunId);
    expect(envMap['APPLICATION_ID']).toBe('app-123');
    expect(envMap['APPLICATION_SLUG']).toBe('acme-senior-engineer');
    expect(envMap['USER_ID']).toBe('test-user');
    expect(envMap['TARGET_COMPANY']).toBe('Acme');
    expect(envMap['TARGET_ROLE']).toBe('Senior Engineer');
    expect(envMap['JOB_DESCRIPTION']).toBe('Build cool stuff');
    expect(envMap['MODE']).toBe('standard');
  });
});

describe('GET /runs/:id — pipeline run status polling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 404 when run not found', async () => {
    getPipelineRunMock.mockResolvedValueOnce(null);
    const app = await buildAuthedApp();
    const res = await app.request('/runs/missing-id');
    expect(res.status).toBe(404);
  });

  it('returns 403 when userId mismatch', async () => {
    getPipelineRunMock.mockResolvedValueOnce({
      id: 'r1', userId: 'other-user', pipelineType: 'article',
      referenceId: null, status: 'queued', errorMessage: null, metadata: null,
    });
    const app = await buildAuthedApp('test-user');
    const res = await app.request('/runs/r1');
    expect(res.status).toBe(403);
  });

  it('returns 200 with run when ownership matches', async () => {
    const runFixture = {
      id: 'r1', userId: 'test-user', pipelineType: 'article',
      referenceId: 'slug-x', status: 'running', errorMessage: null,
      metadata: { foo: 'bar' },
    };
    getPipelineRunMock.mockResolvedValueOnce(runFixture);
    const app = await buildAuthedApp('test-user');
    const res = await app.request('/runs/r1');
    expect(res.status).toBe(200);
    const body = await res.json() as { run: typeof runFixture };
    expect(body.run.id).toBe('r1');
    expect(body.run.status).toBe('running');
  });
});
