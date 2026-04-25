/**
 * @format
 * Tests for admin-api routes/articles.ts
 *
 * Strategy: mock `../../src/lib/dynamo.js` and `@aws-sdk/client-lambda`
 * using `jest.unstable_mockModule()` — the correct ESM-compatible API in
 * Jest 29. All module imports happen through top-level `await import()` so
 * that the mock registry is populated before the route module is evaluated.
 *
 * Coverage:
 *   GET  /                    — list all statuses (fan-out)
 *   GET  /                    — list single status
 *   GET  /                    — 400 on invalid status param
 *   GET  /:slug               — found article
 *   GET  /:slug               — 404 when item absent
 *   PUT  /:slug               — updates allowed fields only
 *   PUT  /:slug               — syncs gsi1pk on status change
 *   PUT  /:slug               — 400 when no valid fields supplied
 *   DELETE /:slug             — cascade deletes both DynamoDB records
 *   POST /:slug/publish       — invokes Lambda asynchronously
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared send mocks — live in module scope; captured by unstable_mockModule
// ---------------------------------------------------------------------------

/** Shared docClient.send mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendMock = jest.fn() as jest.Mock<any>;

/** Shared LambdaClient.send mock. */
const lambdaSendMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

// ---------------------------------------------------------------------------
// ESM module mocks — MUST happen before any `await import()` of the modules
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../src/lib/dynamo.js', () => ({
  docClient: { send: sendMock },
}));

