/**
 * @format
 * admin-api — Fail-fast environment variable validator + dynamic Job-image resolver.
 *
 * Static values come from K8s resources at startup:
 *   - `admin-api-secrets`        ESO-synced Secret  (Cognito auth, SSM-sourced refs)
 *   - `platform-rds-credentials` ESO-synced Secret  (PG_HOST/PORT/DATABASE/USER/PASSWORD)
 *   - Helm-templated env block on the Rollout       (K8s namespace + SA names,
 *                                                    JOB_IMAGES_DIR pointer)
 *
 * Dynamic values (the 3 K8s Job image URIs) come from FILES synced by ESO
 * from SSM (/k8s/{env}/job-images/{ingestion,article-pipeline,job-strategist}).
 * The K8s Secret 'admin-api-job-images' is mounted as a directory whose files
 * the kubelet auto-updates when the upstream Secret rotates (~60s). admin-api
 * re-reads on each Job-creation request (with a small in-process TTL cache so
 * sustained traffic doesn't hit disk per request) — pushing a new ingestion
 * image therefore does NOT trigger an admin-api Rollout.
 *
 * AWS SDK credentials are NEVER in this config — they come from the
 * EC2 Instance Profile (IMDS) via the AWS SDK v3 default credential chain.
 *
 * @throws {Error} On startup if any required variable is absent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sentinel returned by getJobImage() when the URI cannot be resolved
 * (file missing AND env var fallback unset). Routes guard with
 * isImageConfigured() and return 502 instead of creating a Job that
 * would CrashLoopBackOff on ImagePullBackOff.
 */
export const UNSET_IMAGE_SENTINEL = 'image-uri-not-yet-set';

/** Returns true if the URI is a real `<repo>:<tag>` pullable reference. */
export function isImageConfigured(uri: string): boolean {
  return uri.length > 0 && uri !== UNSET_IMAGE_SENTINEL && !uri.endsWith(':');
}

/** The 3 logical images admin-api may launch as Jobs. */
export type JobImageName = 'ingestion' | 'article-pipeline' | 'job-strategist';

/**
 * Mapping from logical image name to the env var that holds the URI in
 * local-dev or test environments where no Secret is mounted. The chart
 * does NOT set these on the pod — production resolution always goes
 * through the file mount.
 */
const ENV_FALLBACK: Record<JobImageName, string> = {
    'ingestion':         'INGESTION_IMAGE',
    'article-pipeline':  'ARTICLE_PIPELINE_IMAGE',
    'job-strategist':    'STRATEGIST_PIPELINE_IMAGE',
};

/** TTL for the in-process cache of resolved URIs. */
const JOB_IMAGE_CACHE_TTL_MS = 30_000;

interface CachedImage {
    uri:      string;
    expires:  number;
}

const _imageCache: Map<JobImageName, CachedImage> = new Map();

/**
 * Resolve a Job image URI by name. Reads from the file mount first, then
 * falls back to the corresponding env var (local dev), then to the unset
 * sentinel. Caches the result for {@link JOB_IMAGE_CACHE_TTL_MS}.
 *
 * The mount root is taken from JOB_IMAGES_DIR (set by the Helm chart,
 * default /etc/admin-api/images). Each filename inside is the ESO
 * secretKey: 'ingestion', 'article-pipeline', 'job-strategist'.
 *
 * @param name Logical image identifier.
 * @returns Full <repo>:<tag> URI, or UNSET_IMAGE_SENTINEL if unresolved.
 */
export function getJobImage(name: JobImageName): string {
    const cached = _imageCache.get(name);
    const now = Date.now();
    if (cached && cached.expires > now) return cached.uri;

    const dir = process.env['JOB_IMAGES_DIR'] ?? '/etc/admin-api/images';
    let uri = UNSET_IMAGE_SENTINEL;

    try {
        const file = path.join(dir, name);
        const value = fs.readFileSync(file, 'utf8').trim();
        if (value.length > 0) uri = value;
    } catch {
        // File missing — fall through to env fallback (local dev).
    }

    if (uri === UNSET_IMAGE_SENTINEL) {
        const envValue = process.env[ENV_FALLBACK[name]];
        if (envValue && envValue.length > 0) uri = envValue;
    }

    _imageCache.set(name, { uri, expires: now + JOB_IMAGE_CACHE_TTL_MS });
    return uri;
}

/** Test helper — flush the in-process cache so tests see fresh fs reads. */
export function _resetJobImageCache(): void {
    _imageCache.clear();
}

/** Resolved, strongly-typed application configuration. */
export interface AdminApiConfig {
  /** S3 assets bucket name for media uploads. */
  readonly assetsBucketName: string;

  /** Cognito User Pool ID — used for JWKS URL construction. */
  readonly cognitoUserPoolId: string;

