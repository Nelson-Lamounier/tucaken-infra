# Phase 2: DynamoDB → PostgreSQL Content Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate articles, job\_applications, and resumes from DynamoDB to PostgreSQL (Platform RDS) using a dual-write pattern, then cut over reads and decommission DynamoDB.

**Architecture:** Schema patches run via the bootstrap Job on next ArgoCD sync. Dual-write adds PG as a non-fatal shadow write to all three entity routes; DynamoDB stays primary for reads during the validation window. A one-shot K8s Job backfills historical DynamoDB records into PG. After ≥7 days with zero read-discrepancy alerts, reads cut over to PG and DynamoDB write paths are removed.

**Tech Stack:** Node.js 22 + Hono, `pg` (node-postgres), PostgreSQL 16.6 via PgBouncer (`pgbouncer.platform.svc.cluster.local:5432`), ESO (`aws-secretsmanager` ClusterSecretStore), K8s Job, ArgoCD, Jest 29 (ESM unstable\_mockModule)

---

## File Structure

```
ai-applications/applications/platform-rds-bootstrap/src/
  index.ts                          MODIFY — add ALTER TABLE migration block

api/admin-api/
  package.json                      MODIFY — add pg, @types/pg
  src/lib/config.ts                 MODIFY — add pgHost, pgPort, pgDatabase, pgUser, pgPassword
  src/lib/pg.ts                     CREATE — lazy Pool singleton
  src/lib/repositories/
    articles.ts                     CREATE — upsertArticle, getArticleBySlug, listByStatus, deleteArticle
    applications.ts                 CREATE — upsertApplication, getApplication, listApplications, deleteApplication
    resumes.ts                      CREATE — upsertResume, getResume, listResumes, deleteResume, activateResume
  src/routes/articles.ts            MODIFY — dual-write PUT/DELETE; cut-over GET (Task 9)
  src/routes/applications.ts        MODIFY — dual-write POST/DELETE/status; cut-over GET (Task 9)
  src/routes/resumes.ts             MODIFY — dual-write POST/PUT/DELETE/activate; cut-over GET (Task 9)
  __tests__/lib/repositories/
    articles.test.ts                CREATE
    applications.test.ts            CREATE
    resumes.test.ts                 CREATE
  __tests__/routes/articles.test.ts MODIFY — add dual-write shadow coverage

kubernetes-platform/charts/admin-api/external-secrets/
  platform-rds-credentials.yaml    CREATE — PG creds in admin-api namespace

ai-applications/applications/platform-rds-bootstrap/src/
  migrate-dynamo.ts                 CREATE — DynamoDB → PG migration script
kubernetes-platform/charts/platform-rds/chart/templates/
  migration-job.yaml                CREATE — one-shot K8s Job
```

---

## Task 1: Schema Patches — Bootstrap DDL

**Files:**
- Modify: `ai-applications/applications/platform-rds-bootstrap/src/index.ts` (lines 230–235)

- [ ] **Step 1: Add ALTER TABLE block to DDL string**

  Open `ai-applications/applications/platform-rds-bootstrap/src/index.ts`. Immediately after the last `CREATE INDEX` statement inside the `DDL` template literal (before the closing backtick at line 235), add:

  ```sql
  -- Phase 2 schema patches (idempotent)
  ALTER TABLE articles ADD COLUMN IF NOT EXISTS cover_image TEXT;
  ALTER TABLE job_applications ALTER COLUMN user_id DROP NOT NULL;
  ALTER TABLE resumes ALTER COLUMN user_id DROP NOT NULL;
  ```

  The `DDL` constant should now end:
  ```typescript
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs   ON pipeline_runs (user_id, pipeline_type, status);

  -- Phase 2 schema patches (idempotent)
  ALTER TABLE articles ADD COLUMN IF NOT EXISTS cover_image TEXT;
  ALTER TABLE job_applications ALTER COLUMN user_id DROP NOT NULL;
  ALTER TABLE resumes ALTER COLUMN user_id DROP NOT NULL;
  `;
  ```

- [ ] **Step 2: Trigger bootstrap Job**

  The bootstrap Job runs as an ArgoCD PostSync hook on the `platform-rds` chart. Trigger a manual ArgoCD sync or wait for the next deploy. Alternatively run directly via kubectl:

  ```bash
  # Force re-run by deleting the completed job (ArgoCD hook-delete-policy: BeforeHookCreation handles this on next sync)
  kubectl delete job platform-rds-bootstrap -n platform --ignore-not-found

  # Trigger ArgoCD sync
  argocd app sync platform-rds
  ```

- [ ] **Step 3: Verify schema**

  ```bash
  kubectl run pg-debug --rm -it --restart=Never \
    --image=postgres:16 \
    --env="PGPASSWORD=$(kubectl get secret platform-rds-credentials -n platform -o jsonpath='{.data.PGPASSWORD}' | base64 -d)" \
    -- psql -h pgbouncer.platform.svc.cluster.local -U postgres -d tucaken \
    -c "\d articles" \
    -c "\d job_applications" \
    -c "\d resumes"
  ```

  Expected:
  - `articles` has `cover_image | text | nullable`
  - `job_applications.user_id` shows `user_id | uuid | ` (no `not null`)
  - `resumes.user_id` shows `user_id | uuid | ` (no `not null`)

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
  git add applications/platform-rds-bootstrap/src/index.ts
  git commit -m "feat(rds-bootstrap): add phase-2 schema patches — cover_image, nullable user_id"
  ```

---

## Task 2: Add pg Dependency + PG Config to admin-api

**Files:**
- Modify: `api/admin-api/package.json`
- Modify: `api/admin-api/src/lib/config.ts`
- Create: `api/admin-api/src/lib/pg.ts`

- [ ] **Step 1: Write failing config test**

  Add to `api/admin-api/__tests__/lib/config.test.ts`:

  ```typescript
  describe('PG config', () => {
    it('should include pgHost in resolved config when PG env vars are present', async () => {
      const original = { ...process.env };
      process.env['PG_HOST'] = 'pgbouncer.platform.svc.cluster.local';
      process.env['PG_PORT'] = '5432';
      process.env['PG_DATABASE'] = 'tucaken';
      process.env['PG_USER'] = 'postgres';
      process.env['PG_PASSWORD'] = 'secret';

      const { loadConfig } = await import('../../src/lib/config.js');
      const cfg = loadConfig();

      expect(cfg.pgHost).toBe('pgbouncer.platform.svc.cluster.local');
      expect(cfg.pgPort).toBe(5432);
      expect(cfg.pgDatabase).toBe('tucaken');
      expect(cfg.pgUser).toBe('postgres');
      expect(cfg.pgPassword).toBe('secret');

      Object.assign(process.env, original);
    });

    it('should throw when PG env vars are missing', async () => {
      const saved = {
        PG_HOST: process.env['PG_HOST'],
        PG_PORT: process.env['PG_PORT'],
      };
      delete process.env['PG_HOST'];
      delete process.env['PG_PORT'];

      const { loadConfig } = await import('../../src/lib/config.js');
      expect(() => loadConfig()).toThrow(/PG_HOST/);

      Object.assign(process.env, saved);
    });
  });
  ```

