/**
 * @format
 * Tests for admin-api routes/pipelines.ts
 *
 * Strategy: mock `@aws-sdk/client-lambda` using `jest.unstable_mockModule()`
 * — the correct ESM-compatible API in Jest 29. All module imports happen
 * through top-level `await import()` so that the mock registry is populated
 * before the route module is evaluated.
 *
 * Note on casting: `noUncheckedIndexedAccess` makes `mock.calls[0]?.[0]`
 * return `T | undefined`. TypeScript strict mode disallows casting
 * `undefined` directly to a concrete type. All payload extractions therefore
 * use the double-cast pattern `as unknown as T` to satisfy the compiler
 * without disabling the safety rule.
 *
 * Coverage:
 *   POST /article     — 400 when slug is missing from body
 *   POST /article     — 400 when slug is an empty string
 *   POST /article     — 202 with correct synthetic S3 event payload
 *   POST /article     — Lambda InvocationType must be 'Event' (fire-and-forget)
 *   POST /article     — S3 event Records[] shape matches S3Handler contract
 *   POST /strategist  — 202 with queued: true and pipeline: 'strategist'
 *   POST /strategist  — Lambda ARN and InvocationType Event
 *   POST /strategist  — Payload wrapped in APIGatewayProxyEventV2 envelope (requestContext + body)
 *   POST /strategist  — Admin UI body forwarded verbatim inside event.body (analyse)
 *   POST /strategist  — Admin UI body forwarded verbatim inside event.body (coach)
 *   POST /strategist  — Malformed body falls back to empty object (202, Lambda rejects internally)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mock — captured by unstable_mockModule closure
// ---------------------------------------------------------------------------

/** Shared LambdaClient.send mock — resolves by default (async fire-and-forget). */
const lambdaSendMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

// ---------------------------------------------------------------------------
// K8s + PG + repo mocks for Phase 4 K8s-Job routes
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
// ESM module mock — MUST be declared before any `await import()`
// ---------------------------------------------------------------------------

jest.unstable_mockModule('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    /** @param _input - constructor input (unused in tests). */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_input: unknown) {}
    send = lambdaSendMock;
  }

  class InvokeCommand {
    /** @param input - Lambda invocation input. */
    constructor(public readonly input: unknown) {}
  }

  return { LambdaClient, InvokeCommand };
});

// ---------------------------------------------------------------------------
// Module imports — after mocks
// ---------------------------------------------------------------------------

