/**
 * @file config.ts
 * @description Runtime configuration for the public-api service.
 *
 * All values are sourced from environment variables injected by the
 * ``nextjs-config`` Kubernetes ConfigMap (via `envFrom.configMapRef`).
 * AWS credentials are NOT configured here — the default credential
 * provider chain resolves them automatically via the EC2 Instance Profile
 * (IMDS), which is attached to the node running this pod.
 *
 * @throws {Error} If any required environment variable is missing at startup.
 */

/** Validated, typed configuration for the public-api process. */
export interface Config {
  /** AWS region — sourced from AWS_DEFAULT_REGION (ConfigMap). */
  readonly awsRegion: string;
  /** DynamoDB content table name — sourced from ConfigMap. */
  readonly dynamoTableName: string;
  /** DynamoDB GSI1 index name for status+date queries. */
  readonly dynamoGsi1Name: string;
  /** DynamoDB GSI2 index name for tag+date queries. */
  readonly dynamoGsi2Name: string;
  /**
   * DynamoDB table for resume entities (Strategist table).
   * Sourced from STRATEGIST_TABLE_NAME env var.
   * Optional — if absent the /api/resumes/active endpoint returns 204.
   */
  readonly resumesTableName: string | undefined;
  /** TCP port the HTTP server binds to. */
  readonly port: number;
  /**
   * Bedrock chatbot API Gateway URL (e.g. https://id.execute-api.eu-west-1.amazonaws.com/v1/).
   * Sourced from BEDROCK_API_URL (ConfigMap).
   * Optional — if absent the /api/chatbot/invoke route returns 503.
   */
  readonly bedrockApiUrl: string | undefined;
  /**
   * Secrets Manager ARN for the Bedrock chatbot API key.
   * Sourced from BEDROCK_API_KEY_SECRET_ARN (ConfigMap).
   * The value is fetched at runtime via the EC2 instance profile — never
   * stored in ConfigMap or K8s Secrets (Gap S2).
   * Optional — if absent the /api/chatbot/invoke route returns 503.
   */
  readonly bedrockApiKeySecretArn: string | undefined;
}

/**
 * Loads and validates configuration from environment variables.
 *
 * Fails fast at startup if required variables are absent, preventing
 * silent misconfigurations at query time.
 *
 * @returns Frozen, validated {@link Config} object.
 * @throws {Error} If any required environment variable is not set.
 */
export function loadConfig(): Config {
  const required = [
    'AWS_DEFAULT_REGION',
    'DYNAMODB_TABLE_NAME',
    'DYNAMODB_GSI1_NAME',
    'DYNAMODB_GSI2_NAME',
  ] as const;

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[public-api] Missing required environment variables: ${missing.join(', ')}. ` +
        'Ensure the nextjs-config ConfigMap is mounted via envFrom.',
    );
  }

  return Object.freeze({
    awsRegion: process.env['AWS_DEFAULT_REGION'] as string,
    dynamoTableName: process.env['DYNAMODB_TABLE_NAME'] as string,
    dynamoGsi1Name: process.env['DYNAMODB_GSI1_NAME'] as string,
    dynamoGsi2Name: process.env['DYNAMODB_GSI2_NAME'] as string,
    resumesTableName: process.env['STRATEGIST_TABLE_NAME'] ?? undefined,
    port: parseInt(process.env['PORT'] ?? '3001', 10),
    bedrockApiUrl: process.env['BEDROCK_API_URL'] ?? undefined,
    bedrockApiKeySecretArn: process.env['BEDROCK_API_KEY_SECRET_ARN'] ?? undefined,
  });
}
