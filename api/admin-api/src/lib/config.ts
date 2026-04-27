/**
 * @format
 * admin-api — Fail-fast environment variable validator.
 *
 * All values come from two Kubernetes resources managed by deploy.py:
 *   - `admin-api-secrets`  K8s Secret   (Cognito auth creds, API keys)
 *   - `admin-api-config`   K8s ConfigMap (bucket name, region, PG, K8s namespaces)
 *
 * AWS credentials are NEVER in this config — they come from the
 * EC2 Instance Profile (IMDS) via the AWS SDK v3 default credential chain.
 *
 * @throws {Error} On startup if any required variable is absent.
 */

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

  /** Container image for the ingestion worker (run-ingestion.js). */
  readonly ingestionImage: string;

  /** ServiceAccount the ingestion Job pod runs as. */
  readonly ingestionServiceAccount: string;

  /** Kubernetes namespace where article-pipeline Jobs are created. */
  readonly articlePipelineNamespace: string;

  /** Container image for the article pipeline runner. */
  readonly articlePipelineImage: string;

  /** ServiceAccount the article-pipeline Job pod runs as. */
  readonly articlePipelineServiceAccount: string;

  /** Kubernetes namespace where strategist-pipeline Jobs are created. */
  readonly strategistPipelineNamespace: string;

  /** Container image for the strategist pipeline runner. */
  readonly strategistPipelineImage: string;

  /** ServiceAccount the strategist-pipeline Job pod runs as. */
  readonly strategistPipelineServiceAccount: string;
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
    INGESTION_IMAGE: process.env['INGESTION_IMAGE'],
    ARTICLE_PIPELINE_IMAGE: process.env['ARTICLE_PIPELINE_IMAGE'],
    STRATEGIST_PIPELINE_IMAGE: process.env['STRATEGIST_PIPELINE_IMAGE'],
  };

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
    ingestionImage: required['INGESTION_IMAGE']!,
    ingestionServiceAccount: process.env['INGESTION_SERVICE_ACCOUNT'] ?? 'ingestion-sa',
    articlePipelineNamespace: process.env['ARTICLE_PIPELINE_NAMESPACE'] ?? 'article-pipeline',
    articlePipelineImage: required['ARTICLE_PIPELINE_IMAGE']!,
    articlePipelineServiceAccount: process.env['ARTICLE_PIPELINE_SERVICE_ACCOUNT'] ?? 'article-pipeline-sa',
    strategistPipelineNamespace: process.env['STRATEGIST_PIPELINE_NAMESPACE'] ?? 'job-strategist',
    strategistPipelineImage: required['STRATEGIST_PIPELINE_IMAGE']!,
    strategistPipelineServiceAccount: process.env['STRATEGIST_PIPELINE_SERVICE_ACCOUNT'] ?? 'job-strategist-sa',
  };
}
