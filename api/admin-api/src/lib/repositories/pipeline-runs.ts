/**
 * @format
 * Pipeline-runs repository — admin-api side.
 * Job pods update status via job-strategist/article-pipeline lib helpers;
 * admin-api INSERTs the row at trigger time and SELECTs for polling.
 */
import type { Queryable } from '../pg.js';

export interface PipelineRun {
    id:            string;
    userId:        string;
    pipelineType:  string;
    referenceId:   string | null;
    status:        string;
    errorMessage:  string | null;
    metadata:      Record<string, unknown> | null;
    createdAt?:    Date;
    updatedAt?:    Date;
}

interface PipelineRunRow {
    id:             string;
    user_id:        string;
    pipeline_type:  string;
    reference_id:   string | null;
    status:         string;
    error_message:  string | null;
    metadata:       Record<string, unknown> | null;
    created_at?:    Date;
    updated_at?:    Date;
}

function rowToRun(row: PipelineRunRow): PipelineRun {
    const run: PipelineRun = {
        id:           row.id,
        userId:       row.user_id,
        pipelineType: row.pipeline_type,
        referenceId:  row.reference_id,
        status:       row.status,
        errorMessage: row.error_message,
        metadata:     row.metadata,
    };
    if (row.created_at) run.createdAt = row.created_at;
    if (row.updated_at) run.updatedAt = row.updated_at;
    return run;
}

export async function insertPipelineRun(
    pool: Queryable,
    args: {
        id:           string;
        userId:       string;
        pipelineType: string;     // 'article' | 'strategist'
        referenceId:  string | null;
        metadata:     Record<string, unknown> | null;
    },
): Promise<void> {
    await pool.query(
        `INSERT INTO pipeline_runs (id, user_id, pipeline_type, reference_id, status, metadata)
         VALUES ($1, $2, $3, $4, 'queued', $5)`,
        [args.id, args.userId, args.pipelineType, args.referenceId, args.metadata ? JSON.stringify(args.metadata) : null],
    );
}

export async function getPipelineRun(pool: Queryable, id: string): Promise<PipelineRun | null> {
    const result = await pool.query<PipelineRunRow>(
        `SELECT id, user_id, pipeline_type, reference_id, status, error_message, metadata, created_at, updated_at
         FROM pipeline_runs WHERE id = $1`,
        [id],
    );
    return result.rows[0] ? rowToRun(result.rows[0]) : null;
}
