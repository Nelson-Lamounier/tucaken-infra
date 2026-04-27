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

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { JWTPayload } from 'jose';
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
import { getBatchApi } from '../lib/k8s.js';
import { buildPipelineJob, sanitizeLabel } from '../lib/k8s-job-builder.js';
import { getPool } from '../lib/pg.js';
import { insertPipelineRun } from '../lib/repositories/pipeline-runs.js';
import {
  listApplications,
  updateApplicationStatus as pgUpdateStatus,
  deleteApplication as pgDeleteApplication,
} from '../lib/repositories/applications.js';

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
type AdminApiBindings = {
  Variables: { jwtPayload: JWTPayload };
};

export function createApplicationsRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const app = new Hono<AdminApiBindings>();
  const TABLE = config.strategistTableName;

  // ── GET / — list applications ─────────────────────────────────────────────
  /**
   * Lists job applications, optionally filtered by status.
   *
   * @query status - Application kanban status (optional; omit for all)
   * @returns Array of application records sorted by createdAt desc
   */
  app.get('/', async (ctx) => {
    const rawStatus = ctx.req.query('status');
    const apps = await listApplications(getPool(config), rawStatus ?? undefined);
    const summaries = apps.map((a) => ({
        slug:           a.id,
        targetCompany:  a.company,
        targetRole:     a.role,
        status:         a.kanbanStatus,
        jobUrl:         a.jobUrl ?? null,
        fitRating:      null,
        recommendation: null,
        interviewStage: 'applied',
        costUsd:        null,
        appliedAt:      a.appliedAt ?? null,
        createdAt:      a.createdAt ?? null,
        updatedAt:      a.updatedAt ?? null,
    }));
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
    let latestAnalysis: DynamoRecord | null = null;
    let latestInterview: DynamoRecord | null = null;
    let latestResume: DynamoRecord | null = null;

    // Collect versioned records for history
    const analysisHistory: DynamoRecord[] = [];
    const tailoredResumeMap = new Map<string, DynamoRecord>(); // sk → item

    for (const item of items) {
      const sk = String(item['sk'] ?? '');
      if (sk === 'METADATA') {
        metadata = item;
      } else if (sk.startsWith('ANALYSIS#')) {
        latestAnalysis = selectLatest(latestAnalysis, item);
        analysisHistory.push(item);
      } else if (sk.startsWith('INTERVIEW#')) {
        latestInterview = selectLatest(latestInterview, item);
      } else if (sk.startsWith('TAILORED_RESUME#')) {
        latestResume = selectLatest(latestResume, item);
        tailoredResumeMap.set(sk, item);
      }
    }

    if (!metadata) {
      return ctx.json({ error: `Metadata record not found for: ${slug}` }, 404);
    }

    // Prefer explicit version pointers written by pipeline handlers.
    // latestPipelineId → set by analysis-persist-handler on successful completion.
    // latestResumeId   → set by resume-builder-handler on successful persistence.
    // Falls back to selectLatest for records that predate the pointer fields.
    const latestPipelineId = String(metadata['latestPipelineId'] ?? '');
    const latestResumeId = String(metadata['latestResumeId'] ?? '');

    if (latestPipelineId) {
      const pointed = analysisHistory.find((i) => String(i['sk']) === `ANALYSIS#${latestPipelineId}`);
      if (pointed) latestAnalysis = pointed;
    }
    if (latestResumeId) {
      const pointed = tailoredResumeMap.get(latestResumeId);
      if (pointed) latestResume = pointed;
    }

    // Build analysis version history for the UI (newest first, metadata only).
    const versions = analysisHistory
      .map((a) => ({
        pipelineId: String(a['sk']).replace('ANALYSIS#', ''),
        createdAt: String(a['createdAt'] ?? ''),
        fitRating: (a['analysisMetadata'] as DynamoRecord | undefined)?.['overallFitRating'] ?? null,
        hasResume: tailoredResumeMap.has(String(a['sk']).replace('ANALYSIS#', 'TAILORED_RESUME#')),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const detail = {
      slug,
      targetCompany: String(metadata['targetCompany'] ?? ''),
      targetRole: String(metadata['targetRole'] ?? ''),
      status: String(metadata['status'] ?? 'analysing'),
      interviewStage: String(metadata['interviewStage'] ?? 'applied'),
      createdAt: String(metadata['createdAt'] ?? ''),
      updatedAt: String(metadata['updatedAt'] ?? ''),
      // analysisCount tracks how many times this role has been re-analysed.
      // Incremented atomically by trigger-handler on each new pipeline run.
      analysisCount: Number(metadata['analysisCount'] ?? 1),
      versions,
      context: {
        pipelineId: String(metadata['pipelineId'] ?? ''),
        cumulativeInputTokens: Number(metadata['cumulativeInputTokens'] ?? 0),
        cumulativeOutputTokens: Number(metadata['cumulativeOutputTokens'] ?? 0),
        cumulativeThinkingTokens: Number(metadata['cumulativeThinkingTokens'] ?? 0),
        cumulativeCostUsd: Number(metadata['cumulativeCostUsd'] ?? 0),
      },
      research: latestAnalysis?.['research'] ?? null,
      analysis: latestAnalysis
        ? {
            analysisXml: String(latestAnalysis['analysisXml'] ?? ''),
            coverLetter: latestAnalysis['coverLetter'] ? String(latestAnalysis['coverLetter']) : null,
            metadata: latestAnalysis['analysisMetadata'] ?? {
              overallFitRating: 'STRETCH',
              applicationRecommendation: 'APPLY_WITH_CAVEATS',
            },
            resumeSuggestions: latestAnalysis['resumeSuggestions'] ?? {
              additions: 0,
              reframes: 0,
              eslCorrections: 0,
              summary: '',
            },
            tailoredResume: latestResume?.['tailoredResume'] ?? undefined,
          }
        : null,
      interviewPrep: latestInterview?.['coaching'] ?? null,
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
      try {
        await pgDeleteApplication(getPool(config), slug);
      } catch (pgErr) {
        console.error('[applications] PG shadow delete failed (early exit)', pgErr);
      }
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

    try {
      await pgDeleteApplication(getPool(config), slug);
    } catch (pgErr) {
      console.error('[applications] PG shadow delete failed', pgErr);
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

    try {
      await pgUpdateStatus(getPool(config), slug, status);
    } catch (pgErr) {
      console.error('[applications] PG shadow status update failed', pgErr);
    }

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

  // ── POST /:slug/coach — schedule the coach K8s Job ───────────────────────
  /**
   * Phase 4 Task 5: synchronous Job + polling, mirroring the article and
   * strategist K8s Job patterns. Inserts a pipeline_runs row (type='coach')
   * and creates a Job in the `job-strategist` namespace which runs the
   * Coach entrypoint (dist/run-coach.js).
   *
   * The admin polls GET /:slug/coaching/:stage to detect completion.
   */
  app.post('/:slug/coach', async (ctx) => {
    const slug = ctx.req.param('slug');
    const jwtPayload = ctx.get('jwtPayload');
    const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
    if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);

    let body: {
      strategistPipelineRunId?: string;
      interviewStage?:          string;
      applicationId?:           string;
      targetCompany?:           string;
      targetRole?:              string;
      jobDescription?:          string;
      mode?:                    string;
    };
    try { body = await ctx.req.json(); }
    catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

    const f = {
      strategistPipelineRunId: body.strategistPipelineRunId?.trim(),
      interviewStage:          body.interviewStage?.trim(),
      applicationId:           body.applicationId?.trim(),
      targetCompany:           body.targetCompany?.trim(),
      targetRole:              body.targetRole?.trim(),
      jobDescription:          body.jobDescription?.trim(),
    };
    for (const [k, v] of Object.entries(f)) {
      if (!v) return ctx.json({ error: `"${k}" is required` }, 400);
    }
    const mode = body.mode?.trim() || 'standard';

    const coachPipelineRunId = randomUUID();
    try {
      await insertPipelineRun(getPool(config), {
        id:           coachPipelineRunId,
        userId,
        pipelineType: 'coach',
        referenceId:  f.applicationId!,
        metadata: {
          applicationSlug:         slug,
          interviewStage:          f.interviewStage,
          strategistPipelineRunId: f.strategistPipelineRunId,
        },
      });
    } catch (err: unknown) {
      console.error('[applications/coach] failed to insert pipeline_run', err);
      return ctx.json({ error: 'Failed to record pipeline run' }, 500);
    }

    const job = buildPipelineJob({
      namespace:          config.strategistPipelineNamespace,
      image:              config.strategistPipelineImage,
      serviceAccountName: config.strategistPipelineServiceAccount,
      nameStem:           `coach-${sanitizeLabel(slug)}-${sanitizeLabel(f.interviewStage!)}`,
      suffixInput:        `${coachPipelineRunId}:${f.applicationId}:${f.interviewStage}:${Date.now()}`,
      labels: {
        app:    'coach-pipeline',
        userId,
        slug:   sanitizeLabel(slug),
        stage:  sanitizeLabel(f.interviewStage!),
      },
      command: ['node', 'dist/run-coach.js'],
      env: [
        { name: 'COACH_PIPELINE_RUN_ID',      value: coachPipelineRunId },
        { name: 'STRATEGIST_PIPELINE_RUN_ID', value: f.strategistPipelineRunId! },
        { name: 'APPLICATION_ID',             value: f.applicationId! },
        { name: 'APPLICATION_SLUG',           value: slug },
        { name: 'USER_ID',                    value: userId },
        { name: 'TARGET_COMPANY',             value: f.targetCompany! },
        { name: 'TARGET_ROLE',                value: f.targetRole! },
        { name: 'JOB_DESCRIPTION',            value: f.jobDescription! },
        { name: 'INTERVIEW_STAGE',            value: f.interviewStage! },
        { name: 'MODE',                       value: mode },
      ],
      envFromSecretRefs: ['platform-rds-credentials'],
    });

    try { await getBatchApi().createNamespacedJob(config.strategistPipelineNamespace, job); }
    catch (err: unknown) {
      console.error('[applications/coach] failed to create K8s Job', err);
      return ctx.json({ error: 'Failed to schedule coach Job' }, 502);
    }

    return ctx.json({
      status:             'queued',
      coachPipelineRunId,
      jobName:            job.metadata!.name!,
      applicationId:      f.applicationId,
      interviewStage:     f.interviewStage,
    }, 202);
  });

  // ── GET /:slug/coaching/:stage — read coaching_content row ────────────────
  /**
   * Returns the coaching content row for an application + stage. The admin
   * passes applicationId via query param to avoid a slug→id lookup
   * (job_applications has no slug column today).
   *
   * Returns 404 while the Job is still running; the admin polls until 200.
   */
  app.get('/:slug/coaching/:stage', async (ctx) => {
    const stage = ctx.req.param('stage');

    const applicationId = ctx.req.query('applicationId');
    if (!applicationId) {
      return ctx.json({ error: 'applicationId query param required' }, 400);
    }

    const pool = getPool(config);
    const result = await pool.query<{
      topics_to_study:     unknown;
      expected_questions:  unknown;
      personal_highlights: unknown;
      generated_at:        Date;
    }>(
      `SELECT topics_to_study, expected_questions, personal_highlights, generated_at
       FROM coaching_content WHERE job_application_id = $1 AND stage_type = $2`,
      [applicationId, stage],
    );
    if (result.rows.length === 0) {
      return ctx.json({ error: 'Coaching content not yet ready' }, 404);
    }

    const row = result.rows[0]!;
    return ctx.json({
      applicationId,
      stage,
      coaching:           row.topics_to_study,
      questions:          row.expected_questions,
      personalHighlights: row.personal_highlights,
      generatedAt:        row.generated_at,
    });
  });

  return app;
}
