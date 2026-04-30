/**
 * @format
 * CareerHistory repository — typed pg queries for resume_imports and
 * user_career_history tables (migration 009).
 *
 * Separation of concerns:
 *   resume_imports      — import job state machine (admin-api reads/writes)
 *   user_career_history — extracted career entries (admin-api reads; K8s Job writes)
 *
 * The K8s Job (resume-import-processor) writes directly to both tables using
 * the platform-rds-credentials Secret — it does not go through this layer.
 * This repository is the admin-api read/control path only.
 */
import type { Pool } from 'pg';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ImportStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'parsing'
  | 'extracting_career'
  | 'ready_for_review'
  | 'enriching'
  | 'completed'
  | 'failed';

export interface ResumeImport {
  id:                    string;
  userId:                string;
  s3Key:                 string;
  originalFilename:      string;
  contentType:           string;
  fileSizeBytes:         number;
  status:                ImportStatus;
  statusMessage:         string | null;
  currentStep:           string | null;
  totalSteps:            number | null;
  careerEntriesCreated:  string[];
  embeddingsCreatedCount: number;
  errorCode:             string | null;
  errorDetails:          Record<string, unknown> | null;
  retryCount:            number;
  createdAt:             Date;
  startedAt:             Date | null;
  completedAt:           Date | null;
}

export type CareerEntryType =
  | 'experience'
  | 'education'
  | 'skill'
  | 'certification'
  | 'project'
  | 'achievement';

export type EnrichmentStatus = 'pending' | 'enriching' | 'complete' | 'skipped' | 'failed';

export interface CareerEntry {
  id:                       string;
  userId:                   string;
  importId:                 string | null;
  entryType:                CareerEntryType;
  rawData:                  Record<string, unknown>;
  enrichedData:             Record<string, unknown> | null;
  enrichmentStatus:         EnrichmentStatus;
  enrichmentSkippedReason:  string | null;
  displayOrder:             number;
  createdAt:                Date;
  updatedAt:                Date;
}

// ─── resume_imports ───────────────────────────────────────────────────────────

const IMPORT_COLS = `
  id, user_id, s3_key, original_filename, content_type, file_size_bytes,
  status, status_message, current_step, total_steps,
  career_entries_created, embeddings_created_count,
  error_code, error_details, retry_count,
  created_at, started_at, completed_at
`;

function rowToImport(row: Record<string, unknown>): ResumeImport {
  return {
    id:                    row['id'] as string,
    userId:                row['user_id'] as string,
    s3Key:                 row['s3_key'] as string,
    originalFilename:      row['original_filename'] as string,
    contentType:           row['content_type'] as string,
    fileSizeBytes:         row['file_size_bytes'] as number,
    status:                row['status'] as ImportStatus,
    statusMessage:         (row['status_message'] as string | null) ?? null,
    currentStep:           (row['current_step'] as string | null) ?? null,
    totalSteps:            (row['total_steps'] as number | null) ?? null,
    careerEntriesCreated:  (row['career_entries_created'] as string[]) ?? [],
    embeddingsCreatedCount: row['embeddings_created_count'] as number,
    errorCode:             (row['error_code'] as string | null) ?? null,
    errorDetails:          (row['error_details'] as Record<string, unknown> | null) ?? null,
    retryCount:            row['retry_count'] as number,
    createdAt:             row['created_at'] as Date,
    startedAt:             (row['started_at'] as Date | null) ?? null,
    completedAt:           (row['completed_at'] as Date | null) ?? null,
  };
}

/**
 * Creates a new resume_import row in 'awaiting_upload' state.
 * Called when the admin-api issues the presigned URL — the record exists
 * before the file reaches S3 so we can attach the import ID to the URL path.
 */
export async function createResumeImport(
  pool: Pool,
  params: {
    userId:           string;
    s3Key:            string;
    originalFilename: string;
    contentType:      string;
    fileSizeBytes:    number;
  },
): Promise<ResumeImport> {
  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO resume_imports
           (user_id, s3_key, original_filename, content_type, file_size_bytes, status)
     VALUES ($1::uuid, $2, $3, $4, $5, 'awaiting_upload')
     RETURNING ${IMPORT_COLS}`,
    [params.userId, params.s3Key, params.originalFilename, params.contentType, params.fileSizeBytes],
  );
  const row = result.rows[0];
  if (!row) throw new Error('createResumeImport: INSERT returned no row');
  return rowToImport(row);
}

/**
 * Transitions a resume_import from 'awaiting_upload' → 'queued'.
 * Called after the frontend confirms the S3 PUT succeeded.
 * Returns null if the record doesn't belong to this user (ownership check).
 */
export async function markUploadComplete(
  pool: Pool,
  importId: string,
  userId: string,
): Promise<ResumeImport | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE resume_imports
        SET status = 'queued', started_at = NOW()
      WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'awaiting_upload'
      RETURNING ${IMPORT_COLS}`,
    [importId, userId],
  );
  return result.rows[0] ? rowToImport(result.rows[0]) : null;
}