  /** Cognito app client ID — validated in JWT `aud` claim. */
  readonly cognitoClientId: string;

  /** Cognito issuer URL — full URL without trailing slash. */
  readonly cognitoIssuerUrl: string;

  /** AWS region (from ConfigMap — never a credential). */
  readonly awsRegion: string;

  /** HTTP port the server binds on. */
  readonly port: number;

  /** PgBouncer host — cluster-internal DNS. */
  readonly pgHost: string;
  /** PgBouncer port. */
  readonly pgPort: number;
  /** PostgreSQL database name. */
  readonly pgDatabase: string;
  /** PostgreSQL user. */
  readonly pgUser: string;
  /** PostgreSQL password (from Secrets Manager via ESO). */
  readonly pgPassword: string;

  /** Kubernetes namespace where ingestion Jobs are created. */
  readonly ingestionNamespace: string;

  /** ServiceAccount the ingestion Job pod runs as. */
  readonly ingestionServiceAccount: string;

  /** Kubernetes namespace where article-pipeline Jobs are created. */
  readonly articlePipelineNamespace: string;

  /** ServiceAccount the article-pipeline Job pod runs as. */
  readonly articlePipelineServiceAccount: string;

  /** Kubernetes namespace where strategist-pipeline Jobs are created. */
  readonly strategistPipelineNamespace: string;

  /** ServiceAccount the strategist-pipeline Job pod runs as. */
  readonly strategistPipelineServiceAccount: string;

  // Note: image URIs are NOT in this config object. Use getJobImage(name)
  // from this same module — it reads from the file mount on each call (with
  // a 30s cache) so a Secret rotation by ESO is picked up without restart.
}

/**
 * Load and validate all required environment variables at startup.
 *
 * Throws a descriptive error listing every missing variable
 * so ops can fix the ConfigMap/Secret in a single deploy cycle.
 *
 * @returns Validated, typed configuration object.
 * @throws {Error} If one or more required variables are missing.
 */
export function loadConfig(): AdminApiConfig {
  const required: Record<string, string | undefined> = {
    ASSETS_BUCKET_NAME: process.env['ASSETS_BUCKET_NAME'],
    COGNITO_USER_POOL_ID: process.env['COGNITO_USER_POOL_ID'],
    COGNITO_CLIENT_ID: process.env['COGNITO_CLIENT_ID'],
    COGNITO_ISSUER_URL: process.env['COGNITO_ISSUER_URL'],
    AWS_DEFAULT_REGION: process.env['AWS_DEFAULT_REGION'],
    PG_HOST: process.env['PG_HOST'],
    PG_PORT: process.env['PG_PORT'],
    PG_DATABASE: process.env['PG_DATABASE'],
    PG_USER: process.env['PG_USER'],
    PG_PASSWORD: process.env['PG_PASSWORD'],
  };

  // Job-image URIs are NOT loaded at startup — see header docblock.
  // Routes call getJobImage(name) which reads from /etc/admin-api/images/{name}
  // (kubelet-synced from the admin-api-job-images ESO Secret) with a 30s cache.

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `[admin-api] Missing required environment variables:\n  ${missing.join('\n  ')}\n` +
      `These are injected via ConfigMap (admin-api-config) and Secret (admin-api-secrets).`,
    );
  }

  return {
    assetsBucketName: required['ASSETS_BUCKET_NAME']!,
    cognitoUserPoolId: required['COGNITO_USER_POOL_ID']!,
    cognitoClientId: required['COGNITO_CLIENT_ID']!,
    cognitoIssuerUrl: required['COGNITO_ISSUER_URL']!,
    awsRegion: required['AWS_DEFAULT_REGION']!,
    port: parseInt(process.env['PORT'] ?? '3002', 10),
    pgHost: required['PG_HOST']!,
    pgPort: parseInt(required['PG_PORT']!, 10),
    pgDatabase: required['PG_DATABASE']!,
    pgUser: required['PG_USER']!,
    pgPassword: required['PG_PASSWORD']!,
    ingestionNamespace: process.env['INGESTION_NAMESPACE'] ?? 'ingestion',
    ingestionServiceAccount: process.env['INGESTION_SERVICE_ACCOUNT'] ?? 'ingestion-sa',
    articlePipelineNamespace: process.env['ARTICLE_PIPELINE_NAMESPACE'] ?? 'article-pipeline',
    articlePipelineServiceAccount: process.env['ARTICLE_PIPELINE_SERVICE_ACCOUNT'] ?? 'article-pipeline-sa',
    strategistPipelineNamespace: process.env['STRATEGIST_PIPELINE_NAMESPACE'] ?? 'job-strategist',
    strategistPipelineServiceAccount: process.env['STRATEGIST_PIPELINE_SERVICE_ACCOUNT'] ?? 'job-strategist-sa',
  };
}
