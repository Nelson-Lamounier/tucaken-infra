/**
 * @format
 * Unit tests for ResumeRepository.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockQuery = jest.fn<() => Promise<object>>();

jest.unstable_mockModule('pg', () => {
    class Pool {
        query = mockQuery;
    }
    return { Pool, default: { Pool } };
});

const {
    upsertResume,
    getResume,
    listResumes,
    deleteResume,
    setActiveResume,
} = await import('../../../src/lib/repositories/resumes.js');

describe('ResumeRepository', () => {
    beforeEach(() => { mockQuery.mockReset(); });

    const fakePool = { query: mockQuery } as unknown as import('pg').Pool;

    describe('upsertResume', () => {
        it('should execute INSERT ... ON CONFLICT (id) DO UPDATE', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await upsertResume(fakePool, {
                id: 'resume-uuid-1',
                userId: null,
                jobApplicationId: null,
                label: 'My CV',
                isActive: false,
                contentJson: { name: 'Nelson' },
                renderedHtml: null,
            });
            expect(mockQuery).toHaveBeenCalledTimes(1);
            const [sql] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO resumes/i);
            expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
        });

        it('passes label and is_active as dedicated columns and JSON-encodes content', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await upsertResume(fakePool, {
                id: 'resume-uuid-1',
                userId: null,
                jobApplicationId: null,
                label: 'Portfolio CV',
                isActive: true,
                contentJson: { name: 'Nelson' },
                renderedHtml: null,
            });
            const [, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            // Positional params (matches upsertResume INSERT/UPDATE):
            //   $1 id, $2 user_id, $3 job_application_id, $4 label,
            //   $5 is_active, $6 content_json (JSON), $7 rendered_html
            expect(params[3]).toBe('Portfolio CV');
            expect(params[4]).toBe(true);
            const contentJson = JSON.parse(params[5] as string) as Record<string, unknown>;
            expect(contentJson['name']).toBe('Nelson');
        });
    });

    describe('getResume', () => {
        it('maps label, is_active, and content_json from dedicated columns', async () => {
            mockQuery.mockResolvedValue({
                rows: [{
                    id: 'resume-uuid-1',
                    user_id: null,
                    job_application_id: null,
                    label: 'My CV',
                    is_active: true,
                    content_json: { name: 'Nelson' },
                    rendered_html: null,
                    generated_at: new Date('2026-01-01'),
                }],
            });
            const result = await getResume(fakePool, 'resume-uuid-1');
            expect(result).not.toBeNull();
            expect(result!.label).toBe('My CV');
            expect(result!.isActive).toBe(true);
            expect(result!.contentJson['name']).toBe('Nelson');
        });

        it('should return null when not found', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            expect(await getResume(fakePool, 'missing')).toBeNull();
        });
    });

    describe('listResumes', () => {
        it('should query all resumes ordered by generated_at DESC', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await listResumes(fakePool);
            const [sql] = mockQuery.mock.calls[0] as unknown as [string];
            expect(sql).toMatch(/SELECT/i);
            expect(sql).toMatch(/ORDER BY generated_at DESC/i);
        });
    });

    describe('deleteResume', () => {
        it('should execute DELETE WHERE id = $1', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await deleteResume(fakePool, 'resume-uuid-1');
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/DELETE FROM resumes/i);
            expect(params).toContain('resume-uuid-1');
        });
    });

    describe('setActiveResume', () => {
        // The current implementation issues two UPDATEs scoped by user_id +
        // is_active. The DB-side partial unique index enforces the
        // one-active-per-user invariant, so we no longer round-trip through
        // getResume / upsertResume. Tests reflect that.
        it('issues two UPDATE queries scoped by user and target id', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await setActiveResume(fakePool, 'user-1', 'new-id');
            expect(mockQuery).toHaveBeenCalledTimes(2);

            const [sql1, params1] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql1).toMatch(/UPDATE resumes SET is_active = FALSE/i);
            expect(sql1).toMatch(/user_id = \$1 AND is_active = TRUE/i);
            expect(params1).toEqual(['user-1']);

            const [sql2, params2] = mockQuery.mock.calls[1] as unknown as [string, unknown[]];
            expect(sql2).toMatch(/UPDATE resumes SET is_active = TRUE/i);
            expect(sql2).toMatch(/WHERE id = \$1/i);
            expect(params2).toEqual(['new-id']);
        });
    });
});
