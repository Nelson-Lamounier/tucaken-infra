/**
 * @format
 * ArticleRepository — typed pg queries for the articles table.
 */
import type { Pool } from 'pg';

export interface Article {
    slug:        string;
    title:       string;
    excerpt:     string | null;
    contentMd:   string;
    tags:        string[];
    status:      string;
    aiGenerated: boolean;
    aiModel:     string | null;
    publishedAt: Date | null;
    coverImage:  string | null;
    createdAt?:  Date | undefined;
    updatedAt?:  Date | undefined;
}

function rowToArticle(row: Record<string, unknown>): Article {
    return {
        slug:        row['slug']         as string,
        title:       row['title']        as string,
        excerpt:     row['excerpt']      as string | null,
        contentMd:   row['content_md']   as string,
        tags:        (row['tags']        as string[]) ?? [],
        status:      row['status']       as string,
        aiGenerated: row['ai_generated'] as boolean,
        aiModel:     row['ai_model']     as string | null,
        publishedAt: row['published_at'] ? new Date(row['published_at'] as string) : null,
        coverImage:  row['cover_image']  as string | null,
        createdAt:   row['created_at']   ? new Date(row['created_at']   as string) : undefined,
        updatedAt:   row['updated_at']   ? new Date(row['updated_at']   as string) : undefined,
    };
}

export async function upsertArticle(pool: Pool, article: Article): Promise<void> {
    await pool.query(
        `INSERT INTO articles
             (slug, title, excerpt, content_md, tags, status, ai_generated, ai_model,
              published_at, cover_image, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (slug) DO UPDATE SET
             title        = EXCLUDED.title,
             excerpt      = EXCLUDED.excerpt,
             content_md   = EXCLUDED.content_md,
             tags         = EXCLUDED.tags,
             status       = EXCLUDED.status,
             ai_generated = EXCLUDED.ai_generated,
             ai_model     = EXCLUDED.ai_model,
             published_at = EXCLUDED.published_at,
             cover_image  = EXCLUDED.cover_image,
             updated_at   = NOW()`,
        [
            article.slug,
            article.title,
            article.excerpt ?? null,
            article.contentMd,
            article.tags,
            article.status,
            article.aiGenerated,
            article.aiModel ?? null,
            article.publishedAt ?? null,
            article.coverImage ?? null,
        ],
    );
}

export async function getArticleBySlug(pool: Pool, slug: string): Promise<Article | null> {
    const result = await pool.query(
        `SELECT slug, title, excerpt, content_md, tags, status, ai_generated,
                ai_model, published_at, cover_image, created_at, updated_at
         FROM articles WHERE slug = $1`,
        [slug],
    );
    if (result.rows.length === 0) return null;
    return rowToArticle(result.rows[0] as Record<string, unknown>);
}

export async function listArticlesByStatus(pool: Pool, status: string): Promise<Article[]> {
    const result = await pool.query(
        `SELECT slug, title, excerpt, content_md, tags, status, ai_generated,
                ai_model, published_at, cover_image, created_at, updated_at
         FROM articles WHERE status = $1 ORDER BY updated_at DESC LIMIT 100`,
        [status],
    );
    return (result.rows as Record<string, unknown>[]).map(rowToArticle);
}

export async function listAllArticles(pool: Pool): Promise<Article[]> {
    const result = await pool.query(
        `SELECT slug, title, excerpt, content_md, tags, status, ai_generated,
                ai_model, published_at, cover_image, created_at, updated_at
         FROM articles ORDER BY updated_at DESC LIMIT 200`,
    );
    return (result.rows as Record<string, unknown>[]).map(rowToArticle);
}

export async function deleteArticle(pool: Pool, slug: string): Promise<void> {
    await pool.query(`DELETE FROM articles WHERE slug = $1`, [slug]);
}
