/**
 * @format
 * Tests for admin-api routes/articles.ts (PG-only after Phase 5).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Repository + pool mocks
// ---------------------------------------------------------------------------

const pgUpsertMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const pgDeleteArticleMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const pgGetArticleBySlugMock = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const pgListArticlesByStatusMock = jest.fn<() => Promise<never[]>>().mockResolvedValue([]);
const pgListAllArticlesMock = jest.fn<() => Promise<never[]>>().mockResolvedValue([]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const poolQueryMock = jest.fn() as jest.Mock<any>;
poolQueryMock.mockResolvedValue({ rows: [] });

jest.unstable_mockModule('../../src/lib/repositories/articles.js', () => ({
    upsertArticle: pgUpsertMock,
    deleteArticle: pgDeleteArticleMock,
    getArticleBySlug: pgGetArticleBySlugMock,
    listArticlesByStatus: pgListArticlesByStatusMock,
    listAllArticles: pgListAllArticlesMock,
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
    getPool: jest.fn(() => ({ query: poolQueryMock })),
}));

// ---------------------------------------------------------------------------
// Dynamic imports
// ---------------------------------------------------------------------------

const { Hono } = await import('hono');
const { createArticlesRouter } = await import('../../src/routes/articles.js');

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
} as const;

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
  slug: 'my-slug',
  title: 'My Test Article',
  excerpt: null,
  contentMd: '# Hello',
  tags: ['x'],
  status: 'draft',
  aiGenerated: false,
  aiModel: null,
  publishedAt: null,
  coverImage: null,
};

// ---------------------------------------------------------------------------
// GET / — list articles
// ---------------------------------------------------------------------------

describe('GET / — list articles', () => {
  beforeEach(() => {
    pgListAllArticlesMock.mockReset();
    pgListArticlesByStatusMock.mockReset();
  });

  it('calls listAllArticles when ?status=all (default)', async () => {
    pgListAllArticlesMock.mockResolvedValue([ARTICLE_ITEM] as never[]);

    const res = await buildApp().request('/');
    const body = (await res.json()) as { articles: unknown[]; count: number };

    expect(res.status).toBe(200);
    expect(body.articles).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(pgListAllArticlesMock).toHaveBeenCalledTimes(1);
  });

  it('calls listArticlesByStatus when ?status=draft', async () => {
    pgListArticlesByStatusMock.mockResolvedValue([ARTICLE_ITEM] as never[]);

    const res = await buildApp().request('/?status=draft');
    const body = (await res.json()) as { articles: unknown[]; count: number };

    expect(res.status).toBe(200);
    expect(body.articles).toHaveLength(1);
    expect(pgListArticlesByStatusMock).toHaveBeenCalledWith(expect.anything(), 'draft');
  });

  it('returns 400 for an unknown status value', async () => {
    const res = await buildApp().request('/?status=unknown');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid status/);
  });

  it('returns empty articles array when PG returns no items', async () => {
    pgListArticlesByStatusMock.mockResolvedValue([] as never[]);
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
  beforeEach(() => {
    pgGetArticleBySlugMock.mockReset();
  });

  it('returns the article when found', async () => {
    pgGetArticleBySlugMock.mockResolvedValue(ARTICLE_ITEM as never);

    const res = await buildApp().request('/my-slug');
    const body = (await res.json()) as { article: typeof ARTICLE_ITEM };

    expect(res.status).toBe(200);
    expect(body.article.slug).toBe('my-slug');
    expect(body.article.title).toBe('My Test Article');
  });

  it('calls getArticleBySlug with the correct slug', async () => {
    pgGetArticleBySlugMock.mockResolvedValue(ARTICLE_ITEM as never);

    await buildApp().request('/my-slug');

    expect(pgGetArticleBySlugMock).toHaveBeenCalledWith(expect.anything(), 'my-slug');
  });

  it('returns 404 when article is not found', async () => {
    pgGetArticleBySlugMock.mockResolvedValue(null);

    const res = await buildApp().request('/nonexistent-slug');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Article not found');
  });
});

// ---------------------------------------------------------------------------
// PUT /:slug
// ---------------------------------------------------------------------------

describe('PUT /:slug — update article (PG upsert)', () => {
  beforeEach(() => {
    pgUpsertMock.mockReset();
    pgUpsertMock.mockResolvedValue(undefined);
    pgGetArticleBySlugMock.mockReset();
    pgGetArticleBySlugMock.mockResolvedValue(ARTICLE_ITEM as never);
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
    expect(pgUpsertMock).toHaveBeenCalledTimes(1);
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
    expect(pgUpsertMock).not.toHaveBeenCalled();
  });

  it('returns 404 when article does not exist in PG', async () => {
    pgGetArticleBySlugMock.mockResolvedValue(null);
    const res = await buildApp().request('/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Whatever' }),
    });
    expect(res.status).toBe(404);
    expect(pgUpsertMock).not.toHaveBeenCalled();
  });

  it('filters out fields not in the allowed list before upserting', async () => {
    await buildApp().request('/my-slug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New', evilField: 'nope' }),
    });
    expect(pgUpsertMock).toHaveBeenCalledTimes(1);
    const arg = pgUpsertMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(arg['title']).toBe('New');
    expect(arg).not.toHaveProperty('evilField');
  });

  it('merges body fields onto the existing article', async () => {
    await buildApp().request('/my-slug', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
    const arg = pgUpsertMock.mock.calls[0]?.[1] as Record<string, unknown>;
    // status from body, title from existing
    expect(arg['status']).toBe('published');
    expect(arg['title']).toBe('My Test Article');
    expect(arg['slug']).toBe('my-slug');
  });
});

// ---------------------------------------------------------------------------
// DELETE /:slug
// ---------------------------------------------------------------------------

describe('DELETE /:slug — delete article (PG-only)', () => {
  beforeEach(() => {
    pgDeleteArticleMock.mockReset();
    pgDeleteArticleMock.mockResolvedValue(undefined);
  });

  it('returns 200 with deleted: true', async () => {
    const res = await buildApp().request('/my-slug', { method: 'DELETE' });
    const body = (await res.json()) as { deleted: boolean; slug: string };
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.slug).toBe('my-slug');
  });

  it('calls pgDeleteArticle exactly once with the slug', async () => {
    await buildApp().request('/my-slug', { method: 'DELETE' });
    expect(pgDeleteArticleMock).toHaveBeenCalledTimes(1);
    expect(pgDeleteArticleMock).toHaveBeenCalledWith(expect.anything(), 'my-slug');
  });
});

// ---------------------------------------------------------------------------
// POST /:slug/publish
// ---------------------------------------------------------------------------

describe('POST /:slug/publish — flip status to published in PG', () => {
  beforeEach(() => {
    pgGetArticleBySlugMock.mockReset();
    poolQueryMock.mockReset();
    poolQueryMock.mockResolvedValue({ rows: [] });
  });

  it('returns 200 with published: true and runs UPDATE statement', async () => {
    pgGetArticleBySlugMock.mockResolvedValue(ARTICLE_ITEM as never);

    const res = await buildApp().request('/my-slug/publish', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { published: boolean; slug: string };
    expect(body.published).toBe(true);
    expect(body.slug).toBe('my-slug');

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const sql = poolQueryMock.mock.calls[0]?.[0] as string;
    const params = poolQueryMock.mock.calls[0]?.[1] as unknown[];
    expect(sql).toMatch(/UPDATE articles/);
    expect(sql).toMatch(/status = 'published'/);
    expect(sql).toMatch(/COALESCE\(published_at, NOW\(\)\)/);
    expect(params).toEqual(['my-slug']);
  });

  it('returns 404 when article does not exist', async () => {
    pgGetArticleBySlugMock.mockResolvedValue(null);

    const res = await buildApp().request('/missing/publish', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /:slug/versions
// ---------------------------------------------------------------------------

describe('GET /:slug/versions — read pipeline_runs history', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('returns versions mapped from pipeline_runs rows', async () => {
    const now = new Date('2026-04-25T00:00:00.000Z');
    poolQueryMock.mockResolvedValue({
      rows: [
        {
          id: 'run-1',
          status: 'success',
          metadata: { foo: 'bar' },
          error_message: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'run-2',
          status: 'failed',
          metadata: null,
          error_message: 'boom',
          created_at: now,
          updated_at: now,
        },
      ],
    });

    const res = await buildApp().request('/my-slug/versions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      slug: string;
      totalVersions: number;
      versions: Array<{ pipelineRunId: string; status: string; errorMessage: string | null }>;
    };

    expect(body.success).toBe(true);
    expect(body.slug).toBe('my-slug');
    expect(body.totalVersions).toBe(2);
    expect(body.versions[0]?.pipelineRunId).toBe('run-1');
    expect(body.versions[0]?.status).toBe('success');
    expect(body.versions[1]?.pipelineRunId).toBe('run-2');
    expect(body.versions[1]?.errorMessage).toBe('boom');

    const sql = poolQueryMock.mock.calls[0]?.[0] as string;
    const params = poolQueryMock.mock.calls[0]?.[1] as unknown[];
    expect(sql).toMatch(/FROM pipeline_runs/);
    expect(sql).toMatch(/pipeline_type = 'article'/);
    expect(params).toEqual(['my-slug', 20]);
  });

  it('honours ?limit query param (capped at 50)', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await buildApp().request('/my-slug/versions?limit=99');
    const params = poolQueryMock.mock.calls[0]?.[1] as unknown[];
    expect(params).toEqual(['my-slug', 50]);
  });

  it('returns empty versions array when pipeline_runs has no rows', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const res = await buildApp().request('/my-slug/versions');
    const body = (await res.json()) as { totalVersions: number; versions: unknown[] };
    expect(body.totalVersions).toBe(0);
    expect(body.versions).toHaveLength(0);
  });
});
