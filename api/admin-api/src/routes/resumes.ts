/**
 * @format
 * admin-api — Resume management routes.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   GET    /api/admin/resumes              — List all resume summaries
 *   GET    /api/admin/resumes/active       — Get the currently active resume (with data)
 *   GET    /api/admin/resumes/:id          — Get a single resume by ID (with data)
 *   POST   /api/admin/resumes              — Create a new resume
 *   PUT    /api/admin/resumes/:id          — Update label and/or data
 *   DELETE /api/admin/resumes/:id          — Delete (guards against deleting the active one)
 *   POST   /api/admin/resumes/:id/activate — Set a resume as the publicly displayed one
 *
 * DynamoDB access pattern:
 *   Resumes live in the **Strategist table** (STRATEGIST_TABLE_NAME), NOT the articles table.
 *   This matches the migration note in the shared `dynamodb-resumes.ts` lib (2026-03).
 *
 *   Key schema:
 *     pk: RESUME#<uuid>     sk: METADATA
 *     gsi1pk: RESUME        gsi1sk: RESUME#<createdAt>    → lists all resumes (GSI1)
 *     entityType: RESUME
 *     isActive: boolean     → only one should be true at a time
 *
 *   Active resume lookup:
 *     Scan with FilterExpression: entityType=RESUME AND isActive=true AND sk=METADATA
 *     (Small table — scan is acceptable; typically < 20 resumes)
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { JWTPayload } from 'jose';
import type { AdminApiConfig } from '../lib/config.js';
import { docClient } from '../lib/dynamo.js';
import { getPool } from '../lib/pg.js';
import {
  upsertResume,
  getResume as pgGetResume,
  deleteResume as pgDeleteResume,
  setActiveResume,
} from '../lib/repositories/resumes.js';

/** Hono context variable bindings for authenticated routes. */
type AdminApiBindings = {
  Variables: {
    jwtPayload: JWTPayload;
  };
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Resume entity as stored in DynamoDB. */
interface ResumeEntity {
  pk: string;
  sk: 'METADATA';
  gsi1pk: 'RESUME';
  gsi1sk: string;
  entityType: 'RESUME';
  resumeId: string;
  label: string;
  isActive: boolean;
  /** Full resume JSON blob — stored as a DynamoDB Map. */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Summary shape returned to the client for list operations. */
interface ResumeSummary {
  resumeId: string;
  label: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Full resume with content data. */
interface ResumeWithData extends ResumeSummary {
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw DynamoDB item to a client-facing summary (strip DynamoDB keys).
 *
 * @param entity - Raw DynamoDB item cast to ResumeEntity
 * @returns Summary without internal DynamoDB partition/sort keys
 */
function toSummary(entity: ResumeEntity): ResumeSummary {
  return {
    resumeId: entity.resumeId,
    label: entity.label,
    isActive: entity.isActive ?? false,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

/**
 * Map a raw DynamoDB item to the full shape including data.
 *
 * @param entity - Raw DynamoDB item cast to ResumeEntity
 * @returns Full resume with data
 */
function toFull(entity: ResumeEntity): ResumeWithData {
  return { ...toSummary(entity), data: entity.data ?? {} };
}

/**
 * Fetch all resume summaries from DynamoDB.
 * Tries GSI1 (gsi1pk = 'RESUME') first; falls back to Scan if GSI is unavailable.
 *
 * @param config - Resolved application configuration
 * @returns Array of resume summaries sorted newest-first
 */
async function listAll(config: AdminApiConfig): Promise<ResumeSummary[]> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: config.resumesTableName,
        IndexName: config.dynamoGsi1Name,
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': 'RESUME' },
        ScanIndexForward: false, // newest first via gsi1sk sort
      }),
    );
    if (result.Items && result.Items.length > 0) {
      return result.Items.map((i) => toSummary(i as ResumeEntity));
    }
  } catch {
    console.warn('[admin-api/resumes] GSI1 unavailable, falling back to Scan');
  }

  // Fallback: Scan filtered by entity type
  const scan = await docClient.send(
    new ScanCommand({
      TableName: config.resumesTableName,
      FilterExpression: 'entityType = :type AND sk = :sk',
      ExpressionAttributeValues: { ':type': 'RESUME', ':sk': 'METADATA' },
    }),
  );

  return (scan.Items ?? [])
    .map((i) => toSummary(i as ResumeEntity))
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
}

/**
 * Look up the currently active resume (isActive = true).
 * Uses a Scan — acceptable for small tables (< 20 items).
 *
 * @param config - Resolved application configuration
 * @returns Full resume with data, or null if none is active
 */
async function findActive(config: AdminApiConfig): Promise<ResumeWithData | null> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: config.resumesTableName,
      FilterExpression: 'entityType = :type AND isActive = :active AND sk = :sk',
      ExpressionAttributeValues: {
        ':type': 'RESUME',
        ':active': true,
        ':sk': 'METADATA',
      },
    }),
  );
  if (!result.Items || result.Items.length === 0) return null;
  return toFull(result.Items[0] as ResumeEntity);
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the resumes admin router.
 *
 * @param config - Resolved application configuration
 * @returns Hono router with full resume CRUD + activation routes
 */
