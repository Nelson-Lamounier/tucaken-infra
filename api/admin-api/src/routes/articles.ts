/**
 * @format
 * admin-api — Article management routes.
 *
 * Routes (all protected by Cognito JWT middleware applied at the router level):
 *
 *   GET    /api/admin/articles               — List articles, optionally filtered by status.
 *                                              ?status=all|draft|review|published|rejected
 *                                              Default: all (fan-out across all statuses)
 *   GET    /api/admin/articles/:slug         — Get article by slug (primary key)
 *   GET    /api/admin/articles/:slug/versions — List pipeline version history for a slug
 *   PUT    /api/admin/articles/:slug         — Update article metadata; syncs gsi1pk on
 *                                              status change so GSI queries stay consistent.
 *   DELETE /api/admin/articles/:slug         — Cascade delete METADATA + CONTENT#<slug>
 *   POST   /api/admin/articles/:slug/publish — Trigger publish Lambda pipeline (async)
 *
 * BFF note:
 *   This BFF is the sole write path for the start-admin TanStack application.
 *   The public-api service exposes the corresponding read-only endpoints for
 *   portfolio visitors — these admin routes must never be exposed publicly.
 *
 * DynamoDB GSI pattern:
 *   Articles are stored with gsi1pk = 'STATUS#<status>' (e.g. 'STATUS#draft') so
 *   that listing by status requires only a GSI KeyConditionExpression, not a Scan.
 *   The attribute name is `gsi1pk`, NOT `status` — these are two separate attributes.
 */

import { Hono } from 'hono';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { JWTPayload } from 'jose';
import type { AdminApiConfig } from '../lib/config.js';
import { docClient } from '../lib/dynamo.js';
import { getPool } from '../lib/pg.js';
import { upsertArticle, deleteArticle as pgDeleteArticle } from '../lib/repositories/articles.js';

/** Hono context variable bindings for admin-api authenticated routes. */
type AdminApiBindings = {
  Variables: {
    jwtPayload: JWTPayload;
  };
};

/** Lazily-initialised Lambda client — resolves credentials from IMDS. */
let _lambdaClient: LambdaClient | undefined;

/**
 * Get or create the singleton Lambda client.
 *
 * @returns Singleton LambdaClient.
 */
function getLambdaClient(): LambdaClient {
  if (!_lambdaClient) {
    _lambdaClient = new LambdaClient({
      region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
    });
  }
  return _lambdaClient;
}

/**
 * Create the articles admin router.
 *
 * @param config - Resolved application configuration.
 * @returns Hono router with article management routes.
 */
