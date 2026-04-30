/**
 * @format
 * ApplicationRepository — typed pg queries for the job_applications table.
 */
import type { Queryable } from '../pg.js';

export interface Application {
    id:             string;
    userId:         string | null;
    company:        string;
    role:           string;
    jobUrl:         string | null;
    jobDescription: string;
    kanbanStatus:   string;
    appliedAt:      Date | null;
    createdAt?:     Date | undefined;
    updatedAt?:     Date | undefined;
}

const LIST_APPLICATIONS_LIMIT = 200;

function rowToApplication(row: Record<string, unknown>): Application {
    return {
        id:             row['id']              as string,
        userId:         row['user_id']         as string | null,
        company:        row['company']         as string,
        role:           row['role']            as string,
        jobUrl:         row['job_url']         as string | null,
        jobDescription: row['job_description'] as string,
        kanbanStatus:   row['kanban_status']   as string,
        appliedAt:      row['applied_at']      ? new Date(row['applied_at']  as string) : null,
        createdAt:      row['created_at']      ? new Date(row['created_at']  as string) : undefined,
        updatedAt:      row['updated_at']      ? new Date(row['updated_at']  as string) : undefined,
    };
}

export async function upsertApplication(pool: Queryable, application: Application): Promise<void> {
    await pool.query(
        `INSERT INTO job_applications
             (id, user_id, company, role, job_url, job_description, kanban_status, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
             company        = EXCLUDED.company,
             role           = EXCLUDED.role,
             job_url        = EXCLUDED.job_url,
             job_description = EXCLUDED.job_description,
             kanban_status  = EXCLUDED.kanban_status,
             applied_at     = EXCLUDED.applied_at,
             updated_at     = NOW()`,
        [
            application.id,
            application.userId ?? null,
            application.company,
            application.role,
            application.jobUrl ?? null,
            application.jobDescription,
            application.kanbanStatus,
            application.appliedAt ?? null,
        ],
    );
}

export async function getApplication(pool: Queryable, id: string): Promise<Application | null> {
    const result = await pool.query(
        `SELECT id, user_id, company, role, job_url, job_description,
                kanban_status, applied_at, created_at, updated_at
         FROM job_applications WHERE id = $1`,
        [id],
    );
    if (result.rows.length === 0) return null;
    return rowToApplication(result.rows[0] as Record<string, unknown>);
}

export async function listApplications(pool: Queryable, kanbanStatus?: string): Promise<Application[]> {
    if (kanbanStatus !== undefined) {
        const result = await pool.query(
            `SELECT id, user_id, company, role, job_url, job_description,
                    kanban_status, applied_at, created_at, updated_at
             FROM job_applications WHERE kanban_status = $1 ORDER BY created_at DESC LIMIT ${LIST_APPLICATIONS_LIMIT}`,
            [kanbanStatus],
        );
        return (result.rows as Record<string, unknown>[]).map(rowToApplication);
    }
    const result = await pool.query(
        `SELECT id, user_id, company, role, job_url, job_description,
                kanban_status, applied_at, created_at, updated_at
         FROM job_applications ORDER BY created_at DESC LIMIT ${LIST_APPLICATIONS_LIMIT}`,
    );
    return (result.rows as Record<string, unknown>[]).map(rowToApplication);
}

export async function updateApplicationStatus(pool: Queryable, id: string, kanbanStatus: string): Promise<void> {
    await pool.query(
        `UPDATE job_applications SET kanban_status = $1, updated_at = NOW() WHERE id = $2`,
        [kanbanStatus, id],
    );
}

export async function deleteApplication(pool: Queryable, id: string): Promise<void> {
    await pool.query(`DELETE FROM job_applications WHERE id = $1`, [id]);
}