export function createResumesRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes
  // List all resume summaries (no data payload to keep response lean).
  // -------------------------------------------------------------------------
  router.get('/', async (ctx) => {
    const resumes = await listAll(config);
    return ctx.json({ resumes, count: resumes.length });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes/active
  // Return the currently active resume (with full data).
  // Must be defined BEFORE /:id to take route precedence.
  // -------------------------------------------------------------------------
  router.get('/active', async (ctx) => {
    const resume = await findActive(config);
    if (!resume) {
      return ctx.json({ error: 'No active resume configured' }, 404);
    }
    return ctx.json({ resume });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes/:id
  // Fetch a single resume by UUID with full data.
  // -------------------------------------------------------------------------
  router.get('/:id', async (ctx) => {
    const id = ctx.req.param('id');

    const result = await docClient.send(
      new GetCommand({
        TableName: config.resumesTableName,
        Key: { pk: `RESUME#${id}`, sk: 'METADATA' },
      }),
    );

    if (!result.Item) {
      return ctx.json({ error: `Resume not found: ${id}` }, 404);
    }

    return ctx.json({ resume: toFull(result.Item as ResumeEntity) });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/resumes
  // Create a new resume.
  //
  // Request body: { label: string, data: Record<string, unknown> }
  // Response:     { resume: ResumeWithData }
  // -------------------------------------------------------------------------
  router.post('/', async (ctx) => {
    const body = await ctx.req.json<{ label?: string; data?: Record<string, unknown> }>();

    if (!body.label || typeof body.label !== 'string' || body.label.trim().length === 0) {
      return ctx.json({ error: '"label" is required and must be a non-empty string' }, 400);
    }

    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return ctx.json({ error: '"data" is required and must be an object' }, 400);
    }

    const resumeId = randomUUID();
    const now = new Date().toISOString();

    const entity: ResumeEntity = {
      pk: `RESUME#${resumeId}`,
      sk: 'METADATA',
      gsi1pk: 'RESUME',
      gsi1sk: `RESUME#${now}`,
      entityType: 'RESUME',
      resumeId,
      label: body.label.trim(),
      isActive: false,
      data: body.data,
      createdAt: now,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({
        TableName: config.resumesTableName,
        Item: entity,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );

    try {
      await upsertResume(getPool(config), {
        id:               entity.resumeId,
        userId:           null,
        jobApplicationId: null,
        label:            entity.label,
        isActive:         entity.isActive,
        contentJson:      entity.data,
        renderedHtml:     null,
      });
    } catch (pgErr) {
      console.error('[resumes] PG shadow write failed', pgErr);
    }

    return ctx.json({ resume: toFull(entity) }, 201);
  });

  // -------------------------------------------------------------------------
  // PUT /api/admin/resumes/:id
  // Update label and/or data for an existing resume.
  //
  // Request body: { label?: string, data?: Record<string, unknown> }
  // -------------------------------------------------------------------------
  router.put('/:id', async (ctx) => {
    const id = ctx.req.param('id');
    const body = await ctx.req.json<{ label?: string; data?: Record<string, unknown> }>();

    if (!body.label && !body.data) {
      return ctx.json({ error: 'At least one of "label" or "data" must be provided' }, 400);
    }

    const expressionParts: string[] = ['updatedAt = :updatedAt'];
    const exprAttrNames: Record<string, string> = {};
    const exprAttrValues: Record<string, unknown> = {
      ':updatedAt': new Date().toISOString(),
    };

    if (body.label) {
      exprAttrNames['#label'] = 'label';
      exprAttrValues[':label'] = body.label.trim();
      expressionParts.push('#label = :label');
    }

    if (body.data) {
      exprAttrNames['#data'] = 'data';
      exprAttrValues[':data'] = body.data;
      expressionParts.push('#data = :data');
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: config.resumesTableName,
        Key: { pk: `RESUME#${id}`, sk: 'METADATA' },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: Object.keys(exprAttrNames).length > 0 ? exprAttrNames : undefined,
        ExpressionAttributeValues: exprAttrValues,
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      return ctx.json({ error: `Resume not found: ${id}` }, 404);
    }

    try {
      const existingPg = await pgGetResume(getPool(config), id);
      if (existingPg) {
        await upsertResume(getPool(config), {
          ...existingPg,
          label:       body.label?.trim() ?? existingPg.label,
          contentJson: body.data ?? existingPg.contentJson,
        });
      }
    } catch (pgErr) {
      console.error('[resumes] PG shadow update failed', pgErr);
    }

    return ctx.json({ resume: toFull(result.Attributes as ResumeEntity) });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/admin/resumes/:id
  // Delete a resume. Guards against deleting the active one.
  // -------------------------------------------------------------------------
  router.delete('/:id', async (ctx) => {
    const id = ctx.req.param('id');

    // Fetch the item first to check isActive
    const existing = await docClient.send(
      new GetCommand({
        TableName: config.resumesTableName,
        Key: { pk: `RESUME#${id}`, sk: 'METADATA' },
      }),
    );

    if (!existing.Item) {
      return ctx.json({ error: `Resume not found: ${id}` }, 404);
    }

    if ((existing.Item as ResumeEntity).isActive) {
      return ctx.json(
        { error: 'Cannot delete the active resume. Activate another resume first.' },
        409,
      );
    }

    await docClient.send(
      new DeleteCommand({
        TableName: config.resumesTableName,
        Key: { pk: `RESUME#${id}`, sk: 'METADATA' },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );

    try {
      await pgDeleteResume(getPool(config), id);
    } catch (pgErr) {
      console.error('[resumes] PG shadow delete failed', pgErr);
    }

    return ctx.json({ deleted: true, resumeId: id });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/resumes/:id/activate
  // Set a resume as the publicly displayed one.
  //
  // Deactivates the current active resume (if different) then activates
  // the target. Both writes are sequential — DynamoDB does not support
  // multi-item transactions across non-transaction API calls cheaply enough
  // for this use case (resume changes are rare).
  //
  // Response: { resume: ResumeWithData }
  // -------------------------------------------------------------------------
  router.post('/:id/activate', async (ctx) => {
    const id = ctx.req.param('id');
    const now = new Date().toISOString();

    // Step 1: Deactivate the currently active resume (if different)
    const currentActive = await findActive(config);
    if (currentActive && currentActive.resumeId !== id) {
      await docClient.send(
        new UpdateCommand({
          TableName: config.resumesTableName,
          Key: { pk: `RESUME#${currentActive.resumeId}`, sk: 'METADATA' },
          UpdateExpression: 'SET isActive = :inactive, updatedAt = :now',
          ExpressionAttributeValues: { ':inactive': false, ':now': now },
        }),
      );
    }

    // Step 2: Activate the target resume
    const result = await docClient.send(
      new UpdateCommand({
        TableName: config.resumesTableName,
        Key: { pk: `RESUME#${id}`, sk: 'METADATA' },
        UpdateExpression: 'SET isActive = :active, updatedAt = :now',
        ExpressionAttributeValues: { ':active': true, ':now': now },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      return ctx.json({ error: `Resume not found: ${id}` }, 404);
    }

    try {
      await setActiveResume(
        getPool(config),
        currentActive?.resumeId ?? null,
        id,
      );
    } catch (pgErr) {
      console.error('[resumes] PG shadow activate failed', pgErr);
    }

    return ctx.json({ resume: toFull(result.Attributes as ResumeEntity) });
  });

  return router;
}
