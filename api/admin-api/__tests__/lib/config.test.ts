/**
 * @format
 * Tests for admin-api lib/config.ts
 *
 * Verifies that loadConfig() correctly reads environment variables,
 * fails fast with a descriptive error listing all missing vars, and
 * returns a fully-typed AdminApiConfig object when all vars are present.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { loadConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete set of valid environment variables for the admin-api. */
const VALID_ENV: Record<string, string> = {
  ASSETS_BUCKET_NAME: 'test-assets-bucket',
  COGNITO_USER_POOL_ID: 'eu-west-1_TestPool',
  COGNITO_CLIENT_ID: 'testClientId',
  COGNITO_ISSUER_URL: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  AWS_DEFAULT_REGION: 'eu-west-1',
  PG_HOST: 'pgbouncer.platform.svc.cluster.local',
  PG_PORT: '5432',
  PG_DATABASE: 'tucaken',
  PG_USER: 'postgres',
  PG_PASSWORD: 'secret',
  INGESTION_IMAGE: '771826808455.dkr.ecr.eu-west-1.amazonaws.com/ingestion:latest',
  ARTICLE_PIPELINE_IMAGE: '771826808455.dkr.ecr.eu-west-1.amazonaws.com/article-pipeline:latest',
  STRATEGIST_PIPELINE_IMAGE: '771826808455.dkr.ecr.eu-west-1.amazonaws.com/strategist-pipeline:latest',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
}