/** Resolved application configuration stub for tests. */
const testConfig = {
  assetsBucketName: 'test-assets-bucket',
  articleTriggerArn: 'arn:aws:lambda:eu-west-1:123456789012:function:trigger',
  versionHistoryLambdaArn: 'arn:aws:lambda:eu-west-1:123456789012:function:version-history',
  publishLambdaArn: 'arn:aws:lambda:eu-west-1:123456789012:function:publish',
  strategistTriggerArn: 'arn:aws:lambda:eu-west-1:123456789012:function:strategist',
  dynamoTableName: 'test-table',
  dynamoGsi1Name: 'gsi1-status-date',
  dynamoGsi2Name: 'gsi2-tag-date',
  strategistTableName: 'test-strategist-table',
  resumesTableName: 'test-strategist-table',
  cognitoUserPoolId: 'eu-west-1_TestPool',
  cognitoClientId: 'test-client-id',
  cognitoIssuerUrl: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  ssmBedrockPrefix: '/bedrock/dev',
  awsRegion: 'eu-west-1',
  port: 3002,
  pgHost: 'pgbouncer.platform.svc.cluster.local',
  pgPort: 5432,
  pgDatabase: 'tucaken',
  pgUser: 'postgres',
  pgPassword: 'secret',
  ingestionNamespace: 'ingestion',
  ingestionImage: '771826808455.dkr.ecr.eu-west-1.amazonaws.com/ingestion:latest',
  ingestionServiceAccount: 'ingestion-sa',
  articlePipelineNamespace: 'article-pipeline',
  articlePipelineImage: '771826808455.dkr.ecr.eu-west-1.amazonaws.com/article-pipeline:latest',
  articlePipelineServiceAccount: 'article-pipeline-sa',
  strategistPipelineNamespace: 'job-strategist',
  strategistPipelineImage: '771826808455.dkr.ecr.eu-west-1.amazonaws.com/strategist-pipeline:latest',
  strategistPipelineServiceAccount: 'job-strategist-sa',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a POST request to the pipelines router.
 *
 * @param path - Route path, e.g. '/article' or '/strategist'
 * @param body - JSON request body
 * @returns Hono Response
 */
async function buildRequest(path: string, body: unknown) {
  const { createPipelinesRouter } = await import('../../src/routes/pipelines.js');
  const router = createPipelinesRouter(testConfig as Parameters<typeof createPipelinesRouter>[0]);

  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return router.request(req);
}

/**
 * Extract and parse the Lambda Payload from the first mock call.
 *
 * Uses `as unknown as T` because `noUncheckedIndexedAccess` makes
 * `mock.calls[0]?.[0]` return `T | undefined`, which TypeScript strict
 * mode disallows casting directly to a concrete type.
 *
 * @returns Parsed JSON payload object
 */
function getLastCallPayload<T>(): T {
  const calls = lambdaSendMock.mock.calls as unknown[][];
  const command = calls[0]![0] as unknown as { input: { Payload: Buffer } };
  return JSON.parse(Buffer.from(command.input.Payload).toString('utf-8')) as T;
}

/**
 * Extract the InvokeCommand input from the first mock call.
 *
 * @returns Parsed input object
 */
function getLastCallInput<T>(): T {
  const calls = lambdaSendMock.mock.calls as unknown[][];
  return calls[0]![0] as unknown as T;
}

// ---------------------------------------------------------------------------
// Tests — article pipeline trigger
// ---------------------------------------------------------------------------

describe('POST /article', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lambdaSendMock.mockResolvedValue({});
  });

  it('returns 400 when slug is absent from the body', async () => {
    const res = await buildRequest('/article', {});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('slug is required');
  });

  it('returns 400 when slug is an empty string', async () => {
    const res = await buildRequest('/article', { slug: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 202 with queued: true on success', async () => {
    const res = await buildRequest('/article', { slug: 'my-test-slug' });
    expect(res.status).toBe(202);
    const body = await res.json() as { queued: boolean; pipeline: string; slug: string; key: string };
    expect(body.queued).toBe(true);
    expect(body.pipeline).toBe('article');
    expect(body.slug).toBe('my-test-slug');
    expect(body.key).toBe('drafts/my-test-slug.md');
  });

  it('invokes Lambda with InvocationType Event (fire-and-forget)', async () => {
    await buildRequest('/article', { slug: 'async-test' });
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const command = getLastCallInput<{ input: { InvocationType: string } }>();
    expect(command.input.InvocationType).toBe('Event');
  });

  it('invokes the correct Lambda ARN', async () => {
    await buildRequest('/article', { slug: 'arn-test' });
    const command = getLastCallInput<{ input: { FunctionName: string } }>();
    expect(command.input.FunctionName).toBe(testConfig.articleTriggerArn);
  });

  it('sends a synthetic S3 event with a Records[] array (S3Handler contract)', async () => {
    await buildRequest('/article', { slug: 's3-contract-test' });
    const payload = getLastCallPayload<{
      Records: Array<{ s3: { bucket: { name: string }; object: { key: string } } }>;
    }>();

    // The Lambda iterates Records[] — a missing or empty array causes silent no-op
    expect(Array.isArray(payload.Records)).toBe(true);
    expect(payload.Records).toHaveLength(1);
    expect(payload.Records[0]?.s3.bucket.name).toBe('test-assets-bucket');
    expect(payload.Records[0]?.s3.object.key).toBe('drafts/s3-contract-test.md');
  });

  it('trims leading/trailing whitespace from slug', async () => {
    const res = await buildRequest('/article', { slug: '  trimmed-slug  ' });
    expect(res.status).toBe(202);
    const body = await res.json() as { slug: string; key: string };
    expect(body.slug).toBe('trimmed-slug');
    expect(body.key).toBe('drafts/trimmed-slug.md');
  });
});