- [ ] **Step 2: Run test to confirm failure**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/config.test.ts
  ```

  Expected: FAIL — `cfg.pgHost is undefined`

- [ ] **Step 3: Install pg**

  ```bash
  cd api/admin-api && yarn add pg && yarn add -D @types/pg
  ```

- [ ] **Step 4: Add PG fields to `AdminApiConfig` interface**

  In `api/admin-api/src/lib/config.ts`, add to the `AdminApiConfig` interface:

  ```typescript
  /** PgBouncer host for PostgreSQL writes/reads. */
  readonly pgHost: string;
  /** PgBouncer port. */
  readonly pgPort: number;
  /** PostgreSQL database name. */
  readonly pgDatabase: string;
  /** PostgreSQL user. */
  readonly pgUser: string;
  /** PostgreSQL password (from Secrets Manager via ESO). */
  readonly pgPassword: string;
  ```

  In `loadConfig()`, add to the `required` object:
  ```typescript
  PG_HOST: process.env['PG_HOST'],
  PG_PORT: process.env['PG_PORT'],
  PG_DATABASE: process.env['PG_DATABASE'],
  PG_USER: process.env['PG_USER'],
  PG_PASSWORD: process.env['PG_PASSWORD'],
  ```

  Add to the return object:
  ```typescript
  pgHost: required['PG_HOST']!,
  pgPort: parseInt(required['PG_PORT']!, 10),
  pgDatabase: required['PG_DATABASE']!,
  pgUser: required['PG_USER']!,
  pgPassword: required['PG_PASSWORD']!,
  ```

- [ ] **Step 5: Create `api/admin-api/src/lib/pg.ts`**

  ```typescript
  /**
   * @format
   * Lazy Pool singleton — connects via PgBouncer (transaction mode).
   * Max 5 client connections: PgBouncer multiplexes these into ≤20 server connections.
   */
  import { Pool } from 'pg';
  import type { AdminApiConfig } from './config.js';

  let _pool: Pool | undefined;

  export function getPool(config: AdminApiConfig): Pool {
      if (!_pool) {
          _pool = new Pool({
              host:     config.pgHost,
              port:     config.pgPort,
              database: config.pgDatabase,
              user:     config.pgUser,
              password: config.pgPassword,
              ssl:      { rejectUnauthorized: false },
              max:      5,
              idleTimeoutMillis:      30_000,
              connectionTimeoutMillis: 5_000,
          });
      }
      return _pool;
  }

  /** For tests only — reset singleton between test suites. */
  export function _resetPool(): void {
      _pool = undefined;
  }
  ```

- [ ] **Step 6: Run test to confirm pass**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/config.test.ts
  ```

  Expected: PASS

- [ ] **Step 7: Commit**

  ```bash
  cd api/admin-api
  git add package.json yarn.lock src/lib/config.ts src/lib/pg.ts __tests__/lib/config.test.ts
  git commit -m "feat(admin-api): add pg dep + PG connection pool module"
  ```

---

## Task 3: ArticleRepository

**Files:**
- Create: `api/admin-api/src/lib/repositories/articles.ts`
- Create: `api/admin-api/__tests__/lib/repositories/articles.test.ts`

- [ ] **Step 1: Write failing tests**

  Create `api/admin-api/__tests__/lib/repositories/articles.test.ts`:

  ```typescript
  /**
   * @format
   * Unit tests for ArticleRepository.
   * Mocks `pg` Pool using jest.unstable_mockModule to avoid real DB connections.
   */
  import { jest, describe, it, expect, beforeEach } from '@jest/globals';

  const mockQuery = jest.fn<() => Promise<object>>();

  jest.unstable_mockModule('pg', () => {
      class Pool {
          query = mockQuery;
      }
      return { Pool, default: { Pool } };
  });

  const { upsertArticle, getArticleBySlug, listArticlesByStatus, deleteArticle } =
      await import('../../../src/lib/repositories/articles.js');

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
              const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
              expect(sql).toMatch(/INSERT INTO articles/i);
              expect(sql).toMatch(/ON CONFLICT \(slug\) DO UPDATE/i);
              expect(params).toContain('hello-world');
          });
      });

      describe('getArticleBySlug', () => {
          it('should return mapped article when found', async () => {
              mockQuery.mockResolvedValue({
                  rows: [{
                      slug: 'hello-world', title: 'Hello World', excerpt: null,
                      content_md: '# Hello', tags: ['dev'], status: 'draft',
                      ai_generated: false, ai_model: null, published_at: null,
                      cover_image: null, created_at: new Date(), updated_at: new Date(),
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
          it('should query articles filtered by status', async () => {
              mockQuery.mockResolvedValue({
                  rows: [{ slug: 'a', title: 'A', excerpt: null, content_md: '', tags: [],
                            status: 'draft', ai_generated: false, ai_model: null,
                            published_at: null, cover_image: null, created_at: new Date(),
                            updated_at: new Date() }],
              });
              const results = await listArticlesByStatus(fakePool, 'draft');
              expect(results).toHaveLength(1);
              const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
              expect(sql).toMatch(/WHERE status = \$1/i);
              expect(params).toContain('draft');
          });
      });

      describe('deleteArticle', () => {
          it('should execute DELETE WHERE slug = $1', async () => {
              mockQuery.mockResolvedValue({ rows: [] });
              await deleteArticle(fakePool, 'hello-world');
              const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
              expect(sql).toMatch(/DELETE FROM articles/i);
              expect(params).toContain('hello-world');
          });
      });
  });
  ```