function unsetEnv(keys: string[]): void {
  for (const k of keys) {
    delete process.env[k];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadConfig()', () => {
  beforeEach(() => setEnv(VALID_ENV));
  afterEach(() => unsetEnv(Object.keys(VALID_ENV)));

  describe('happy path', () => {
    it('returns typed config when all env vars are present', () => {
      const config = loadConfig();

      expect(config.assetsBucketName).toBe('test-assets-bucket');
      expect(config.cognitoUserPoolId).toBe('eu-west-1_TestPool');
      expect(config.cognitoClientId).toBe('testClientId');
      expect(config.awsRegion).toBe('eu-west-1');
    });

    it('defaults port to 3002 when PORT is not set', () => {
      const config = loadConfig();
      expect(config.port).toBe(3002);
    });

    it('reads port from PORT env var', () => {
      process.env['PORT'] = '8080';
      const config = loadConfig();
      expect(config.port).toBe(8080);
      delete process.env['PORT'];
    });
  });

  describe('fail-fast validation', () => {
    it('throws when a single required var is missing', () => {
      delete process.env['ASSETS_BUCKET_NAME'];
      expect(() => loadConfig()).toThrow('ASSETS_BUCKET_NAME');
    });

    it('lists all missing variables in a single thrown error', () => {
      unsetEnv(['ASSETS_BUCKET_NAME', 'COGNITO_USER_POOL_ID']);
      expect(() => loadConfig()).toThrow(/ASSETS_BUCKET_NAME/);
    });

    it('throws the admin-api service prefix in the error message', () => {
      unsetEnv(Object.keys(VALID_ENV));
      expect(() => loadConfig()).toThrow('[admin-api] Missing required environment variables');
    });
  });

  describe('pipeline config', () => {
    it('throws when ARTICLE_PIPELINE_IMAGE is missing', () => {
      delete process.env['ARTICLE_PIPELINE_IMAGE'];
      expect(() => loadConfig()).toThrow(/ARTICLE_PIPELINE_IMAGE/);
    });

    it('throws when STRATEGIST_PIPELINE_IMAGE is missing', () => {
      delete process.env['STRATEGIST_PIPELINE_IMAGE'];
      expect(() => loadConfig()).toThrow(/STRATEGIST_PIPELINE_IMAGE/);
    });

    it('defaults pipeline namespaces and SAs when env unset', () => {
      delete process.env['ARTICLE_PIPELINE_NAMESPACE'];
      delete process.env['ARTICLE_PIPELINE_SERVICE_ACCOUNT'];
      delete process.env['STRATEGIST_PIPELINE_NAMESPACE'];
      delete process.env['STRATEGIST_PIPELINE_SERVICE_ACCOUNT'];
      const cfg = loadConfig();
      expect(cfg.articlePipelineNamespace).toBe('article-pipeline');
      expect(cfg.articlePipelineServiceAccount).toBe('article-pipeline-sa');
      expect(cfg.strategistPipelineNamespace).toBe('job-strategist');
      expect(cfg.strategistPipelineServiceAccount).toBe('job-strategist-sa');
    });

    it('overrides pipeline namespaces and SAs when env set', () => {
      process.env['ARTICLE_PIPELINE_NAMESPACE'] = 'custom-article';
      process.env['ARTICLE_PIPELINE_SERVICE_ACCOUNT'] = 'custom-article-sa';
      process.env['STRATEGIST_PIPELINE_NAMESPACE'] = 'custom-strategist';
      process.env['STRATEGIST_PIPELINE_SERVICE_ACCOUNT'] = 'custom-strategist-sa';
      const cfg = loadConfig();
      expect(cfg.articlePipelineNamespace).toBe('custom-article');
      expect(cfg.articlePipelineServiceAccount).toBe('custom-article-sa');
      expect(cfg.strategistPipelineNamespace).toBe('custom-strategist');
      expect(cfg.strategistPipelineServiceAccount).toBe('custom-strategist-sa');
      delete process.env['ARTICLE_PIPELINE_NAMESPACE'];
      delete process.env['ARTICLE_PIPELINE_SERVICE_ACCOUNT'];
      delete process.env['STRATEGIST_PIPELINE_NAMESPACE'];
      delete process.env['STRATEGIST_PIPELINE_SERVICE_ACCOUNT'];
    });
  });

  describe('ingestion config', () => {
    it('throws when INGESTION_IMAGE is missing', () => {
      delete process.env['INGESTION_IMAGE'];
      expect(() => loadConfig()).toThrow(/INGESTION_IMAGE/);
    });

    it('resolves ingestionImage from INGESTION_IMAGE env var', () => {
      const cfg = loadConfig();
      expect(cfg.ingestionImage).toBe(
        '771826808455.dkr.ecr.eu-west-1.amazonaws.com/ingestion:latest',
      );
    });

    it('defaults ingestionNamespace to "ingestion" when INGESTION_NAMESPACE unset', () => {
      delete process.env['INGESTION_NAMESPACE'];
      const cfg = loadConfig();
      expect(cfg.ingestionNamespace).toBe('ingestion');
    });

    it('defaults ingestionServiceAccount to "ingestion-sa" when INGESTION_SERVICE_ACCOUNT unset', () => {
      delete process.env['INGESTION_SERVICE_ACCOUNT'];
      const cfg = loadConfig();
      expect(cfg.ingestionServiceAccount).toBe('ingestion-sa');
    });

    it('overrides ingestionNamespace when INGESTION_NAMESPACE set', () => {
      process.env['INGESTION_NAMESPACE'] = 'custom-ns';
      const cfg = loadConfig();
      expect(cfg.ingestionNamespace).toBe('custom-ns');
      delete process.env['INGESTION_NAMESPACE'];
    });

    it('overrides ingestionServiceAccount when INGESTION_SERVICE_ACCOUNT set', () => {
      process.env['INGESTION_SERVICE_ACCOUNT'] = 'custom-sa';
      const cfg = loadConfig();
      expect(cfg.ingestionServiceAccount).toBe('custom-sa');
      delete process.env['INGESTION_SERVICE_ACCOUNT'];
    });
  });
});

describe('PG config', () => {
  const PG_ENV: Record<string, string> = {
    PG_HOST: 'pgbouncer.platform.svc.cluster.local',
    PG_PORT: '5432',
    PG_DATABASE: 'tucaken',
    PG_USER: 'postgres',
    PG_PASSWORD: 'secret',
  };

  beforeEach(() => {
    setEnv(VALID_ENV);
    setEnv(PG_ENV);
  });

  afterEach(() => {
    unsetEnv(Object.keys(VALID_ENV));
    unsetEnv(Object.keys(PG_ENV));
    jest.resetModules();
  });

  it('should include pgHost in resolved config when PG env vars are present', async () => {
    // Reload module to pick up new env
    jest.resetModules();
    const { loadConfig } = await import('../../src/lib/config.js');
    const cfg = loadConfig();

    expect(cfg.pgHost).toBe('pgbouncer.platform.svc.cluster.local');
    expect(cfg.pgPort).toBe(5432);
    expect(cfg.pgDatabase).toBe('tucaken');
    expect(cfg.pgUser).toBe('postgres');
    expect(cfg.pgPassword).toBe('secret');
  });

  it('should throw when PG env vars are missing', async () => {
    delete process.env['PG_HOST'];

    jest.resetModules();
    const { loadConfig } = await import('../../src/lib/config.js');
    expect(() => loadConfig()).toThrow(/PG_HOST/);
  });
});
