/**
 * @format
 * admin-api — Applications routes.
 *
 * Exposes CRUD operations for the Job Applications pipeline data stored
 * in the STRATEGIST_TABLE_NAME DynamoDB table. All routes are protected
 * by Cognito JWT middleware mounted at the parent level.
 *
 * Routes:
 *   GET  /                 — list applications (optional ?status= filter)
 *   GET  /:slug            — full application detail
 *   DELETE /:slug          — delete application + all related records
 *   POST /:slug/status     — update application status (and optionally interviewStage)
 */

import { Hono } from 'hono';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SFNClient,
  GetExecutionHistoryCommand,
  DescribeExecutionCommand,
} from '@aws-sdk/client-sfn';
import type { AdminApiConfig } from '../lib/config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type DynamoRecord = Record<string, unknown>;

/** Application status values matching the pipeline contract. */
const VALID_STATUSES = new Set([
  'analysing',
  'analysis-ready',
  'failed',
  'interview-prep',
  'applied',
  'interviewing',
  'offer-received',
  'accepted',
  'withdrawn',
  'rejected',
]);

/** Maximum items per DynamoDB BatchWriteCommand */
const BATCH_WRITE_LIMIT = 25;

// ── DynamoDB client (lazy singleton per config) ───────────────────────────────

let _docClient: DynamoDBDocumentClient | null = null;

function getDocClient(region: string): DynamoDBDocumentClient {
  if (!_docClient) {
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _docClient;
}

let _sfnClient: SFNClient | null = null;

function getSfnClient(region: string): SFNClient {
  if (!_sfnClient) {
    _sfnClient = new SFNClient({ region });
  }
  return _sfnClient;
}

// Maps Step Functions state names (CDK task IDs) → frontend stage IDs
const SFN_STATE_TO_STAGE: Record<string, string> = {
  ResearchTask: 'research',
  StrategistTask: 'strategist',
  ResumeBuilderTask: 'resume-builder',
  AnalysisPersistTask: 'persist',
  CoachLoaderTask: 'research',
  CoachTask: 'strategist',
  CoachPersistTask: 'persist',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Query application summaries from GSI1 by status.
 *
 * @param client - DynamoDB Document Client
 * @param tableName - STRATEGIST_TABLE_NAME
 * @param status - Application status to query
 * @returns Array of application summary records
 */
async function queryByStatus(
  client: DynamoDBDocumentClient,
  tableName: string,
  status: string,
): Promise<DynamoRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'gsi1-status-date',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': `APP_STATUS#${status}` },
      ScanIndexForward: false,
    }),
  );
  return result.Items ?? [];
}

/**
 * Select the most recently created record (createdAt ISO string comparison).
 *
 * @param current - Currently selected record (or null)
 * @param candidate - Candidate record to compare
 * @returns The more recent of the two records
 */