// ---------------------------------------------------------------------------
// Tests — strategist pipeline trigger
// ---------------------------------------------------------------------------

describe('POST /strategist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lambdaSendMock.mockResolvedValue({});
  });

  it('returns 202 with queued: true and pipeline: strategist', async () => {
    const res = await buildRequest('/strategist', { operation: 'analyse' });
    expect(res.status).toBe(202);
    const body = await res.json() as { queued: boolean; pipeline: string };
    expect(body.queued).toBe(true);
    expect(body.pipeline).toBe('strategist');
  });

  it('invokes the strategist Lambda ARN with InvocationType Event', async () => {
    await buildRequest('/strategist', { operation: 'analyse' });
    const command = getLastCallInput<{ input: { FunctionName: string; InvocationType: string } }>();
    expect(command.input.FunctionName).toBe(testConfig.strategistTriggerArn);
    expect(command.input.InvocationType).toBe('Event');
  });

  it('wraps body in APIGatewayProxyEventV2 envelope with requestContext', async () => {
    await buildRequest('/strategist', { operation: 'analyse' });
    const payload = getLastCallPayload<{
      requestContext: { http: { method: string } };
      body: string;
    }>();

    // Lambda reads event.requestContext.http.method to reject OPTIONS preflight
    expect(payload.requestContext?.http?.method).toBe('POST');
    // Lambda parses event.body as JSON — must be a serialised string
    expect(typeof payload.body).toBe('string');
  });

  it('forwards the admin UI request body verbatim inside event.body', async () => {
    const analysePayload = {
      operation: 'analyse',
      targetCompany: 'Acme Corp',
      targetRole: 'Senior Engineer',
      jobDescription: 'Build great things',
      resumeId: 'resume-123',
      includeCoverLetter: true,
    };
    await buildRequest('/strategist', analysePayload);
    const envelope = getLastCallPayload<{ body: string }>();
    const forwarded = JSON.parse(envelope.body) as typeof analysePayload;

    // All admin UI fields must reach event.body for Zod validation inside the Lambda
    expect(forwarded.operation).toBe('analyse');
    expect(forwarded.targetCompany).toBe('Acme Corp');
    expect(forwarded.targetRole).toBe('Senior Engineer');
    expect(forwarded.resumeId).toBe('resume-123');
    expect(forwarded.includeCoverLetter).toBe(true);
  });

  it('forwards coach operation fields correctly', async () => {
    const coachPayload = {
      operation: 'coach',
      applicationSlug: 'acme-corp-senior-engineer',
      interviewStage: 'technical',
    };
    await buildRequest('/strategist', coachPayload);
    const envelope = getLastCallPayload<{ body: string }>();
    const forwarded = JSON.parse(envelope.body) as typeof coachPayload;

    expect(forwarded.operation).toBe('coach');
    expect(forwarded.applicationSlug).toBe('acme-corp-senior-engineer');
    expect(forwarded.interviewStage).toBe('technical');
  });

  it('handles malformed body gracefully — falls back to empty envelope', async () => {
    const { createPipelinesRouter } = await import('../../src/routes/pipelines.js');
    const router = createPipelinesRouter(testConfig as Parameters<typeof createPipelinesRouter>[0]);

    const req = new Request('http://localhost/strategist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json',
    });

    // BFF returns 202 — Lambda surfaces the error internally (async invocation)
    const res = await router.request(req);
    expect(res.status).toBe(202);

    const envelope = getLastCallPayload<{ body: string }>();
    // Fallback body is empty object — Lambda's Zod will reject it with 400
    expect(JSON.parse(envelope.body)).toEqual({});
  });
});

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

describe('POST /article-job/:slug — K8s Job article pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createNamespacedJobMock.mockResolvedValue({});
    insertPipelineRunMock.mockResolvedValue(undefined);
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