/**
 * Fetch a single resume_import by ID, scoped to the authenticated user.
 */
export async function getResumeImport(
  pool: Pool,
  importId: string,
  userId: string,
): Promise<ResumeImport | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${IMPORT_COLS} FROM resume_imports
      WHERE id = $1::uuid AND user_id = $2::uuid`,
    [importId, userId],
  );
  return result.rows[0] ? rowToImport(result.rows[0]) : null;
}

/**
 * List all resume_imports for a user, newest first. Capped at 20 rows.
 */
export async function listResumeImports(
  pool: Pool,
  userId: string,
): Promise<ResumeImport[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${IMPORT_COLS} FROM resume_imports
      WHERE user_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT 20`,
    [userId],
  );
  return result.rows.map(rowToImport);
}

/**
 * Count resume imports for this user in the current calendar month.
 * Used to enforce the free-tier quota (1 import/month).
 */
export async function countImportsThisMonth(
  pool: Pool,
  userId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM resume_imports
      WHERE user_id = $1::uuid
        AND created_at >= DATE_TRUNC('month', NOW())
        AND status != 'failed'`,
    [userId],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

// ─── user_career_history ──────────────────────────────────────────────────────

const ENTRY_COLS = `
  id, user_id, import_id, entry_type,
  raw_data, enriched_data,
  enrichment_status, enrichment_skipped_reason,
  display_order, created_at, updated_at
`;

function rowToEntry(row: Record<string, unknown>): CareerEntry {
  return {
    id:                      row['id'] as string,
    userId:                  row['user_id'] as string,
    importId:                (row['import_id'] as string | null) ?? null,
    entryType:               row['entry_type'] as CareerEntryType,
    rawData:                 row['raw_data'] as Record<string, unknown>,
    enrichedData:            (row['enriched_data'] as Record<string, unknown> | null) ?? null,
    enrichmentStatus:        row['enrichment_status'] as EnrichmentStatus,
    enrichmentSkippedReason: (row['enrichment_skipped_reason'] as string | null) ?? null,
    displayOrder:            row['display_order'] as number,
    createdAt:               row['created_at'] as Date,
    updatedAt:               row['updated_at'] as Date,
  };
}

/**
 * List all career history entries for a user, grouped by entry_type then
 * display_order. Used to render the profile review screen after import.
 */
export async function listCareerEntries(
  pool: Pool,
  userId: string,
  entryType?: CareerEntryType,
): Promise<CareerEntry[]> {
  if (entryType) {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${ENTRY_COLS} FROM user_career_history
        WHERE user_id = $1::uuid AND entry_type = $2
        ORDER BY display_order, created_at`,
      [userId, entryType],
    );
    return result.rows.map(rowToEntry);
  }

  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${ENTRY_COLS} FROM user_career_history
      WHERE user_id = $1::uuid
      ORDER BY entry_type, display_order, created_at`,
    [userId],
  );
  return result.rows.map(rowToEntry);
}

/**
 * Fetch a single career entry by ID, scoped to the authenticated user.
 */
export async function getCareerEntry(
  pool: Pool,
  entryId: string,
  userId: string,
): Promise<CareerEntry | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${ENTRY_COLS} FROM user_career_history
      WHERE id = $1::uuid AND user_id = $2::uuid`,
    [entryId, userId],
  );
  return result.rows[0] ? rowToEntry(result.rows[0]) : null;
}

/**
 * Update the raw_data for a career entry (user editing extracted data).
 */
export async function updateCareerEntry(
  pool: Pool,
  entryId: string,
  userId: string,
  rawData: Record<string, unknown>,
): Promise<CareerEntry | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE user_career_history
        SET raw_data   = $1,
            updated_at = NOW()
      WHERE id = $2::uuid AND user_id = $3::uuid
      RETURNING ${ENTRY_COLS}`,
    [JSON.stringify(rawData), entryId, userId],
  );
  return result.rows[0] ? rowToEntry(result.rows[0]) : null;
}

/**
 * Delete a career entry and all its experience_embeddings (via CASCADE).
 */
export async function deleteCareerEntry(
  pool: Pool,
  entryId: string,
  userId: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM user_career_history WHERE id = $1::uuid AND user_id = $2::uuid`,
    [entryId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Count enriched 'experience' entries for a user (all-time, not monthly).
 * Used to enforce the free-tier enrichment cap (5 roles).
 */
export async function countEnrichedExperienceEntries(
  pool: Pool,
  userId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_career_history
      WHERE user_id = $1::uuid
        AND entry_type = 'experience'
        AND enrichment_status = 'complete'`,
    [userId],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}