- [ ] **Step 2: Run test to confirm failure**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/repositories/articles.test.ts
  ```

  Expected: FAIL — module not found

- [ ] **Step 3: Create `api/admin-api/src/lib/repositories/articles.ts`**

  ```typescript
  /**
   * @format
   * ArticleRepository — typed pg queries for the articles table.
   * All functions are stateless: caller provides the Pool (from getPool()).
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
      createdAt?:  Date;
      updatedAt?:  Date;
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
  ```

- [ ] **Step 4: Run test to confirm pass**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/repositories/articles.test.ts
  ```

  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/repositories/articles.ts __tests__/lib/repositories/articles.test.ts
  git commit -m "feat(admin-api): add ArticleRepository"
  ```

---

## Task 4: ApplicationRepository

**Files:**
- Create: `api/admin-api/src/lib/repositories/applications.ts`
- Create: `api/admin-api/__tests__/lib/repositories/applications.test.ts`

- [ ] **Step 1: Write failing tests**

  Create `api/admin-api/__tests__/lib/repositories/applications.test.ts`:

  ```typescript
  /**
   * @format
   * Unit tests for ApplicationRepository.
   */
  import { jest, describe, it, expect, beforeEach } from '@jest/globals';

  const mockQuery = jest.fn<() => Promise<object>>();

  jest.unstable_mockModule('pg', () => {
      class Pool { query = mockQuery; }
      return { Pool, default: { Pool } };
  });

  const { upsertApplication, getApplication, listApplications, deleteApplication } =
      await import('../../../src/lib/repositories/applications.js');

  describe('ApplicationRepository', () => {
      beforeEach(() => { mockQuery.mockReset(); });

      const fakePool = { query: mockQuery } as unknown as import('pg').Pool;

      it('should execute INSERT ... ON CONFLICT (id) DO UPDATE for upsertApplication', async () => {
          mockQuery.mockResolvedValue({ rows: [] });
          await upsertApplication(fakePool, {
              id: 'app-uuid-1',
              userId: null,
              company: 'Acme',
              role: 'Engineer',
              jobUrl: null,
              jobDescription: 'Build stuff',
              kanbanStatus: 'saved',
              appliedAt: null,
          });
          const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
          expect(sql).toMatch(/INSERT INTO job_applications/i);
          expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
          expect(params).toContain('app-uuid-1');
      });

      it('should return null from getApplication when not found', async () => {
          mockQuery.mockResolvedValue({ rows: [] });
          const result = await getApplication(fakePool, 'missing');
          expect(result).toBeNull();
      });

      it('should delete by id in deleteApplication', async () => {
          mockQuery.mockResolvedValue({ rows: [] });
          await deleteApplication(fakePool, 'app-uuid-1');
          const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
          expect(sql).toMatch(/DELETE FROM job_applications/i);
          expect(params).toContain('app-uuid-1');
      });

      it('should list all applications ordered by created_at desc', async () => {
          mockQuery.mockResolvedValue({ rows: [] });
          await listApplications(fakePool);
          const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
          expect(sql).toMatch(/SELECT/i);
          expect(sql).toMatch(/ORDER BY created_at DESC/i);
      });
  });
  ```

- [ ] **Step 2: Run test to confirm failure**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/repositories/applications.test.ts
  ```