jest.unstable_mockModule('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    /** @param _input - constructor input (unused in tests) */
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

const pgUpsertMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/lib/repositories/articles.js', () => ({
    upsertArticle: pgUpsertMock,
    deleteArticle: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getArticleBySlug: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    listArticlesByStatus: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
    listAllArticles: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
    getPool: jest.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Dynamic imports — resolved AFTER mocks are registered
// ---------------------------------------------------------------------------

const { Hono } = await import('hono');
const { createArticlesRouter } = await import('../../src/routes/articles.js');

// Module-scope app used by PG shadow-write tests (mounts router at /api/admin/articles)
const _appForPgTests = new Hono();
_appForPgTests.use('*', async (ctx, next) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).set('jwtPayload', { sub: 'test-user-sub' });
  await next();
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
_appForPgTests.route('/api/admin/articles', createArticlesRouter({ dynamoTableName: 'test-articles', dynamoGsi1Name: 'gsi1-status-date', dynamoGsi2Name: 'gsi2-tag-date', assetsBucketName: 'test-bucket', publishLambdaArn: 'arn:aws:lambda:eu-west-1:123:function:publish', articleTriggerArn: 'arn:aws:lambda:eu-west-1:123:function:trigger', strategistTriggerArn: 'arn:aws:lambda:eu-west-1:123:function:strategist', strategistTableName: 'test-strategist', resumesTableName: 'test-strategist', cognitoUserPoolId: 'eu-west-1_TestPool', cognitoClientId: 'testClient', cognitoIssuerUrl: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool', awsRegion: 'eu-west-1', port: 3002, pgHost: 'pgbouncer.platform.svc.cluster.local', pgPort: 5432, pgDatabase: 'tucaken', pgUser: 'postgres', pgPassword: 'secret' } as any));
const app = _appForPgTests;

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

/** @type {import('../../src/lib/config.js').AdminApiConfig} */
const testConfig = {
  dynamoTableName: 'test-articles',
  dynamoGsi1Name: 'gsi1-status-date',
  dynamoGsi2Name: 'gsi2-tag-date',
  assetsBucketName: 'test-bucket',
  publishLambdaArn: 'arn:aws:lambda:eu-west-1:123:function:publish',
  articleTriggerArn: 'arn:aws:lambda:eu-west-1:123:function:trigger',
  strategistTriggerArn: 'arn:aws:lambda:eu-west-1:123:function:strategist',
  strategistTableName: 'test-strategist',
  resumesTableName: 'test-strategist',
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
} as const;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Builds the test Hono app with a stub JWT middleware.
 *
 * @returns Configured Hono app with articles router mounted at /.
 */
function buildApp() {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).set('jwtPayload', { sub: 'test-user-sub' });
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createArticlesRouter(testConfig as any));
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ARTICLE_ITEM = {
  pk: 'ARTICLE#my-slug',
  sk: 'METADATA',
  gsi1pk: 'STATUS#draft',
  slug: 'my-slug',
  title: 'My Test Article',
  status: 'draft',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// GET / — list articles
// ---------------------------------------------------------------------------

describe('GET / — list articles', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('fans out across all four statuses when ?status=all (default)', async () => {
    sendMock.mockResolvedValue({ Items: [ARTICLE_ITEM] });

    const res = await buildApp().request('/');
    const body = (await res.json()) as { articles: unknown[]; count: number };

    expect(res.status).toBe(200);
    expect(body.articles).toHaveLength(4); // 4 statuses × 1 item each
    expect(body.count).toBe(4);
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it('queries a single status bucket when ?status=draft', async () => {
    sendMock.mockResolvedValue({ Items: [ARTICLE_ITEM] });

    const res = await buildApp().request('/?status=draft');
    const body = (await res.json()) as { articles: unknown[]; count: number };

    expect(res.status).toBe(200);
    expect(body.articles).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(callArg.input.ExpressionAttributeValues[':gsi1pk']).toBe('STATUS#draft');
  });

  it('returns 400 for an unknown status value', async () => {
    const res = await buildApp().request('/?status=unknown');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid status/);
  });

  it('returns empty articles array when DynamoDB has no items', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const res = await buildApp().request('/?status=published');
    const body = (await res.json()) as { articles: unknown[]; count: number };
    expect(body.articles).toHaveLength(0);
    expect(body.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /:slug
// ---------------------------------------------------------------------------

describe('GET /:slug — get article by slug', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('returns the article when found', async () => {
    sendMock.mockResolvedValue({ Item: ARTICLE_ITEM });

    const res = await buildApp().request('/my-slug');
    const body = (await res.json()) as { article: typeof ARTICLE_ITEM };

    expect(res.status).toBe(200);
    expect(body.article.slug).toBe('my-slug');
    expect(body.article.title).toBe('My Test Article');
  });

  it('queries DynamoDB with the correct composite key', async () => {
    sendMock.mockResolvedValue({ Item: ARTICLE_ITEM });

    await buildApp().request('/my-slug');

    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { Key: Record<string, string> };
    };
    expect(callArg.input.Key['pk']).toBe('ARTICLE#my-slug');
    expect(callArg.input.Key['sk']).toBe('METADATA');
  });

  it('returns 404 when article is not found', async () => {
    sendMock.mockResolvedValue({ Item: undefined });

    const res = await buildApp().request('/nonexistent-slug');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Article not found');
  });
});

// ---------------------------------------------------------------------------
// PUT /:slug
// ---------------------------------------------------------------------------

describe('PUT /:slug — update article', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    pgUpsertMock.mockClear();
  });

  it('returns 200 with updated: true on success', async () => {
    const res = await buildApp().request('/my-slug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated Title' }),
    });
    const body = (await res.json()) as { updated: boolean; slug: string };
    expect(res.status).toBe(200);
    expect(body.updated).toBe(true);
    expect(body.slug).toBe('my-slug');
  });

  it('returns 400 when body contains no valid fields', async () => {
    const res = await buildApp().request('/my-slug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unknownField: 'value', anotherBadField: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No valid fields/);
  });

  it('syncs gsi1pk when status is updated', async () => {
    await buildApp().request('/my-slug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(callArg.input.ExpressionAttributeValues[':gsi1pk']).toBe('STATUS#published');
  });

  it('does not include gsi1pk when status is not in the update', async () => {
    await buildApp().request('/my-slug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No Status Change' }),
    });
    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(callArg.input.ExpressionAttributeValues[':gsi1pk']).toBeUndefined();
  });

  it('always stamps updatedAt regardless of which fields are updated', async () => {
    await buildApp().request('/my-slug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Any Title' }),
    });
    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(callArg.input.ExpressionAttributeValues[':updatedAt']).toBeTruthy();
  });

  it('should attempt PG shadow write on successful DynamoDB update', async () => {
    sendMock.mockResolvedValue({ Attributes: { slug: 'test-slug', title: 'Updated' } });
    const res = await app.request('/api/admin/articles/test-slug', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
    });
    expect(res.status).toBe(200);
    expect(pgUpsertMock).toHaveBeenCalledTimes(1);
  });

  it('should still return 200 when PG shadow write fails', async () => {
    sendMock.mockResolvedValue({ Attributes: { slug: 'test-slug', title: 'Updated' } });
    (pgUpsertMock as jest.Mock).mockRejectedValueOnce(new Error('PG timeout'));
    const res = await app.request('/api/admin/articles/test-slug', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:slug
// ---------------------------------------------------------------------------

describe('DELETE /:slug — cascade delete article', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('returns 200 with deleted: true', async () => {
    const res = await buildApp().request('/my-slug', { method: 'DELETE' });
    const body = (await res.json()) as { deleted: boolean; slug: string };
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.slug).toBe('my-slug');
  });

  it('issues exactly two DynamoDB delete commands (METADATA + CONTENT cascade)', async () => {
    await buildApp().request('/my-slug', { method: 'DELETE' });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('targets the METADATA record', async () => {
    await buildApp().request('/my-slug', { method: 'DELETE' });
    const keys = sendMock.mock.calls.map(
      (c) => (c[0] as { input: { Key: Record<string, string> } }).input.Key,
    );
    expect(keys).toContainEqual({ pk: 'ARTICLE#my-slug', sk: 'METADATA' });
  });

  it('targets the CONTENT record in the cascade delete', async () => {
    await buildApp().request('/my-slug', { method: 'DELETE' });
    const keys = sendMock.mock.calls.map(
      (c) => (c[0] as { input: { Key: Record<string, string> } }).input.Key,
    );
    expect(keys).toContainEqual({ pk: 'ARTICLE#my-slug', sk: 'CONTENT#my-slug' });
  });
});

// ---------------------------------------------------------------------------
// POST /:slug/publish
// ---------------------------------------------------------------------------

describe('POST /:slug/publish — trigger publish Lambda', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('returns 200 with queued: true', async () => {
    const res = await buildApp().request('/my-slug/publish', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean; slug: string };
    expect(body.queued).toBe(true);
    expect(body.slug).toBe('my-slug');
  });
});