export function createArticlesRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  // -----------------------------------------------------------------------
  // GET /api/admin/articles
  // List articles by status using GSI1 (gsi1pk = 'STATUS#<status>').
  //
  // Query param: ?status=all|draft|review|published|rejected
  // Default: 'all' — fans out across all four statuses in parallel.
  //
  // GSI design: the partition key on the index is `gsi1pk` (e.g.
  // 'STATUS#draft'), NOT the `status` attribute itself.
  // -----------------------------------------------------------------------

  /** Valid article statuses queryable via GSI1. */
  const ALL_STATUSES = ['draft', 'processing', 'review', 'published', 'rejected', 'flagged'] as const;

  /**
   * Query GSI1 for a single status string.
   *
   * Filters on BOTH gsi1pk (GSI partition key) AND the status attribute so
   * that articles whose gsi1pk is stale (e.g. Lambda updated `status` but
   * forgot to sync `gsi1pk`) never bleed into the wrong tab.
   *
   * @param status - Lowercase status (e.g. 'draft')
   * @returns Raw DynamoDB Items array
   */
  async function queryByStatus(status: string): Promise<Record<string, unknown>[]> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: config.dynamoTableName,
        IndexName: config.dynamoGsi1Name,
        KeyConditionExpression: 'gsi1pk = :gsi1pk',
        // Exclude VERSION#v<n> records (share gsi1pk with METADATA).
        // Also filter by status attribute — guards against stale gsi1pk values
        // where a pipeline Lambda updated `status` but forgot to sync `gsi1pk`.
        FilterExpression: 'sk = :sk AND #st = :status',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':gsi1pk': `STATUS#${status}`,
          ':sk': 'METADATA',
          ':status': status,
        },
        ScanIndexForward: false, // newest first
        Limit: 100,
      }),
    );
    return (result.Items ?? []) as Record<string, unknown>[];
  }

  router.get('/', async (ctx) => {
    const rawStatus = (ctx.req.query('status') ?? 'all').toLowerCase();

    let items: Record<string, unknown>[];

    if (rawStatus === 'all') {
      // Fan-out: query all four status buckets concurrently
      const results = await Promise.all(ALL_STATUSES.map(queryByStatus));
      items = results.flat();
    } else if ((ALL_STATUSES as readonly string[]).includes(rawStatus)) {
      items = await queryByStatus(rawStatus);
    } else {
      return ctx.json({ error: `Invalid status "${rawStatus}". Must be one of: all, ${ALL_STATUSES.join(', ')}` }, 400);
    }

    return ctx.json({
      articles: items,
      count: items.length,
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/admin/articles/:slug
  // Fetch full article metadata by primary key.
  // -----------------------------------------------------------------------
  router.get('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');

    const result = await docClient.send(
      new GetCommand({
        TableName: config.dynamoTableName,
        Key: { pk: `ARTICLE#${slug}`, sk: 'METADATA' },
      }),
    );

    if (!result.Item) {
      return ctx.json({ error: 'Article not found' }, 404);
    }

    return ctx.json({ article: result.Item });
  });

  // -----------------------------------------------------------------------
  // PUT /api/admin/articles/:slug
  // Update article metadata fields (title, excerpt, tags, status, etc.).
  //
  // When `status` is included in the body, gsi1pk is also updated so the
  // item appears in the correct GSI bucket on the next list query.
  // -----------------------------------------------------------------------
  router.put('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');
    const body = await ctx.req.json<Record<string, unknown>>();

    const allowedFields = [
      'title', 'excerpt', 'tags', 'status', 'coverImage',
      'author', 'category', 'publishedAt', 'seo',
    ];
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowedFields.includes(k)),
    );

    if (Object.keys(updates).length === 0) {
      return ctx.json({ error: 'No valid fields to update' }, 400);
    }

    const expressionParts: string[] = [];
    const exprAttrNames: Record<string, string> = {};
    const exprAttrValues: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(updates)) {
      const nameAlias = `#${key}`;
      const valueAlias = `:${key}`;
      expressionParts.push(`${nameAlias} = ${valueAlias}`);
      exprAttrNames[nameAlias] = key;
      exprAttrValues[valueAlias] = value;

      // Sync GSI1 partition key when status changes, so the item
      // moves to the correct bucket in the status-date index.
      if (key === 'status' && typeof value === 'string') {
        exprAttrValues[':gsi1pk'] = `STATUS#${value}`;
        expressionParts.push('gsi1pk = :gsi1pk');

        // For published articles, stamp publishedAt if not already set
        if (value === 'published' && !updates['publishedAt']) {
          exprAttrValues[':publishedAt'] = new Date().toISOString();
          expressionParts.push('publishedAt = if_not_exists(publishedAt, :publishedAt)');
        }
      }
    }

    // Always stamp updatedAt
    exprAttrNames['#updatedAt'] = 'updatedAt';
    exprAttrValues[':updatedAt'] = new Date().toISOString();
    expressionParts.push('#updatedAt = :updatedAt');

    await docClient.send(
      new UpdateCommand({
        TableName: config.dynamoTableName,
        Key: { pk: `ARTICLE#${slug}`, sk: 'METADATA' },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: exprAttrNames,
        ExpressionAttributeValues: exprAttrValues,
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );

    // Shadow write to PG — non-fatal during dual-write period
    // Only write when we have a complete record (title + contentMd present).
    // Partial updates (status/tag changes) are synced via the migration job.
    // NOTE: contentMd is not in allowedFields (not a DynamoDB field), so we
    // read it from the raw body rather than from the filtered `updates` map.
    if ('title' in updates && 'contentMd' in body) {
        try {
            const pool = getPool(config);
            const contentMd   = typeof body['contentMd']   === 'string'  ? body['contentMd']   : '';
            const aiGenerated = typeof body['aiGenerated'] === 'boolean' ? body['aiGenerated'] : false;
            const aiModel     = typeof body['aiModel']     === 'string'  ? body['aiModel']     : null;
            await upsertArticle(pool, {
                slug,
                title:       (updates['title']      as string)            ?? '',
                excerpt:     (updates['excerpt']     as string | null)     ?? null,
                contentMd,
                tags:        (updates['tags']        as string[])          ?? [],
                status:      (updates['status']      as string)            ?? 'draft',
                aiGenerated,
                aiModel,
                publishedAt: updates['publishedAt']  ? new Date(updates['publishedAt'] as string) : null,
                coverImage:  (updates['coverImage']  as string | null)     ?? null,
            });
        } catch (pgErr: unknown) {
            console.error(`[articles] PG shadow write failed — slug=${slug}`, pgErr);
        }
    }

    return ctx.json({ updated: true, slug });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/admin/articles/:slug
  // Cascade-delete both DynamoDB records for an article:
  //   - METADATA  (pk: ARTICLE#<slug>, sk: METADATA)
  //   - CONTENT   (pk: ARTICLE#<slug>, sk: CONTENT#<slug>)
  //
  // Both deletes run in parallel. The CONTENT record deletion is
  // best-effort — if it doesn't exist the error is silently swallowed
  // (the article may not have content yet).
  // -----------------------------------------------------------------------
  router.delete('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');

    await Promise.all([
      // Delete the primary metadata record
      docClient.send(
        new DeleteCommand({
          TableName: config.dynamoTableName,
          Key: { pk: `ARTICLE#${slug}`, sk: 'METADATA' },
          ConditionExpression: 'attribute_exists(pk)',
        }),
      ),
      // Best-effort delete the content record (may not exist for new drafts)
      docClient.send(
        new DeleteCommand({
          TableName: config.dynamoTableName,
          Key: { pk: `ARTICLE#${slug}`, sk: `CONTENT#${slug}` },
        }),
      ),
    ]);

    // Shadow delete from PG — non-fatal
    try {
        await pgDeleteArticle(getPool(config), slug);
    } catch (pgErr: unknown) {
        console.error(`[articles] PG shadow delete failed — slug=${slug}`, pgErr);
    }

    return ctx.json({ deleted: true, slug });
  });

  // -----------------------------------------------------------------------
  // POST /api/admin/articles/:slug/publish
  // Invoke the Bedrock publish Lambda pipeline asynchronously.
  // The Lambda handles MDX processing, AI enrichment, and S3 upload.
  // -----------------------------------------------------------------------
  router.post('/:slug/publish', async (ctx) => {
    const slug = ctx.req.param('slug');
    const jwtPayload = ctx.get('jwtPayload') as { sub?: string };

    const payload = JSON.stringify({
      slug,
      triggeredBy: jwtPayload?.sub ?? 'unknown',
      triggeredAt: new Date().toISOString(),
    });

    await getLambdaClient().send(
      new InvokeCommand({
        FunctionName: config.publishLambdaArn,
        InvocationType: 'Event', // async — fire and forget
        Payload: Buffer.from(payload),
      }),
    );

    return ctx.json({ queued: true, slug });
  });

  // -----------------------------------------------------------------------
  // GET /api/admin/articles/:slug/versions
  // Return the complete pipeline version history for an article slug.
  //
  // Invokes the version-history Lambda (bedrock-*-pipeline-version-history)
  // which queries DynamoDB for all VERSION#v<n> records sorted newest-first.
  //
  // Optional query param: ?limit=<n> (default 20, max 50)
  //
  // Response: 200 { success, slug, totalVersions, versions[] }
  //         | 502 { error } — Lambda execution error or invocation failure
  // -----------------------------------------------------------------------
  router.get('/:slug/versions', async (ctx) => {
    const slug = ctx.req.param('slug');
    const limitParam = ctx.req.query('limit');
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 20;

    let rawPayload: string;

    try {
      const invokeResult = await getLambdaClient().send(
        new InvokeCommand({
          FunctionName: config.versionHistoryLambdaArn,
          InvocationType: 'RequestResponse', // sync — we need the result
          Payload: Buffer.from(JSON.stringify({ slug, limit })),
        }),
      );

      rawPayload = invokeResult.Payload
        ? Buffer.from(invokeResult.Payload).toString('utf-8')
        : '{}';

      if (invokeResult.FunctionError) {
        console.error(`[articles] Version history Lambda error — slug=${slug} error=${invokeResult.FunctionError}`, rawPayload);
        return ctx.json({ error: `Version history failed: ${invokeResult.FunctionError}` }, 502);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[articles] Version history Lambda invocation failed — slug=${slug}`, err);
      return ctx.json({ error: `Version history invocation failed: ${message}` }, 502);
    }

    // Parse and proxy the Lambda response directly to the admin dashboard.
    const result = JSON.parse(rawPayload) as {
      success: boolean;
      slug: string;
      totalVersions: number;
      versions: unknown[];
      message?: string;
    };

    if (!result.success) {
      return ctx.json({ error: result.message ?? 'Version history query failed' }, 502);
    }

    return ctx.json(result, 200);
  });

  return router;
}
