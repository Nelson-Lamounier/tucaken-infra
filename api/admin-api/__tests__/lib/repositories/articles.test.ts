/**
 * @format
 * Unit tests for ArticleRepository.
 * Mocks pg Pool using jest.unstable_mockModule.
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
    upsertArticle,
    getArticleBySlug,
    listArticlesByStatus,
    listAllArticles,
    deleteArticle,
} = await import('../../../src/lib/repositories/articles.js');

describe('ArticleRepository', () => {
    beforeEach(() => { mockQuery.mockReset(); });

    const fakePool = { query: mockQuery } as unknown as import('pg').Pool;

    describe('upsertArticle', () => {
        it('should execute INSERT ... ON CONFLICT (slug) DO UPDATE', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await upsertArticle(fakePool, {
                slug: 'hello-world',
                title: 'Hello World',
                excerpt: null,
                contentMd: '# Hello',
                tags: ['dev'],
                status: 'draft',
                aiGenerated: false,
                aiModel: null,
                publishedAt: null,
                coverImage: null,
            });
            expect(mockQuery).toHaveBeenCalledTimes(1);
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO articles/i);
            expect(sql).toMatch(/ON CONFLICT \(slug\) DO UPDATE/i);
            expect(params).toContain('hello-world');
        });
    });

    describe('getArticleBySlug', () => {
        it('should return mapped article when found', async () => {
            mockQuery.mockResolvedValue({
                rows: [{
                    slug: 'hello-world',
                    title: 'Hello World',
                    excerpt: null,
                    content_md: '# Hello',
                    tags: ['dev'],
                    status: 'draft',
                    ai_generated: false,
                    ai_model: null,
                    published_at: null,
                    cover_image: null,
                    created_at: new Date('2026-01-01'),
                    updated_at: new Date('2026-01-01'),
                }],
            });
            const result = await getArticleBySlug(fakePool, 'hello-world');
            expect(result).not.toBeNull();
            expect(result!.slug).toBe('hello-world');
            expect(result!.contentMd).toBe('# Hello');
        });

        it('should return null when not found', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            const result = await getArticleBySlug(fakePool, 'missing');
            expect(result).toBeNull();
        });
    });

    describe('listArticlesByStatus', () => {
        it('should query articles filtered by status and include status in params', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await listArticlesByStatus(fakePool, 'draft');
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/WHERE status = \$1/i);
            expect(params).toContain('draft');
        });
    });

    describe('listAllArticles', () => {
        it('should query all articles without a status filter', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await listAllArticles(fakePool);
            const [sql] = mockQuery.mock.calls[0] as unknown as [string];
            expect(sql).toMatch(/SELECT/i);
            expect(sql).not.toMatch(/WHERE status/i);
        });
    });

    describe('deleteArticle', () => {
        it('should execute DELETE WHERE slug = $1', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await deleteArticle(fakePool, 'hello-world');
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/DELETE FROM articles/i);
            expect(params).toContain('hello-world');
        });
    });
});
