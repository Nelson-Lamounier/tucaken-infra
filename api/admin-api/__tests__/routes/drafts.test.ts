/**
 * @format
 * Tests for admin-api routes/drafts.ts
 *
 * Strategy: mock `@aws-sdk/client-s3` and `@aws-sdk/client-lambda`
 * using `jest.unstable_mockModule()` — the correct ESM-compatible API in
 * Jest 29. All module imports happen through top-level `await import()` so
 * that the mock registry is populated before the route module is evaluated.
 *
 * Coverage:
 *   POST /:slug  — success path: S3 upload + Lambda triggered → { uploaded: true, triggered: true }
 *   POST /:slug  — S3 upload failure → 500
 *   POST /:slug  — Lambda FunctionError → 201 with triggered: false + triggerError
 *   POST /:slug  — Lambda invocation throws → 201 with triggered: false + triggerError
 *   POST /:slug  — missing body.content → 400
 *   POST /:slug  — empty body.content → 400
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mocks — captured by unstable_mockModule closures
// ---------------------------------------------------------------------------

/** Shared S3Client.send mock. */
const s3SendMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

/** Shared LambdaClient.send mock. */
const lambdaSendMock = jest
  .fn<() => Promise<{ FunctionError?: string; Payload?: Buffer }>>()
  .mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: true })) });

// ---------------------------------------------------------------------------
// ESM module mocks — MUST be declared before any `await import()`
// ---------------------------------------------------------------------------

jest.unstable_mockModule('@aws-sdk/client-s3', () => {
  class S3Client {
    /** @param _input - constructor input. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_input: unknown) {}
    send = s3SendMock;
  }

  class PutObjectCommand {
    /** @param input - PutObject command input. */
    constructor(public readonly input: unknown) {}
  }

  return { S3Client, PutObjectCommand };
});

jest.unstable_mockModule('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    /** @param _input - constructor input. */
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
// Module imports — after mocks so they resolve to the mock implementations
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

/** Build a synthetic Hono request context for the router under test. */
async function buildRequest(slug: string, body: unknown, headers: Record<string, string> = {}) {
  const { createDraftsRouter } = await import('../../src/routes/drafts.js');
  const router = createDraftsRouter(testConfig as Parameters<typeof createDraftsRouter>[0]);

  const req = new Request(`http://localhost/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  return router.request(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/admin/drafts/:slug', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    s3SendMock.mockResolvedValue({});
    lambdaSendMock.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ ok: true })),
    });
  });

  it('returns 201 { uploaded: true, triggered: true } on success', async () => {
    const res = await buildRequest('my-slug', { content: '# Draft content' });
    expect(res.status).toBe(201);
    const body = await res.json() as { uploaded: boolean; triggered: boolean; slug: string; key: string };
    expect(body.uploaded).toBe(true);
    expect(body.triggered).toBe(true);
    expect(body.slug).toBe('my-slug');
    expect(body.key).toBe('drafts/my-slug.md');
  });

  it('calls S3 PutObject with the correct bucket and key', async () => {
    await buildRequest('test-article', { content: '# Hello World' });
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    const s3Calls = s3SendMock.mock.calls as unknown[][];
    const command = s3Calls[0]![0] as unknown as { input: { Bucket: string; Key: string } };
    expect(command.input.Bucket).toBe('test-assets-bucket');
    expect(command.input.Key).toBe('drafts/test-article.md');
  });

  it('calls Lambda with a synthetic S3 event containing Records[]', async () => {
    await buildRequest('s3-event-test', { content: '# Content' });
    const lambdaCalls = lambdaSendMock.mock.calls as unknown[][];
    const command = lambdaCalls[0]![0] as unknown as {
      input: { FunctionName: string; InvocationType: string; Payload: Buffer };
    };
    expect(command.input.FunctionName).toBe(testConfig.articleTriggerArn);
    expect(command.input.InvocationType).toBe('RequestResponse');
    const payload = JSON.parse(Buffer.from(command.input.Payload).toString('utf-8')) as {
      Records: Array<{ s3: { bucket: { name: string }; object: { key: string } } }>;
    };
    expect(payload.Records).toHaveLength(1);
    expect(payload.Records[0]?.s3.bucket.name).toBe('test-assets-bucket');
    expect(payload.Records[0]?.s3.object.key).toBe('drafts/s3-event-test.md');
  });

  it('returns 400 when content is missing', async () => {
    const res = await buildRequest('missing-content', {});
    expect(res.status).toBe(400);
  });

  it('returns 400 when content is an empty string', async () => {
    const res = await buildRequest('empty-content', { content: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 500 when S3 PutObject fails', async () => {
    s3SendMock.mockRejectedValue(new Error('S3 Access Denied'));
    const res = await buildRequest('s3-fail-slug', { content: '# Test' });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('S3 upload failed');
  });

  it('returns 201 with triggered: false when Lambda returns FunctionError', async () => {
    lambdaSendMock.mockResolvedValue({
      FunctionError: 'Handled',
      Payload: Buffer.from(JSON.stringify({ errorType: 'Error', errorMessage: 'IAM denied' })),
    });
    const res = await buildRequest('lambda-error-slug', { content: '# Test' });
    expect(res.status).toBe(201);
    const body = await res.json() as { uploaded: boolean; triggered: boolean; triggerError: string };
    expect(body.uploaded).toBe(true);
    expect(body.triggered).toBe(false);
    expect(body.triggerError).toBe('Handled');
  });

  it('returns 201 with triggered: false when Lambda invocation throws', async () => {
    lambdaSendMock.mockRejectedValue(new Error('Network timeout'));
    const res = await buildRequest('lambda-throw-slug', { content: '# Test' });
    expect(res.status).toBe(201);
    const body = await res.json() as { uploaded: boolean; triggered: boolean; triggerError: string };
    expect(body.uploaded).toBe(true);
    expect(body.triggered).toBe(false);
    expect(body.triggerError).toContain('Network timeout');
  });
});
