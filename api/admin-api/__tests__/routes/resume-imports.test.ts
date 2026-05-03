/**
 * @format
 * Tests for POST /api/admin/resume-imports/:id/retry
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const createNamespacedJobMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

jest.unstable_mockModule('../../src/lib/k8s.js', () => ({
  getBatchApi:    () => ({ createNamespacedJob: createNamespacedJobMock }),
  _resetBatchApi: () => {},
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
  getPool:    () => ({}),
  _resetPool: () => {},
}));

const resetImportForRetryMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getJobImageMock         = jest.fn<() => string>();
const isImageConfiguredMock   = jest.fn<(s: string) => boolean>().mockReturnValue(true);

jest.unstable_mockModule('../../src/lib/repositories/career-history.js', () => ({
  resetImportForRetry:  resetImportForRetryMock,
  markUploadComplete:   jest.fn(),
  getResumeImport:      jest.fn(),
  listResumeImports:    jest.fn(),
  createResumeImport:   jest.fn(),
  countImportsThisMonth: jest.fn(),
  listCareerEntries:    jest.fn(),
  getCareerEntry:       jest.fn(),
  updateCareerEntry:    jest.fn(),
  deleteCareerEntry:    jest.fn(),
}));

jest.unstable_mockModule('../../src/lib/repositories/users.js', () => ({
  getUserPlanStatus: jest.fn(),
}));

jest.unstable_mockModule('../../src/lib/config.js', () => ({
  getJobImage:                getJobImageMock,
  isImageConfigured:          isImageConfiguredMock,
  isAssetsBucketConfigured:   jest.fn<(s: string) => boolean>().mockReturnValue(true),
  UNSET_IMAGE_SENTINEL:       'image-uri-not-yet-set',
}));

// ─── Dynamic imports after mocks ──────────────────────────────────────────────

const { Hono } = await import('hono');
const { createResumeImportsRouter } = await import('../../src/routes/resume-imports.js');

// ─── Test config ──────────────────────────────────────────────────────────────

const testConfig = {
  assetsBucketName:             'test-assets-bucket',
  cognitoUserPoolId:            'eu-west-1_TestPool',
  cognitoClientId:              'test-client-id',
  cognitoIssuerUrl:             'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  awsRegion:                    'eu-west-1',
  port:                         3002,
  pgHost:                       'pgbouncer.platform.svc.cluster.local',
  pgPort:                       5432,
  pgDatabase:                   'tucaken',
  pgUser:                       'postgres',
  pgPassword:                   'secret',
  resumeImportNamespace:        'resume-import',
  resumeImportServiceAccount:   'resume-import-sa',
} as const;

const VALID_IMPORT_ID = '00000000-0000-0000-0000-000000000001';
const TEST_USER_ID    = 'test-user';
const TEST_IMAGE      = '123456789.dkr.ecr.eu-west-1.amazonaws.com/resume-import-processor:abc123';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('userId', TEST_USER_ID);
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createResumeImportsRouter(testConfig as any));
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /:id/retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getJobImageMock.mockReturnValue(TEST_IMAGE);
    isImageConfiguredMock.mockReturnValue(true);
  });

  it('returns 202 and re-dispatches the Job when import is in failed state', async () => {
    const failedRecord = {
      id: VALID_IMPORT_ID, userId: TEST_USER_ID, status: 'queued',
      s3Key: 'resume-imports/test-user/file.pdf', contentType: 'application/pdf',
      originalFilename: 'cv.pdf', errorCode: null, statusMessage: null,
      currentStep: null, totalSteps: null, careerEntriesCreated: [],
      embeddingsCreatedCount: 0, createdAt: new Date().toISOString(),
    };
    resetImportForRetryMock.mockResolvedValueOnce(failedRecord);

    const app = buildApp();
    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });

    expect(res.status).toBe(202);
    const body = await res.json() as { importId: string; status: string };
    expect(body.importId).toBe(VALID_IMPORT_ID);
    expect(body.status).toBe('queued');
    expect(createNamespacedJobMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when import not found or not in failed state', async () => {
    resetImportForRetryMock.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 502 when image is not yet configured', async () => {
    const failedRecord = {
      id: VALID_IMPORT_ID, userId: TEST_USER_ID, status: 'queued',
      s3Key: 'resume-imports/test-user/file.pdf', contentType: 'application/pdf',
      originalFilename: 'cv.pdf', errorCode: null, statusMessage: null,
      currentStep: null, totalSteps: null, careerEntriesCreated: [],
      embeddingsCreatedCount: 0, createdAt: new Date().toISOString(),
    };
    resetImportForRetryMock.mockResolvedValueOnce(failedRecord);
    isImageConfiguredMock.mockReturnValue(false);

    const app = buildApp();
    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });

    expect(res.status).toBe(502);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 401 when request is unauthenticated', async () => {
    const app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.route('/', createResumeImportsRouter(testConfig as any));

    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