function selectLatest(current: DynamoRecord | null, candidate: DynamoRecord): DynamoRecord {
  if (!current) return candidate;
  return String(candidate['createdAt'] ?? '') > String(current['createdAt'] ?? '')
    ? candidate
    : current;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the Hono router for application management routes.
 *
 * @param config - Validated admin-api configuration
 * @returns Hono router instance
 */
export function createApplicationsRouter(config: AdminApiConfig): Hono {
  const app = new Hono();
  const TABLE = config.strategistTableName;

  // ── GET / — list applications ─────────────────────────────────────────────
  /**
   * Lists job applications, optionally filtered by status.
   * Querying `status=all` fans out across all valid status keys and merges results.
   *
   * @query status - Application status or 'all' (default: 'all')
   * @returns Array of application summaries sorted by updatedAt desc
   */
  app.get('/', async (ctx) => {
    const client = getDocClient(config.awsRegion);
    const status = ctx.req.query('status') ?? 'all';

    let items: DynamoRecord[];

    if (status === 'all') {
      const results = await Promise.all(
        [...VALID_STATUSES].map((s) => queryByStatus(client, TABLE, s)),
      );
      items = results.flat();
    } else {
      if (!VALID_STATUSES.has(status)) {
        return ctx.json({ error: `Invalid status: ${status}` }, 400);
      }
      items = await queryByStatus(client, TABLE, status);
    }

    const summaries = items
      .map((item) => ({
        slug: String(item['applicationSlug'] ?? item['slug'] ?? ''),
        targetCompany: String(item['targetCompany'] ?? ''),
        targetRole: String(item['targetRole'] ?? ''),
        status: String(item['status'] ?? 'analysing'),
        fitRating: item['fitRating'],
        recommendation: item['recommendation'],
        interviewStage: String(item['interviewStage'] ?? 'applied'),
        costUsd: item['costUsd'],
        createdAt: String(item['createdAt'] ?? ''),
        updatedAt: String(item['updatedAt'] ?? ''),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return ctx.json({ applications: summaries, count: summaries.length });
  });

  // ── GET /:slug — application detail ──────────────────────────────────────
  /**
   * Retrieves the full detail for a single application by slug.
   * Assembles METADATA + ANALYSIS# + INTERVIEW# + TAILORED_RESUME# records.
   *
   * @param slug - Application slug
   * @returns Full application detail object
   */
  app.get('/:slug', async (ctx) => {
    const client = getDocClient(config.awsRegion);
    const slug = ctx.req.param('slug');

    const result = await client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `APPLICATION#${slug}` },
      }),
    );

    const items = result.Items ?? [];

    if (items.length === 0) {
      return ctx.json({ error: `Application not found: ${slug}` }, 404);
    }

    let metadata: DynamoRecord | null = null;
    let analysis: DynamoRecord | null = null;
    let interview: DynamoRecord | null = null;
    let tailoredResume: DynamoRecord | null = null;

    for (const item of items) {
      const sk = String(item['sk'] ?? '');
      if (sk === 'METADATA') {
        metadata = item;
      } else if (sk.startsWith('ANALYSIS#')) {
        analysis = selectLatest(analysis, item);
      } else if (sk.startsWith('INTERVIEW#')) {
        interview = selectLatest(interview, item);
      } else if (sk.startsWith('TAILORED_RESUME#')) {
        tailoredResume = selectLatest(tailoredResume, item);
      }
    }

    if (!metadata) {
      return ctx.json({ error: `Metadata record not found for: ${slug}` }, 404);
    }

    const detail = {
      slug,
      targetCompany: String(metadata['targetCompany'] ?? ''),
      targetRole: String(metadata['targetRole'] ?? ''),
      status: String(metadata['status'] ?? 'analysing'),
      interviewStage: String(metadata['interviewStage'] ?? 'applied'),
      createdAt: String(metadata['createdAt'] ?? ''),
      updatedAt: String(metadata['updatedAt'] ?? ''),
      context: {
        pipelineId: String(metadata['pipelineId'] ?? ''),
        cumulativeInputTokens: Number(metadata['cumulativeInputTokens'] ?? 0),
        cumulativeOutputTokens: Number(metadata['cumulativeOutputTokens'] ?? 0),
        cumulativeThinkingTokens: Number(metadata['cumulativeThinkingTokens'] ?? 0),
        cumulativeCostUsd: Number(metadata['cumulativeCostUsd'] ?? 0),
      },
      research: analysis?.['research'] ?? null,
      analysis: analysis
        ? {
            analysisXml: String(analysis['analysisXml'] ?? ''),
            coverLetter: analysis['coverLetter'] ? String(analysis['coverLetter']) : null,
            metadata: analysis['analysisMetadata'] ?? {
              overallFitRating: 'STRETCH',
              applicationRecommendation: 'APPLY_WITH_CAVEATS',
            },
            resumeSuggestions: analysis['resumeSuggestions'] ?? {
              additions: 0,
              reframes: 0,
              eslCorrections: 0,
              summary: '',
            },
            tailoredResume: tailoredResume?.['tailoredResume'] ?? undefined,
          }
        : null,
      interviewPrep: interview?.['coaching'] ?? null,
    };

    return ctx.json({ application: detail });
  });

  // ── DELETE /:slug — delete application ────────────────────────────────────
  /**
   * Permanently deletes an application and all its related records.
   * Uses BatchWrite with chunking and unprocessed-item retry logic.
   *
   * @param slug - Application slug to delete
   * @returns Success indicator
   */
  app.delete('/:slug', async (ctx) => {
    const client = getDocClient(config.awsRegion);
    const slug = ctx.req.param('slug');

    const { Items } = await client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `APPLICATION#${slug}` },
      }),
    );

    if (!Items || Items.length === 0) {
      return ctx.json({ deleted: true, slug });
    }

    const deleteRequests = Items.map((item) => ({
      DeleteRequest: { Key: { pk: item['pk'], sk: item['sk'] } },
    }));

    for (let i = 0; i < deleteRequests.length; i += BATCH_WRITE_LIMIT) {
      const batch = deleteRequests.slice(i, i + BATCH_WRITE_LIMIT);
      let unprocessed: typeof batch | undefined = batch;
      let retries = 0;

      while (unprocessed && unprocessed.length > 0 && retries <= 3) {
        const batchResult = await client.send(
          new BatchWriteCommand({ RequestItems: { [TABLE]: unprocessed } }),
        );
        unprocessed = batchResult.UnprocessedItems?.[TABLE] as typeof batch | undefined;
        if (unprocessed && unprocessed.length > 0) {
          retries++;
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, retries - 1)));
        }
      }
    }

    return ctx.json({ deleted: true, slug });
  });

  // ── POST /:slug/status — update status ────────────────────────────────────
  /**
   * Updates the status (and optionally interview stage) of an application.
   * Syncs the `gsi1pk` / `gsi1sk` attributes so list queries stay consistent.
   *
   * @param slug - Application slug
   * @body status - New status value
   * @body interviewStage - Optional new interview stage
   * @returns Success indicator with the applied status
   */
  app.post('/:slug/status', async (ctx) => {
    const client = getDocClient(config.awsRegion);
    const slug = ctx.req.param('slug');

    const body = await ctx.req.json<{ status?: string; interviewStage?: string }>();
    const { status, interviewStage } = body;

    if (!status || !VALID_STATUSES.has(status)) {
      return ctx.json({ error: `Invalid or missing status: ${status ?? '(none)'}` }, 400);
    }

    const now = new Date().toISOString();
    const datePrefix = now.slice(0, 10);

    const updateParts = [
      '#st = :status',
      'updatedAt = :now',
      'gsi1pk = :gsi1pk',
      'gsi1sk = :gsi1sk',
    ];
    const expressionValues: Record<string, unknown> = {
      ':status': status,
      ':now': now,
      ':gsi1pk': `APP_STATUS#${status}`,
      ':gsi1sk': `${datePrefix}#${slug}`,
    };

    if (interviewStage) {
      updateParts.push('interviewStage = :stage');
      expressionValues[':stage'] = interviewStage;
    }

    await client.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `APPLICATION#${slug}`, sk: 'METADATA' },
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames: { '#st': 'status' },
        ReturnValues: 'NONE',
      }),
    );

    return ctx.json({ success: true, status });
  });

  // ── GET /:slug/execution — real-time Step Functions stage ─────────────────
  /**
   * Returns the current Step Functions execution state for an in-flight pipeline.
   *
   * Standard workflows don't expose currentState via DescribeExecution, so we
   * call GetExecutionHistory(reverseOrder=true, maxResults=20) and find the most
   * recent stateEnteredEventDetails to determine which Lambda is running.
   *
   * The executionArn is stored in DynamoDB by the trigger-handler at pipeline start.
   *
   * @param slug - Application slug
   * @returns { sfnStatus, stageId, currentStateName, startDate, elapsedMs }
   */
  app.get('/:slug/execution', async (ctx) => {
    const client = getDocClient(config.awsRegion);
    const sfn = getSfnClient(config.awsRegion);
    const slug = ctx.req.param('slug');

    // 1. Read executionArn from DynamoDB
    const record = await client.send(new GetCommand({
      TableName: TABLE,
      Key: { pk: `APPLICATION#${slug}`, sk: 'METADATA' },
      ProjectionExpression: 'executionArn, #st, startedAt',
      ExpressionAttributeNames: { '#st': 'status' },
    }));

    if (!record.Item) {
      return ctx.json({ error: 'Application not found' }, 404);
    }

    const executionArn = record.Item['executionArn'] as string | undefined;
    const dbStatus = record.Item['status'] as string | undefined;
    const startedAt = record.Item['startedAt'] as string | undefined;

    if (!executionArn) {
      // Execution ARN not yet stored (old record pre-feature) — return db status only
      return ctx.json({
        sfnStatus: dbStatus === 'analysing' ? 'RUNNING' : 'UNKNOWN',
        stageId: null,
        currentStateName: null,
        startDate: startedAt ?? null,
        elapsedMs: startedAt ? Date.now() - new Date(startedAt).getTime() : null,
      });
    }

    // 2. Describe execution for top-level status + timing
    const describe = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    const sfnStatus = describe.status ?? 'UNKNOWN';
    const startDate = describe.startDate?.toISOString() ?? startedAt ?? null;
    const elapsedMs = describe.startDate
      ? (describe.stopDate ?? new Date()).getTime() - describe.startDate.getTime()
      : null;

    if (sfnStatus !== 'RUNNING') {
      // Terminal — no need to query history for current state
      return ctx.json({ sfnStatus, stageId: null, currentStateName: null, startDate, elapsedMs });
    }

    // 3. GetExecutionHistory (reverse) — find the most recent state entered
    const history = await sfn.send(new GetExecutionHistoryCommand({
      executionArn,
      reverseOrder: true,
      maxResults: 20,
    }));

    let currentStateName: string | null = null;
    for (const event of history.events ?? []) {
      if (event.stateEnteredEventDetails?.name) {
        currentStateName = event.stateEnteredEventDetails.name;
        break;
      }
    }

    const stageId = currentStateName ? (SFN_STATE_TO_STAGE[currentStateName] ?? null) : null;

    return ctx.json({ sfnStatus, stageId, currentStateName, startDate, elapsedMs });
  });

  return app;
}