- [ ] **Step 3: Create `api/admin-api/src/lib/repositories/applications.ts`**

  ```typescript
  /**
   * @format
   * ApplicationRepository — typed pg queries for job_applications.
   * user_id is nullable post-Phase-2-schema-patch (admin data has no Tucaken user FK).
   */
  import type { Pool } from 'pg';

  export interface Application {
      id:             string;
      userId:         string | null;
      company:        string;
      role:           string;
      jobUrl:         string | null;
      jobDescription: string;
      kanbanStatus:   string;
      appliedAt:      Date | null;
      createdAt?:     Date;
      updatedAt?:     Date;
  }

  function rowToApplication(row: Record<string, unknown>): Application {
      return {
          id:             row['id']              as string,
          userId:         row['user_id']         as string | null,
          company:        row['company']         as string,
          role:           row['role']            as string,
          jobUrl:         row['job_url']         as string | null,
          jobDescription: row['job_description'] as string,
          kanbanStatus:   row['kanban_status']   as string,
          appliedAt:      row['applied_at']      ? new Date(row['applied_at'] as string) : null,
          createdAt:      row['created_at']      ? new Date(row['created_at'] as string) : undefined,
          updatedAt:      row['updated_at']      ? new Date(row['updated_at'] as string) : undefined,
      };
  }

  export async function upsertApplication(pool: Pool, app: Application): Promise<void> {
      await pool.query(
          `INSERT INTO job_applications
              (id, user_id, company, role, job_url, job_description, kanban_status,
               applied_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (id) DO UPDATE SET
              company        = EXCLUDED.company,
              role           = EXCLUDED.role,
              job_url        = EXCLUDED.job_url,
              job_description = EXCLUDED.job_description,
              kanban_status  = EXCLUDED.kanban_status,
              applied_at     = EXCLUDED.applied_at,
              updated_at     = NOW()`,
          [
              app.id,
              app.userId ?? null,
              app.company,
              app.role,
              app.jobUrl ?? null,
              app.jobDescription,
              app.kanbanStatus,
              app.appliedAt ?? null,
          ],
      );
  }

  export async function getApplication(pool: Pool, id: string): Promise<Application | null> {
      const result = await pool.query(
          `SELECT id, user_id, company, role, job_url, job_description,
                  kanban_status, applied_at, created_at, updated_at
           FROM job_applications WHERE id = $1`,
          [id],
      );
      if (result.rows.length === 0) return null;
      return rowToApplication(result.rows[0] as Record<string, unknown>);
  }

  export async function listApplications(pool: Pool, kanbanStatus?: string): Promise<Application[]> {
      const result = kanbanStatus
          ? await pool.query(
              `SELECT id, user_id, company, role, job_url, job_description,
                      kanban_status, applied_at, created_at, updated_at
               FROM job_applications WHERE kanban_status = $1
               ORDER BY created_at DESC LIMIT 200`,
              [kanbanStatus],
            )
          : await pool.query(
              `SELECT id, user_id, company, role, job_url, job_description,
                      kanban_status, applied_at, created_at, updated_at
               FROM job_applications ORDER BY created_at DESC LIMIT 200`,
            );
      return (result.rows as Record<string, unknown>[]).map(rowToApplication);
  }

  export async function updateApplicationStatus(
      pool: Pool,
      id: string,
      kanbanStatus: string,
  ): Promise<void> {
      await pool.query(
          `UPDATE job_applications SET kanban_status = $1, updated_at = NOW() WHERE id = $2`,
          [kanbanStatus, id],
      );
  }

  export async function deleteApplication(pool: Pool, id: string): Promise<void> {
      await pool.query(`DELETE FROM job_applications WHERE id = $1`, [id]);
  }
  ```

- [ ] **Step 4: Run test to confirm pass**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/repositories/applications.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/repositories/applications.ts __tests__/lib/repositories/applications.test.ts
  git commit -m "feat(admin-api): add ApplicationRepository"
  ```

---

## Task 5: ResumeRepository

**Files:**
- Create: `api/admin-api/src/lib/repositories/resumes.ts`
- Create: `api/admin-api/__tests__/lib/repositories/resumes.test.ts`

- [ ] **Step 1: Write failing tests**

  Create `api/admin-api/__tests__/lib/repositories/resumes.test.ts`:

  ```typescript
  /**
   * @format
   * Unit tests for ResumeRepository.
   */
  import { jest, describe, it, expect, beforeEach } from '@jest/globals';

  const mockQuery = jest.fn<() => Promise<object>>();

  jest.unstable_mockModule('pg', () => {
      class Pool { query = mockQuery; }
      return { Pool, default: { Pool } };
  });

  const { upsertResume, getResume, listResumes, deleteResume, setActiveResume } =
      await import('../../../src/lib/repositories/resumes.js');

  describe('ResumeRepository', () => {
      beforeEach(() => { mockQuery.mockReset(); });

      const fakePool = { query: mockQuery } as unknown as import('pg').Pool;

      it('should INSERT ... ON CONFLICT (id) DO UPDATE for upsertResume', async () => {
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
          const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
          expect(sql).toMatch(/INSERT INTO resumes/i);
          expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
      });

      it('should return null from getResume when not found', async () => {
          mockQuery.mockResolvedValue({ rows: [] });
          const result = await getResume(fakePool, 'missing');
          expect(result).toBeNull();
      });

      it('should execute two UPDATEs in setActiveResume', async () => {
          mockQuery.mockResolvedValue({ rows: [] });
          await setActiveResume(fakePool, 'old-id', 'new-id');
          expect(mockQuery).toHaveBeenCalledTimes(2);
      });

      it('should DELETE by id in deleteResume', async () => {
          mockQuery.mockResolvedValue({ rows: [] });
          await deleteResume(fakePool, 'resume-uuid-1');
          const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
          expect(sql).toMatch(/DELETE FROM resumes/i);
          expect(params).toContain('resume-uuid-1');
      });
  });
  ```

- [ ] **Step 2: Run test to confirm failure**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/repositories/resumes.test.ts
  ```

- [ ] **Step 3: Create `api/admin-api/src/lib/repositories/resumes.ts`**

  Note: the `resumes` table in PG is the career-domain AI-generated resume store. The admin-api `resumes` route stores Nelson's portfolio CVs. The mapping uses `label` and `is_active` stored in `content_json` as a JSONB blob, keeping the PG schema intact while adapting to the admin UI shape.

  ```typescript
  /**
   * @format
   * ResumeRepository — typed pg queries for the resumes table.
   *
   * Admin-api resumes (portfolio CVs) map to the PG career-domain resumes table.
   * label and is_active are stored inside content_json since the PG schema
   * is designed for AI-generated Tucaken user resumes — the admin portfolio CV
   * is structurally similar (JSONB blob + metadata).
   */
  import type { Pool } from 'pg';

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
      return {
          id:               row['id']                as string,
          userId:           row['user_id']           as string | null,
          jobApplicationId: row['job_application_id'] as string | null,
          label:            (cj['label']             as string) ?? '',
          isActive:         (cj['is_active']         as boolean) ?? false,
          contentJson:      cj,
          renderedHtml:     row['rendered_html']     as string | null,
          generatedAt:      row['generated_at']      ? new Date(row['generated_at'] as string) : undefined,
      };
  }

  export async function upsertResume(pool: Pool, resume: Resume): Promise<void> {
      const contentJson = {
          ...resume.contentJson,
          label:     resume.label,
          is_active: resume.isActive,
      };
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
              JSON.stringify(contentJson),
              resume.renderedHtml ?? null,
          ],
      );
  }

  export async function getResume(pool: Pool, id: string): Promise<Resume | null> {
      const result = await pool.query(
          `SELECT id, user_id, job_application_id, content_json, rendered_html, generated_at
           FROM resumes WHERE id = $1`,
          [id],
      );
      if (result.rows.length === 0) return null;
      return rowToResume(result.rows[0] as Record<string, unknown>);
  }

  export async function listResumes(pool: Pool): Promise<Resume[]> {
      const result = await pool.query(
          `SELECT id, user_id, job_application_id, content_json, rendered_html, generated_at
           FROM resumes ORDER BY generated_at DESC`,
      );
      return (result.rows as Record<string, unknown>[]).map(rowToResume);
  }

  export async function deleteResume(pool: Pool, id: string): Promise<void> {
      await pool.query(`DELETE FROM resumes WHERE id = $1`, [id]);
  }

  /**
   * Deactivate oldId and activate newId in two sequential writes.
   * Small table (< 20 rows) — sequential writes are acceptable.
   */
  export async function setActiveResume(
      pool: Pool,
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
  ```

- [ ] **Step 4: Run test to confirm pass**

  ```bash
  cd api/admin-api && yarn test __tests__/lib/repositories/resumes.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/repositories/resumes.ts __tests__/lib/repositories/resumes.test.ts
  git commit -m "feat(admin-api): add ResumeRepository"
  ```

---

## Task 6: ESO Manifest — PG Creds in admin-api Namespace

**Files:**
- Create: `kubernetes-platform/charts/admin-api/external-secrets/platform-rds-credentials.yaml`

- [ ] **Step 1: Write failing verification**

  The test is kubectl — run after applying:

  ```bash
  kubectl get secret platform-rds-credentials -n admin-api -o jsonpath='{.data.PG_HOST}' | base64 -d
  # Expected: pgbouncer.platform.svc.cluster.local
  ```

  Before creating the manifest, confirm this secret does NOT yet exist:
  ```bash
  kubectl get secret platform-rds-credentials -n admin-api 2>&1 | grep "not found"
  ```

- [ ] **Step 2: Create the ExternalSecret manifest**

  Create `kubernetes-platform/charts/admin-api/external-secrets/platform-rds-credentials.yaml`:

  ```yaml
  # @format
  # ExternalSecret: platform-rds-credentials (admin-api namespace)
  #
  # Provides PG connection env vars to the admin-api pod.
  # Host is PgBouncer (cluster-internal DNS) — not the RDS endpoint directly.
  # Password extracted from the Secrets Manager secret created by PlatformRdsStack.
  #
  # Managed by ArgoCD Application: admin-api-secrets
  #   source: kubernetes-platform/charts/admin-api/external-secrets/
  apiVersion: external-secrets.io/v1beta1
  kind: ExternalSecret
  metadata:
    name: platform-rds-credentials
    namespace: admin-api
    annotations:
      kubernetes.io/description: "PG connection creds for admin-api — PgBouncer host, password from SM"
  spec:
    refreshInterval: 15m
    secretStoreRef:
      name: aws-secretsmanager
      kind: ClusterSecretStore
    target:
      name: platform-rds-credentials
      creationPolicy: Owner
      deletionPolicy: Delete
      template:
        type: Opaque
        data:
          PG_HOST: pgbouncer.platform.svc.cluster.local
          PG_PORT: "5432"
          PG_DATABASE: tucaken
          PG_USER: "{{ .username }}"
          PG_PASSWORD: "{{ .password }}"
    data:
      - secretKey: username
        remoteRef:
          key: k8s-development/platform-rds/credentials
          property: username
      - secretKey: password
        remoteRef:
          key: k8s-development/platform-rds/credentials
          property: password
  ```

- [ ] **Step 3: Add `envFrom` to the admin-api deployment**

  The admin-api deployment template is managed by the workload-generator ArgoCD ApplicationSet reading `kubernetes-app/workloads/charts/admin-api/chart/` in the `cdk-monitoring` repo. Find the Deployment template and add:

  ```yaml
  envFrom:
    - secretRef:
        name: admin-api-secrets          # existing
    - secretRef:
        name: platform-rds-credentials  # NEW — PG connection vars
  ```

  This adds `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` to the pod's environment.

- [ ] **Step 4: Apply and verify**

  ```bash
  # Commit and push to trigger ArgoCD sync
  cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-platform
  git add charts/admin-api/external-secrets/platform-rds-credentials.yaml
  git commit -m "feat(admin-api): add platform-rds-credentials ExternalSecret"
  git push

  # After ArgoCD syncs (~30s):
  kubectl get secret platform-rds-credentials -n admin-api
  kubectl get secret platform-rds-credentials -n admin-api -o jsonpath='{.data.PG_HOST}' | base64 -d
  # Expected: pgbouncer.platform.svc.cluster.local
  ```

---

## Task 7: Dual-Write — Articles Route

**Files:**
- Modify: `api/admin-api/src/routes/articles.ts`
- Modify: `api/admin-api/__tests__/routes/articles.test.ts`

- [ ] **Step 1: Add shadow-write test coverage**

  In `api/admin-api/__tests__/routes/articles.test.ts`, add a mock for the pg module and repository, then add a test verifying the shadow write is attempted on PUT:

  ```typescript
  // Add at top of file alongside existing mocks:
  const pgUpsertMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

  jest.unstable_mockModule('../../src/lib/repositories/articles.js', () => ({
      upsertArticle: pgUpsertMock,
      deleteArticle: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getArticleBySlug: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      listArticlesByStatus: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
      listAllArticles: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
  }));

  jest.unstable_mockModule('../../src/lib/pg.js', () => ({
      getPool: jest.fn(() => ({})),
  }));
  ```

  Add in the `PUT /:slug` describe block:

  ```typescript
  it('should attempt PG shadow write on successful DynamoDB update', async () => {
      sendMock.mockResolvedValue({ Attributes: { slug: 'test-slug', title: 'Updated' } });
      const res = await app.request('/api/admin/articles/test-slug', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated' }),
      });
      expect(res.status).toBe(200);
      expect(pgUpsertMock).toHaveBeenCalledTimes(1);
  });

  it('should still return 200 when PG shadow write fails', async () => {
      sendMock.mockResolvedValue({ Attributes: { slug: 'test-slug', title: 'Updated' } });
      pgUpsertMock.mockRejectedValueOnce(new Error('PG timeout'));
      const res = await app.request('/api/admin/articles/test-slug', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated' }),
      });
      expect(res.status).toBe(200);
  });
  ```

- [ ] **Step 2: Run test to confirm failure**

  ```bash
  cd api/admin-api && yarn test __tests__/routes/articles.test.ts
  ```

- [ ] **Step 3: Add dual-write to articles route**

  In `api/admin-api/src/routes/articles.ts`, add these imports at the top (after existing imports, following established import order):

  ```typescript
  import { getPool } from '../lib/pg.js';
  import { upsertArticle, deleteArticle as pgDeleteArticle } from '../lib/repositories/articles.js';
  ```

  In the `router.put('/:slug', ...)` handler, after the successful `docClient.send(new UpdateCommand(...))` call and before the `return ctx.json(...)` line, add:

  ```typescript
  // Shadow write to PG — non-fatal during dual-write period
  try {
      const pool = getPool(config);
      await upsertArticle(pool, {
          slug,
          title:       (updates['title']       as string) ?? '',
          excerpt:     (updates['excerpt']      as string | null) ?? null,
          contentMd:   (updates['contentMd']    as string) ?? '',
          tags:        (updates['tags']         as string[]) ?? [],
          status:      (updates['status']       as string) ?? 'draft',
          aiGenerated: (updates['aiGenerated']  as boolean) ?? false,
          aiModel:     (updates['aiModel']      as string | null) ?? null,
          publishedAt: updates['publishedAt']   ? new Date(updates['publishedAt'] as string) : null,
          coverImage:  (updates['coverImage']   as string | null) ?? null,
      });
  } catch (pgErr: unknown) {
      console.error(`[articles] PG shadow write failed — slug=${slug}`, pgErr);
  }
  ```

  In the `router.delete('/:slug', ...)` handler, after the `Promise.all([...])` resolves, add:

  ```typescript
  // Shadow delete from PG — non-fatal
  try {
      await pgDeleteArticle(getPool(config), slug);
  } catch (pgErr: unknown) {
      console.error(`[articles] PG shadow delete failed — slug=${slug}`, pgErr);
  }
  ```

- [ ] **Step 4: Run tests to confirm pass**

  ```bash
  cd api/admin-api && yarn test __tests__/routes/articles.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/routes/articles.ts __tests__/routes/articles.test.ts
  git commit -m "feat(admin-api): dual-write articles to PG (shadow, non-fatal)"
  ```

---

## Task 8: Dual-Write — Applications and Resumes Routes

**Files:**
- Modify: `api/admin-api/src/routes/applications.ts`
- Modify: `api/admin-api/src/routes/resumes.ts`

The pattern is identical to Task 7. Only the repository functions and field mappings differ.

- [ ] **Step 1: Add dual-write to applications route**

  In `api/admin-api/src/routes/applications.ts`, add imports:

  ```typescript
  import { getPool } from '../lib/pg.js';
  import {
      upsertApplication,
      updateApplicationStatus as pgUpdateStatus,
      deleteApplication as pgDeleteApplication,
  } from '../lib/repositories/applications.js';
  ```

  In the `POST /` handler (create application), after the DynamoDB PutCommand succeeds, add:

  ```typescript
  try {
      await upsertApplication(getPool(config), {
          id:             body.id ?? randomUUID(),
          userId:         null,
          company:        body.company,
          role:           body.role,
          jobUrl:         body.jobUrl ?? null,
          jobDescription: body.jobDescription,
          kanbanStatus:   body.status ?? 'saved',
          appliedAt:      body.appliedAt ? new Date(body.appliedAt) : null,
      });
  } catch (pgErr) {
      console.error('[applications] PG shadow write failed', pgErr);
  }
  ```

  In the `POST /:slug/status` handler, after DynamoDB UpdateCommand succeeds:

  ```typescript
  try {
      await pgUpdateStatus(getPool(config), slug, body.status);
  } catch (pgErr) {
      console.error('[applications] PG shadow status update failed', pgErr);
  }
  ```

  In the `DELETE /:slug` handler, after DynamoDB BatchWriteCommand:

  ```typescript
  try {
      await pgDeleteApplication(getPool(config), slug);
  } catch (pgErr) {
      console.error('[applications] PG shadow delete failed', pgErr);
  }
  ```

- [ ] **Step 2: Add dual-write to resumes route**

  In `api/admin-api/src/routes/resumes.ts`, add imports:

  ```typescript
  import { getPool } from '../lib/pg.js';
  import {
      upsertResume,
      deleteResume as pgDeleteResume,
      setActiveResume,
  } from '../lib/repositories/resumes.js';
  ```

  In `router.post('/')` (create resume), after DynamoDB PutCommand:

  ```typescript
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
  ```

  In `router.put('/:id')` (update resume), after DynamoDB UpdateCommand:

  ```typescript
  try {
      const existingPg = await import('../lib/repositories/resumes.js')
          .then(m => m.getResume(getPool(config), id));
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
  ```

  In `router.delete('/:id')`, after DynamoDB DeleteCommand:

  ```typescript
  try {
      await pgDeleteResume(getPool(config), id);
  } catch (pgErr) {
      console.error('[resumes] PG shadow delete failed', pgErr);
  }
  ```

  In `router.post('/:id/activate')`, after both DynamoDB UpdateCommands:

  ```typescript
  try {
      await setActiveResume(
          getPool(config),
          currentActive?.resumeId ?? null,
          id,
      );
  } catch (pgErr) {
      console.error('[resumes] PG shadow activate failed', pgErr);
  }
  ```

- [ ] **Step 3: Run all admin-api tests**

  ```bash
  cd api/admin-api && yarn test
  ```

  Expected: all pass

- [ ] **Step 4: Commit**

  ```bash
  git add src/routes/applications.ts src/routes/resumes.ts
  git commit -m "feat(admin-api): dual-write applications and resumes to PG (shadow, non-fatal)"
  ```

---

## Task 9: DynamoDB → PostgreSQL Migration Job

**Files:**
- Create: `ai-applications/applications/platform-rds-bootstrap/src/migrate-dynamo.ts`
- Create: `kubernetes-platform/charts/platform-rds/chart/templates/migration-job.yaml`

- [ ] **Step 1: Create migration script**

  Create `ai-applications/applications/platform-rds-bootstrap/src/migrate-dynamo.ts`:

  ```typescript
  /**
   * @format
   * DynamoDB → PostgreSQL one-shot migration.
   *
   * Migrates: articles, job_applications (kanban), resumes (portfolio CVs).
   *
   * All inserts use ON CONFLICT DO NOTHING — safe to re-run.
   * Connects directly to RDS (not PgBouncer) — same as bootstrap Job.
   *
   * Env vars:
   *   ARTICLES_TABLE         — DynamoDB articles table name
   *   STRATEGIST_TABLE       — DynamoDB strategist table (job_applications + resumes)
   *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD — RDS direct
   *   AWS_DEFAULT_REGION     — e.g. eu-west-1
   */
  import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
  import { unmarshall } from '@aws-sdk/util-dynamodb';
  import { Pool } from 'pg';

  const dynamo = new DynamoDBClient({ region: process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1' });

  const pool = new Pool({
      host:     process.env['PGHOST'],
      port:     parseInt(process.env['PGPORT'] ?? '5432', 10),
      database: process.env['PGDATABASE'],
      user:     process.env['PGUSER'],
      password: process.env['PGPASSWORD'],
      ssl:      { rejectUnauthorized: false },
      max:      3,
      connectionTimeoutMillis: 10_000,
  });

  async function scanAll(tableName: string): Promise<Record<string, unknown>[]> {
      const items: Record<string, unknown>[] = [];
      let lastKey: Record<string, unknown> | undefined;

      do {
          const result = await dynamo.send(new ScanCommand({
              TableName: tableName,
              ExclusiveStartKey: lastKey as Record<string, { S?: string; N?: string; BOOL?: boolean }> | undefined,
          }));
          for (const raw of result.Items ?? []) {
              items.push(unmarshall(raw));
          }
          lastKey = result.LastEvaluatedKey
              ? unmarshall(result.LastEvaluatedKey) as Record<string, unknown>
              : undefined;
      } while (lastKey);

      return items;
  }

  async function migrateArticles(): Promise<number> {
      const articlesTable = process.env['ARTICLES_TABLE'];
      if (!articlesTable) { console.warn('ARTICLES_TABLE not set — skipping articles'); return 0; }

      const items = await scanAll(articlesTable);
      // Only METADATA records; skip CONTENT#<slug> records
      const metadata = items.filter(i => i['sk'] === 'METADATA' || !i['sk']);
      let count = 0;

      for (const item of metadata) {
          const slug = (item['slug'] as string | undefined) ?? String(item['pk']).replace('ARTICLE#', '');
          if (!slug || !item['title']) continue;

          await pool.query(
              `INSERT INTO articles
                  (slug, title, excerpt, content_md, tags, status, ai_generated, ai_model,
                   published_at, cover_image)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (slug) DO NOTHING`,
              [
                  slug,
                  item['title'] as string,
                  (item['excerpt'] as string | null) ?? null,
                  (item['contentMd'] as string | null) ?? (item['content'] as string | null) ?? '',
                  (item['tags'] as string[] | null) ?? [],
                  (item['status'] as string | null) ?? 'draft',
                  (item['aiGenerated'] as boolean | null) ?? false,
                  (item['aiModel'] as string | null) ?? null,
                  item['publishedAt'] ? new Date(item['publishedAt'] as string) : null,
                  (item['coverImage'] as string | null) ?? null,
              ],
          );
          count++;
      }

      console.log(`Articles: migrated ${count}/${metadata.length}`);
      return count;
  }

  async function migrateApplications(): Promise<number> {
      const strategistTable = process.env['STRATEGIST_TABLE'];
      if (!strategistTable) { console.warn('STRATEGIST_TABLE not set — skipping applications'); return 0; }

      const items = await scanAll(strategistTable);
      const apps = items.filter(i => i['entityType'] === 'APPLICATION' || (i['company'] && i['role']));
      let count = 0;

      for (const item of apps) {
          const id = (item['applicationId'] as string | undefined) ?? (item['pk'] as string).replace('APPLICATION#', '');
          if (!id || !item['company'] || !item['role'] || !item['jobDescription']) continue;

          await pool.query(
              `INSERT INTO job_applications
                  (id, company, role, job_url, job_description, kanban_status, applied_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (id) DO NOTHING`,
              [
                  id,
                  item['company'] as string,
                  item['role'] as string,
                  (item['jobUrl'] as string | null) ?? null,
                  item['jobDescription'] as string,
                  (item['status'] as string | null) ?? (item['kanbanStatus'] as string | null) ?? 'saved',
                  item['appliedAt'] ? new Date(item['appliedAt'] as string) : null,
              ],
          );
          count++;
      }

      console.log(`Applications: migrated ${count}/${apps.length}`);
      return count;
  }

  async function migrateResumes(): Promise<number> {
      const strategistTable = process.env['STRATEGIST_TABLE'];
      if (!strategistTable) { console.warn('STRATEGIST_TABLE not set — skipping resumes'); return 0; }

      const items = await scanAll(strategistTable);
      const resumes = items.filter(i => i['entityType'] === 'RESUME');
      let count = 0;

      for (const item of resumes) {
          const id = (item['resumeId'] as string | undefined) ?? (item['pk'] as string).replace('RESUME#', '');
          if (!id || !item['data']) continue;

          const contentJson = {
              ...(item['data'] as Record<string, unknown>),
              label:     item['label'] ?? '',
              is_active: item['isActive'] ?? false,
          };

          await pool.query(
              `INSERT INTO resumes (id, content_json)
               VALUES ($1, $2)
               ON CONFLICT (id) DO NOTHING`,
              [id, JSON.stringify(contentJson)],
          );
          count++;
      }

      console.log(`Resumes: migrated ${count}/${resumes.length}`);
      return count;
  }

  async function main(): Promise<void> {
      console.log('DynamoDB → PostgreSQL migration starting...');
      await migrateArticles();
      await migrateApplications();
      await migrateResumes();
      console.log('Migration complete.');
  }

  main()
      .catch((err) => { console.error('Migration failed:', err); process.exit(1); })
      .finally(() => pool.end());
  ```

- [ ] **Step 2: Create K8s Job manifest**

  Create `kubernetes-platform/charts/platform-rds/chart/templates/migration-job.yaml`:

  ```yaml
  # @format
  # K8s Job: dynamo-to-pg-migration
  #
  # One-shot DynamoDB → PostgreSQL data migration.
  # Enabled only when .Values.migration.enabled = true (default: false).
  # Run once after dual-write is deployed; safe to re-run (ON CONFLICT DO NOTHING).
  #
  # Trigger manually:
  #   helm upgrade platform-rds . --set migration.enabled=true -n platform
  #   kubectl wait --for=condition=complete job/dynamo-to-pg-migration -n platform --timeout=300s
  #   helm upgrade platform-rds . --set migration.enabled=false -n platform
  {{- if .Values.migration.enabled }}
  apiVersion: batch/v1
  kind: Job
  metadata:
    name: dynamo-to-pg-migration
    namespace: platform
    annotations:
      kubernetes.io/description: "One-shot DynamoDB to PostgreSQL content migration"
  spec:
    ttlSecondsAfterFinished: 86400
    backoffLimit: 2
    activeDeadlineSeconds: 600
    template:
      spec:
        restartPolicy: Never
        serviceAccountName: platform-rds-bootstrap-sa
        containers:
          - name: migrate
            image: {{ .Values.bootstrap.image.repository }}:{{ .Values.bootstrap.image.tag }}
            command: ["node", "dist/migrate-dynamo.js"]
            env:
              - name: AWS_DEFAULT_REGION
                value: {{ .Values.awsRegion | default "eu-west-1" }}
              - name: ARTICLES_TABLE
                value: {{ .Values.migration.articlesTable | quote }}
              - name: STRATEGIST_TABLE
                value: {{ .Values.migration.strategistTable | quote }}
            envFrom:
              - secretRef:
                  name: platform-rds-credentials
              - configMapRef:
                  name: platform-rds-config
            resources:
              requests:
                memory: "256Mi"
                cpu: "100m"
              limits:
                memory: "512Mi"
                cpu: "200m"
  {{- end }}
  ```

- [ ] **Step 3: Add migration values to `values.yaml`**

  In `kubernetes-platform/charts/platform-rds/chart/values.yaml`, add:

  ```yaml
  migration:
    enabled: false
    articlesTable: ""       # e.g. tucaken-articles-development
    strategistTable: ""     # e.g. tucaken-strategist-development
  ```

- [ ] **Step 4: Build and run migration**

  ```bash
  # In ai-applications repo: build the bootstrap image with migrate-dynamo included
  cd ai-applications/applications/platform-rds-bootstrap
  yarn build

  # Trigger migration (get table names first)
  ARTICLES_TABLE=$(aws ssm get-parameter --name /bedrock-dev/content-table-name --query Parameter.Value --output text)
  STRATEGIST_TABLE=$(aws ssm get-parameter --name /bedrock-dev/strategist-table-name --query Parameter.Value --output text)

  cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-platform
  helm upgrade platform-rds charts/platform-rds/chart -n platform \
    --set migration.enabled=true \
    --set migration.articlesTable="${ARTICLES_TABLE}" \
    --set migration.strategistTable="${STRATEGIST_TABLE}"

  kubectl wait --for=condition=complete job/dynamo-to-pg-migration -n platform --timeout=600s
  kubectl logs job/dynamo-to-pg-migration -n platform

  # Disable migration after run
  helm upgrade platform-rds charts/platform-rds/chart -n platform --set migration.enabled=false
  ```

- [ ] **Step 5: Verify row counts**

  ```bash
  kubectl run pg-debug --rm -it --restart=Never --image=postgres:16 \
    --env="PGPASSWORD=$(kubectl get secret platform-rds-credentials -n platform -o jsonpath='{.data.PGPASSWORD}' | base64 -d)" \
    -- psql -h pgbouncer.platform.svc.cluster.local -U postgres -d tucaken \
    -c "SELECT 'articles' AS tbl, COUNT(*) FROM articles
        UNION ALL SELECT 'job_applications', COUNT(*) FROM job_applications
        UNION ALL SELECT 'resumes', COUNT(*) FROM resumes;"
  ```

  Cross-check against DynamoDB item counts.

- [ ] **Step 6: Commit**

  ```bash
  cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
  git add applications/platform-rds-bootstrap/src/migrate-dynamo.ts
  git commit -m "feat(rds-bootstrap): add DynamoDB → PG migration script"

  cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-platform
  git add charts/platform-rds/chart/templates/migration-job.yaml \
          charts/platform-rds/chart/values.yaml
  git commit -m "feat(platform-rds): add migration K8s Job template"
  ```

---

## Task 10: Cut-Over Reads

> **Gate:** Run Tasks 1–9 first. Monitor for ≥7 days with zero `[articles] PG shadow write failed` / `[resumes] PG shadow` log lines. Only then proceed with cut-over.

**Files:**
- Modify: `api/admin-api/src/routes/articles.ts`
- Modify: `api/admin-api/src/routes/applications.ts`
- Modify: `api/admin-api/src/routes/resumes.ts`

- [ ] **Step 1: Verify zero shadow errors (manual gate)**

  ```bash
  # Check Loki/CloudWatch for shadow-write errors in the last 7 days
  # In Grafana: query {namespace="admin-api"} |= "PG shadow write failed"
  # Expected: 0 results
  ```

  Do not proceed if any shadow errors appear. Investigate and fix the PG write path first.

- [ ] **Step 2: Cut over `GET /api/admin/articles` to PG**

  In `api/admin-api/src/routes/articles.ts`, replace the `router.get('/')` handler body with:

  ```typescript
  router.get('/', async (ctx) => {
      const rawStatus = (ctx.req.query('status') ?? 'all').toLowerCase();
      const pool = getPool(config);

      let articles: import('../lib/repositories/articles.js').Article[];

      if (rawStatus === 'all') {
          articles = await listAllArticles(pool);
      } else if ((ALL_STATUSES as readonly string[]).includes(rawStatus)) {
          articles = await listArticlesByStatus(pool, rawStatus);
      } else {
          return ctx.json({ error: `Invalid status "${rawStatus}". Must be one of: all, ${ALL_STATUSES.join(', ')}` }, 400);
      }

      return ctx.json({ articles, count: articles.length });
  });
  ```

  Replace the `router.get('/:slug', ...)` handler body with:

  ```typescript
  router.get('/:slug', async (ctx) => {
      const slug = ctx.req.param('slug');
      const article = await getArticleBySlug(getPool(config), slug);
      if (!article) return ctx.json({ error: 'Article not found' }, 404);
      return ctx.json({ article });
  });
  ```

  Add the required imports at top:
  ```typescript
  import {
      upsertArticle, deleteArticle as pgDeleteArticle,
      getArticleBySlug, listArticlesByStatus, listAllArticles,
  } from '../lib/repositories/articles.js';
  ```

- [ ] **Step 3: Cut over applications and resumes GET routes**

  In `applications.ts`, replace the DynamoDB `QueryCommand` in `router.get('/')` with:

  ```typescript
  router.get('/', async (ctx) => {
      const rawStatus = ctx.req.query('status');
      const apps = await listApplications(getPool(config), rawStatus ?? undefined);
      return ctx.json({ applications: apps, count: apps.length });
  });
  ```

  In `resumes.ts`, replace the DynamoDB scan in `router.get('/')` with:

  ```typescript
  router.get('/', async (ctx) => {
      const resumes = await listResumes(getPool(config));
      return ctx.json({ resumes, count: resumes.length });
  });
  ```

  Replace `router.get('/active')` with:

  ```typescript
  router.get('/active', async (ctx) => {
      const all = await listResumes(getPool(config));
      const active = all.find(r => r.isActive) ?? null;
      if (!active) return ctx.json({ error: 'No active resume configured' }, 404);
      return ctx.json({ resume: active });
  });
  ```

  Replace `router.get('/:id')` with:

  ```typescript
  router.get('/:id', async (ctx) => {
      const id = ctx.req.param('id');
      const resume = await getResume(getPool(config), id);
      if (!resume) return ctx.json({ error: `Resume not found: ${id}` }, 404);
      return ctx.json({ resume });
  });
  ```

- [ ] **Step 4: Run full test suite**

  ```bash
  cd api/admin-api && yarn test
  ```

  Expected: all pass. Update test mocks as needed now that reads come from PG.

- [ ] **Step 5: Remove DynamoDB read imports (cleanup)**

  In `articles.ts`, remove `GetCommand`, `QueryCommand` from `@aws-sdk/lib-dynamodb` imports if no longer used by GET routes. Keep `UpdateCommand`, `DeleteCommand` (still used for writes until Phase 5 DynamoDB decommission).

- [ ] **Step 6: Deploy and smoke test**

  ```bash
  # Build and push new admin-api image; ArgoCD Image Updater handles rollout
  # Verify in Grafana: zero DynamoDB read errors, PG queries appearing in slow-query log
  kubectl logs -l app=admin-api -n admin-api --tail=50 | grep -E "PG|dynamo|error"
  ```

- [ ] **Step 7: Commit**

  ```bash
  cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
  git add api/admin-api/src/routes/articles.ts \
          api/admin-api/src/routes/applications.ts \
          api/admin-api/src/routes/resumes.ts \
          api/admin-api/__tests__/routes/
  git commit -m "feat(admin-api): cut over reads to PostgreSQL — articles, applications, resumes"
  ```

---

## Phase 2 Complete — Validation Checklist

Before declaring Phase 2 done:

```bash
# 1. All unit tests pass
cd api/admin-api && yarn test

# 2. PG tables have data (row counts match DynamoDB exports)
kubectl run pg-debug --rm -it --restart=Never --image=postgres:16 \
  --env="PGPASSWORD=$(kubectl get secret platform-rds-credentials -n platform -o jsonpath='{.data.PGPASSWORD}' | base64 -d)" \
  -- psql -h pgbouncer.platform.svc.cluster.local -U postgres -d tucaken \
  -c "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE relname IN ('articles','job_applications','resumes');"

# 3. Zero shadow-write errors in logs for 7 days
# Grafana: {namespace="admin-api"} |= "PG shadow write failed" — 0 results

# 4. Admin UI functions correctly end-to-end (articles list, create, publish)

# 5. Phase 5 (DynamoDB decommission) scheduled after validation window
```

**Next phase:** Phase 3 — Ingestion Pipeline Lambda → K8s Job (see `tucaken-migration.md` §7)
