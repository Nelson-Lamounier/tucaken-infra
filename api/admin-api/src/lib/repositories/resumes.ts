/**
 * @format
 * ResumeRepository — typed pg queries for the resumes table.
 *
 * Admin-api portfolio CVs map to the career-domain resumes table.
 * label and is_active are stored inside content_json (JSONB) since the PG
 * schema targets Tucaken user resumes — the admin CV blob is structurally
 * compatible without schema changes.
 */
import type { Queryable } from '../pg.js';

export interface Resume {
    id:               string;
    userId:           string | null;
    jobApplicationId: string | null;
    label:            string;
    isActive:         boolean;
    contentJson:      Record<string, unknown>;
    renderedHtml:     string | null;
    generatedAt?:     Date;
}

function rowToResume(row: Record<string, unknown>): Resume {
    const cj = (row['content_json'] ?? {}) as Record<string, unknown>;
    const resume: Resume = {
        id:               row['id']                 as string,
        userId:           row['user_id']            as string | null,
        jobApplicationId: row['job_application_id'] as string | null,
        label:            (cj['label']              as string) ?? '',
        isActive:         (cj['is_active']          as boolean) ?? false,
        contentJson:      cj,
        renderedHtml:     row['rendered_html']       as string | null,
    };
    if (row['generated_at']) {
        resume.generatedAt = new Date(row['generated_at'] as string);
    }
    return resume;
}

export async function upsertResume(pool: Queryable, resume: Resume): Promise<void> {
    const contentJson = JSON.stringify({
        ...resume.contentJson,
        label:     resume.label,
        is_active: resume.isActive,
    });
    await pool.query(
        `INSERT INTO resumes (id, user_id, job_application_id, content_json, rendered_html)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
             content_json  = EXCLUDED.content_json,
             rendered_html = EXCLUDED.rendered_html`,
        [
            resume.id,
            resume.userId ?? null,
            resume.jobApplicationId ?? null,
            contentJson,
            resume.renderedHtml ?? null,
        ],
    );
}

export async function getResume(pool: Queryable, id: string): Promise<Resume | null> {
    const result = await pool.query(
        `SELECT id, user_id, job_application_id, content_json, rendered_html, generated_at
         FROM resumes WHERE id = $1`,
        [id],
    );
    if (result.rows.length === 0) return null;
    return rowToResume(result.rows[0] as Record<string, unknown>);
}

export async function listResumes(pool: Queryable): Promise<Resume[]> {
    const result = await pool.query(
        `SELECT id, user_id, job_application_id, content_json, rendered_html, generated_at
         FROM resumes ORDER BY generated_at DESC`,
    );
    return (result.rows as Record<string, unknown>[]).map(rowToResume);
}

export async function getActiveResume(pool: Queryable): Promise<Resume | null> {
    const result = await pool.query(
        `SELECT id, user_id, job_application_id, content_json, rendered_html, generated_at
         FROM resumes
         WHERE content_json->>'is_active' = 'true'
         LIMIT 1`,
    );
    if (result.rows.length === 0) return null;
    return rowToResume(result.rows[0] as Record<string, unknown>);
}

export async function deleteResume(pool: Queryable, id: string): Promise<void> {
    await pool.query(`DELETE FROM resumes WHERE id = $1`, [id]);
}

/**
 * Deactivate oldActiveId and activate newActiveId.
 * Sequential writes — acceptable for small tables (< 20 resumes).
 */
export async function setActiveResume(
    pool: Queryable,
    oldActiveId: string | null,
    newActiveId: string,
): Promise<void> {
    if (oldActiveId) {
        const existing = await getResume(pool, oldActiveId);
        if (existing) {
            await upsertResume(pool, { ...existing, isActive: false });
        }
    }
    const target = await getResume(pool, newActiveId);
    if (target) {
        await upsertResume(pool, { ...target, isActive: true });
    }
}
