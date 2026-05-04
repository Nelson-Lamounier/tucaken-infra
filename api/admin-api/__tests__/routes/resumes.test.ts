/**
 * @format
 * Tests for admin-api routes/resumes.ts (PG-only after Phase 5).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Repository mocks
// ---------------------------------------------------------------------------

 
const pgListResumesMock     = jest.fn() as jest.Mock<any>;
 
const pgGetResumeMock       = jest.fn() as jest.Mock<any>;
 
const pgGetActiveResumeMock = jest.fn() as jest.Mock<any>;
 
const pgUpsertResumeMock    = jest.fn() as jest.Mock<any>;
 
const pgDeleteResumeMock    = jest.fn() as jest.Mock<any>;
 
const pgSetActiveResumeMock = jest.fn() as jest.Mock<any>;
pgListResumesMock.mockResolvedValue([]);
pgGetResumeMock.mockResolvedValue(null);
pgGetActiveResumeMock.mockResolvedValue(null);
pgUpsertResumeMock.mockResolvedValue(undefined);
pgDeleteResumeMock.mockResolvedValue(undefined);
pgSetActiveResumeMock.mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/lib/repositories/resumes.js', () => ({
  upsertResume:    pgUpsertResumeMock,
  getResume:       pgGetResumeMock,
  listResumes:     pgListResumesMock,
  getActiveResume: pgGetActiveResumeMock,
  deleteResume:    pgDeleteResumeMock,
  setActiveResume: pgSetActiveResumeMock,
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
  getPool:  jest.fn(() => ({})),
  withUser: async (_pool: unknown, _userId: string, fn: (db: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Dynamic imports — resolved AFTER mocks are registered
// ---------------------------------------------------------------------------

const { Hono } = await import('hono');
const { createResumesRouter } = await import('../../src/routes/resumes.js');

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const testConfig = {
  assetsBucketName: 'test-bucket',
  cognitoUserPoolId: 'eu-west-1_TestPool',
  cognitoClientId: 'testClient',
  cognitoIssuerUrl: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  awsRegion: 'eu-west-1',
  port: 3002,
} as const;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
     
    (ctx as any).set('jwtPayload', { sub: 'test-user-sub' });
     
    (ctx as any).set('userId', 'test-user-sub');
    await next();
  });
   
  app.route('/', createResumesRouter(testConfig as any));
  return app;
}

// ---------------------------------------------------------------------------
// Test data — PG-shaped resume records
// ---------------------------------------------------------------------------

const PG_RESUME = {
  id: 'resume-uuid-1',
  userId: null,
  jobApplicationId: null,
  label: 'Senior Engineer 2026',
  isActive: false,
  contentJson: { basics: { name: 'Nelson Lamounier' } },
  renderedHtml: null,
};

const PG_ACTIVE_RESUME = {
  ...PG_RESUME,
  id: 'active-uuid',
  label: 'Active CV',
  isActive: true,
};

// ---------------------------------------------------------------------------
// GET / — list resumes
// ---------------------------------------------------------------------------

describe('GET / — list all resume summaries', () => {
  beforeEach(() => {
    pgListResumesMock.mockReset();
  });

  it('returns 200 with a list of resumes from PG', async () => {
    pgListResumesMock.mockResolvedValue([PG_RESUME]);
    const res = await buildApp().request('/');
    const body = (await res.json()) as { resumes: unknown[]; count: number };
    expect(res.status).toBe(200);
    expect(body.resumes).toHaveLength(1);
    expect(body.count).toBe(1);
  });

  it('PG resume has id and label fields (no DynamoDB keys)', async () => {
    pgListResumesMock.mockResolvedValue([PG_RESUME]);
    const res = await buildApp().request('/');
    const body = (await res.json()) as { resumes: Record<string, unknown>[] };
    const resume = body.resumes[0] as Record<string, unknown>;
    expect(resume['pk']).toBeUndefined();
    expect(resume['sk']).toBeUndefined();
    expect(resume['id']).toBe('resume-uuid-1');
    expect(resume['label']).toBe('Senior Engineer 2026');
  });

  it('returns empty list when PG returns no items', async () => {
    pgListResumesMock.mockResolvedValue([]);
    const res = await buildApp().request('/');
    const body = (await res.json()) as { resumes: unknown[]; count: number };
    expect(body.resumes).toHaveLength(0);
    expect(body.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /active
// ---------------------------------------------------------------------------

describe('GET /active — get active resume', () => {
  beforeEach(() => {
    pgGetActiveResumeMock.mockReset();
  });

  it('returns 200 with the active resume when one exists', async () => {
    pgGetActiveResumeMock.mockResolvedValue(PG_ACTIVE_RESUME);
    const res = await buildApp().request('/active');
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.resume['id']).toBe('active-uuid');
    expect(body.resume['isActive']).toBe(true);
  });

  it('includes the full contentJson payload in the active resume response', async () => {
    pgGetActiveResumeMock.mockResolvedValue(PG_ACTIVE_RESUME);
    const res = await buildApp().request('/active');
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(body.resume['contentJson']).toEqual({ basics: { name: 'Nelson Lamounier' } });
  });

  it('returns 404 when no active resume exists', async () => {
    pgGetActiveResumeMock.mockResolvedValue(null);
    const res = await buildApp().request('/active');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No active resume/);
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe('GET /:id — get resume by ID', () => {
  beforeEach(() => {
    pgGetResumeMock.mockReset();
  });

  it('returns 200 with full resume including contentJson', async () => {
    pgGetResumeMock.mockResolvedValue(PG_RESUME);
    const res = await buildApp().request('/resume-uuid-1');
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.resume['id']).toBe('resume-uuid-1');
    expect(body.resume['contentJson']).toEqual({ basics: { name: 'Nelson Lamounier' } });
  });

  it('calls getResume with the correct id', async () => {
    pgGetResumeMock.mockResolvedValue(PG_RESUME);
    await buildApp().request('/resume-uuid-1');
    expect(pgGetResumeMock).toHaveBeenCalledTimes(1);
    expect(pgGetResumeMock).toHaveBeenCalledWith(expect.anything(), 'resume-uuid-1');
  });

  it('returns 404 when resume does not exist', async () => {
    pgGetResumeMock.mockResolvedValue(null);
    const res = await buildApp().request('/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST / — create resume
// ---------------------------------------------------------------------------

describe('POST / — create resume', () => {
  beforeEach(() => {
    pgUpsertResumeMock.mockReset();
    pgUpsertResumeMock.mockResolvedValue(undefined);
    pgGetResumeMock.mockReset();
  });

  it('returns 201 with the created resume', async () => {
    // After upsert the route reads the resume back from PG.
    pgGetResumeMock.mockImplementation(async (_pool: unknown, id: unknown) => ({
      ...PG_RESUME,
      id: id as string,
      label: 'New CV 2026',
      contentJson: { basics: { name: 'Nelson' } },
    }));

    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New CV 2026', data: { basics: { name: 'Nelson' } } }),
    });
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(res.status).toBe(201);
    expect(body.resume['label']).toBe('New CV 2026');
    expect(body.resume['isActive']).toBe(false);
    expect(typeof body.resume['id']).toBe('string');
    expect(pgUpsertResumeMock).toHaveBeenCalledTimes(1);
  });

  it('upserts to PG with isActive: false', async () => {
    pgGetResumeMock.mockResolvedValue(PG_RESUME);
    await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Test', data: { version: 1 } }),
    });
    expect(pgUpsertResumeMock).toHaveBeenCalledTimes(1);
    const upsertArg = pgUpsertResumeMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(upsertArg['isActive']).toBe(false);
    expect(upsertArg['label']).toBe('Test');
    expect(upsertArg['contentJson']).toEqual({ version: 1 });
    expect(typeof upsertArg['id']).toBe('string');
  });

  it('returns 400 when label is missing', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { basics: {} } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/label/);
    expect(pgUpsertResumeMock).not.toHaveBeenCalled();
  });

  it('returns 400 when label is an empty string', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '   ', data: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when data is missing', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'CV' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/data/);
  });

  it('returns 400 when data is an array instead of an object', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'CV', data: ['not', 'an', 'object'] }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id — update resume
// ---------------------------------------------------------------------------

describe('PUT /:id — update resume', () => {
  beforeEach(() => {
    pgUpsertResumeMock.mockReset();
    pgUpsertResumeMock.mockResolvedValue(undefined);
    pgGetResumeMock.mockReset();
  });

  it('returns 200 with updated resume on success', async () => {
    pgGetResumeMock.mockResolvedValue(PG_RESUME);
    const res = await buildApp().request('/resume-uuid-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Updated Label' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resume: unknown };
    expect(body.resume).toBeDefined();
    expect(pgUpsertResumeMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when resume does not exist', async () => {
    pgGetResumeMock.mockResolvedValue(null);
    const res = await buildApp().request('/missing-id', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Whatever' }),
    });
    expect(res.status).toBe(404);
    expect(pgUpsertResumeMock).not.toHaveBeenCalled();
  });

  it('returns 400 when neither label nor data is provided', async () => {
    const res = await buildApp().request('/resume-uuid-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/label.*data|data.*label/i);
    expect(pgUpsertResumeMock).not.toHaveBeenCalled();
  });

  it('merges label from body over existing record', async () => {
    pgGetResumeMock.mockResolvedValue(PG_RESUME);
    await buildApp().request('/resume-uuid-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New Label' }),
    });
    const upsertArg = pgUpsertResumeMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(upsertArg['label']).toBe('New Label');
    expect(upsertArg['contentJson']).toEqual(PG_RESUME.contentJson);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete resume
// ---------------------------------------------------------------------------

describe('DELETE /:id — delete resume', () => {
  beforeEach(() => {
    pgGetResumeMock.mockReset();
    pgDeleteResumeMock.mockReset();
    pgDeleteResumeMock.mockResolvedValue(undefined);
  });

  it('returns 200 when resume exists and is not active', async () => {
    pgGetResumeMock.mockResolvedValue(PG_RESUME);
    const res = await buildApp().request('/resume-uuid-1', { method: 'DELETE' });
    const body = (await res.json()) as { deleted: boolean; resumeId: string };
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.resumeId).toBe('resume-uuid-1');
    expect(pgDeleteResumeMock).toHaveBeenCalledWith(expect.anything(), 'resume-uuid-1');
  });

  it('returns 404 when resume does not exist', async () => {
    pgGetResumeMock.mockResolvedValue(null);
    const res = await buildApp().request('/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(pgDeleteResumeMock).not.toHaveBeenCalled();
  });

  it('returns 409 when trying to delete the active resume', async () => {
    pgGetResumeMock.mockResolvedValue(PG_ACTIVE_RESUME);
    const res = await buildApp().request('/active-uuid', { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cannot delete the active resume/i);
    expect(pgDeleteResumeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/activate
// ---------------------------------------------------------------------------

describe('POST /:id/activate — activate resume', () => {
  beforeEach(() => {
    pgGetResumeMock.mockReset();
    pgGetActiveResumeMock.mockReset();
    pgSetActiveResumeMock.mockReset();
    pgSetActiveResumeMock.mockResolvedValue(undefined);
  });

  it('returns 404 when target resume does not exist', async () => {
    pgGetResumeMock.mockResolvedValue(null);
    const res = await buildApp().request('/missing/activate', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(pgSetActiveResumeMock).not.toHaveBeenCalled();
  });

  it('calls setActiveResume with the userId and target id', async () => {
    // setActiveResume's signature is (pool, userId, newActiveId) — RLS scopes
    // the FALSE-flip to the user's own rows, so the route only needs to know
    // *who* is activating, not which resume was previously active.
    pgGetResumeMock
      .mockResolvedValueOnce(PG_RESUME)
      .mockResolvedValueOnce({ ...PG_RESUME, isActive: true });
    pgGetActiveResumeMock.mockResolvedValue(PG_ACTIVE_RESUME);

    const res = await buildApp().request('/resume-uuid-1/activate', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(pgSetActiveResumeMock).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-sub',
      'resume-uuid-1',
    );
  });

  it('forwards the userId regardless of whether a resume is currently active', async () => {
    pgGetResumeMock
      .mockResolvedValueOnce(PG_RESUME)
      .mockResolvedValueOnce({ ...PG_RESUME, isActive: true });
    pgGetActiveResumeMock.mockResolvedValue(null);

    await buildApp().request('/resume-uuid-1/activate', { method: 'POST' });
    expect(pgSetActiveResumeMock).toHaveBeenCalledWith(
      expect.anything(),
      'test-user-sub',
      'resume-uuid-1',
    );
  });
});
