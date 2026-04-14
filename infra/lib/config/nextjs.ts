/**
 * @format
 * NextJS Project Configuration (Consolidated)
 *
 * Single source of truth for all Next.js project infrastructure configuration:
 * - Resource names and naming conventions
 * - Resource allocations (CPU, memory, scaling) by environment
 * - Resource configurations (throttles, timeouts, CORS) by environment
 * - Kubernetes deployment configurations by environment
 *
 * @example
 * ```typescript
 * import {
 *     getNextJsConfigs,
 *     getNextJsAllocations,
 *     getNextJsK8sConfig,
 *     nextjsResourceNames,
 *     DYNAMO_TABLE_STEM,
 * } from '../../config/nextjs';
 * ```
 */

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from './environments';

// =============================================================================
// ENVIRONMENT VARIABLE HELPER
// =============================================================================

/**
 * Read a value from process.env at synth time.
 * Returns undefined if the variable is not set.
 */
function fromEnv(key: string): string | undefined {
    return process.env[key] || undefined;
}

// =============================================================================
// RESOURCE NAMES
// =============================================================================

/** DynamoDB table name stem (used by DynamoDbTableConstruct) */
export const DYNAMO_TABLE_STEM = 'personal-portfolio';

/** S3 assets bucket purpose stem (used by S3BucketConstruct) */
export const ASSETS_BUCKET_STEM = 'article-assets';

// =============================================================================
// NEXTAUTH.JS COOKIE CONSTANTS
// =============================================================================

/**
 * Authentication cookies forwarded by CloudFront to the origin.
 *
 * CloudFront OriginRequestPolicy has a hard limit of **10 cookies**.
 *
 * This list contains cookies for two authentication systems:
 * - **Cognito PKCE** (start-admin) — `__session`, `oauth_state`, `pkce_verifier`
 * - **NextAuth.js v5** (retained for future use) — session, CSRF, callback cookies
 *
 * We include both `__Secure-`/`__Host-` prefixed variants (used when
 * the browser sees HTTPS) and non-prefixed variants (used when the
 * origin connection is HTTP — which is the case here because CloudFront
 * connects to Traefik via HTTP_ONLY).
 *
 * Removed (stale — no longer used by any app):
 * - `__Secure-authjs.pkce.code_verifier` / `authjs.pkce.code_verifier`
 * - `authjs.state`
 *
 * @see https://authjs.dev/getting-started/deployment#cookies
 */
export const AUTH_COOKIES = [
    // ── Active: Cognito PKCE (start-admin) ──────────────────────────
    '__session',                         // JWT access token
    'oauth_state',                       // PKCE state parameter
    'pkce_verifier',                     // PKCE code verifier
    // ── Retained: NextAuth.js session cookies (future use) ──────────
    '__Secure-authjs.session-token',     // Primary session token
    '__Host-authjs.csrf-token',          // CSRF protection
    'authjs.callback-url',              // OAuth callback URL
    '__Secure-authjs.callback-url',     // Secure variant
    'authjs.session-token',             // Non-secure session fallback
    'authjs.csrf-token',                // Non-secure CSRF fallback
    '__Secure-authjs.state',            // Retained as safety margin
] as const;

/**
 * Maximum number of cookies allowed in a CloudFront OriginRequestPolicy allowList.
 * AWS enforces a hard limit of 10 cookies per policy.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-origin-requests.html
 */
const MAX_CLOUDFRONT_COOKIES = 10;

/**
 * Validate AUTH_COOKIES at module load time.
 *
 * Guards against the three root causes of the CSRF regression:
 * 1. **Wildcard patterns** — CloudFront treats `*authjs*` as a literal string,
 *    not a glob, resulting in zero cookies forwarded.
 * 2. **Exceeding the 10-cookie limit** — AWS will reject the OriginRequestPolicy.
 * 3. **Duplicate entries** — waste cookie slots and indicate a copy-paste error.
 *
 * @throws Error if any validation fails (caught at `cdk synth` time)
 */
function validateAuthCookies(): void {
    // Rule 1: No wildcard characters
    const wildcardCookies = AUTH_COOKIES.filter(
        (c) => c.includes('*') || c.includes('?'),
    );
    if (wildcardCookies.length > 0) {
        throw new Error(
            `AUTH_COOKIES contains wildcard characters — CloudFront treats these as ` +
            `literal strings, not globs. Remove wildcards from: ${wildcardCookies.join(', ')}`,
        );
    }

    // Rule 2: Max 10 cookies (CloudFront hard limit)
    if (AUTH_COOKIES.length > MAX_CLOUDFRONT_COOKIES) {
        throw new Error(
            `AUTH_COOKIES has ${AUTH_COOKIES.length} entries but CloudFront ` +
            `OriginRequestPolicy allows a maximum of ${MAX_CLOUDFRONT_COOKIES}. ` +
            `Remove ${AUTH_COOKIES.length - MAX_CLOUDFRONT_COOKIES} cookie(s).`,
        );
    }

    // Rule 3: No duplicates
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const cookie of AUTH_COOKIES) {
        if (seen.has(cookie)) {
            duplicates.push(cookie);
        }
        seen.add(cookie);
    }
    if (duplicates.length > 0) {
        throw new Error(
            `AUTH_COOKIES contains duplicate entries: ${duplicates.join(', ')}. ` +
            `Each cookie name must be unique.`,
        );
    }
}

// Execute validation at module load time — fails during `cdk synth` if
// cookies are misconfigured, preventing a bad deploy from reaching AWS.
validateAuthCookies();

/**
 * Resolved resource names for a given environment.
 */
export interface NextjsResourceNames {
    /**
     * Full DynamoDB table name: `{namePrefix}-personal-portfolio-{env}`
     * Matches what DynamoDbTableConstruct creates internally.
     */
    readonly dynamoTableName: string;
    /**
     * Full S3 assets bucket name: `{namePrefix}-article-assets-{env}`
     * Matches what S3BucketConstruct creates.
     */
    readonly assetsBucketName: string;
}

/**
 * Build deterministic, fully-qualified resource names for a Next.js environment.
 * Use these for IAM ARN patterns in the factory / compute stack.
 *
 * @param namePrefix - Project name prefix (e.g. 'nextjs')
 * @param environment - Target deployment environment
 *
 * @example
 * ```typescript
 * const names = nextjsResourceNames('nextjs', Environment.DEVELOPMENT);
 * names.dynamoTableName  // 'nextjs-personal-portfolio-development'
 * names.assetsBucketName // 'nextjs-article-assets-development'
 * ```
 */
export function nextjsResourceNames(
    namePrefix: string,
    environment: Environment,
): NextjsResourceNames {
    return {
        dynamoTableName: `${namePrefix}-${DYNAMO_TABLE_STEM}-${environment}`,
        assetsBucketName: `${namePrefix}-${ASSETS_BUCKET_STEM}-${environment}`,
    };
}

// =============================================================================
// ALLOCATION TYPE DEFINITIONS
// =============================================================================

/**
 * Lambda function resource allocation
 */
export interface LambdaAllocation {
    readonly memoryMiB: number;
    readonly reservedConcurrency?: number;
}

/**
 * ECS task resource allocation
 */
export interface EcsAllocation {
    readonly cpu: number;
    readonly memoryMiB: number;
}

/**
 * ECS task definition allocation (includes security settings)
 */
export interface EcsTaskAllocation {
    readonly cpu: number;
    readonly memoryMiB: number;
    /** Tmpfs size for Next.js cache in MiB */
    readonly tmpfsSizeMiB: number;
    /** NOFILE ulimit (open file descriptors) */
    readonly nofileLimit: number;
    /** Graceful shutdown timeout in seconds */
    readonly stopTimeoutSeconds: number;
}

/**
 * Auto Scaling Group allocation
 */
export interface AsgAllocation {
    readonly minCapacity: number;
    readonly maxCapacity: number;
    readonly desiredCapacity?: number;
}

/**
 * DynamoDB allocation
 */
export interface DynamoDbAllocation {
    readonly readCapacity?: number;
    readonly writeCapacity?: number;
}

/**
 * ECS service auto-scaling allocation
 */
export interface ServiceScalingAllocation {
    /** Minimum number of tasks */
    readonly minCapacity: number;
    /** Maximum number of tasks */
    readonly maxCapacity: number;
    /** CPU utilization target for scaling (0-100) */
    readonly cpuTargetUtilizationPercent: number;
    /** Memory utilization target for scaling (0-100) */
    readonly memoryTargetUtilizationPercent: number;
}

/**
 * Complete resource allocations for NextJS project
 */
export interface NextJsAllocations {
    readonly lambda: LambdaAllocation;
    readonly ecs: EcsAllocation;
    readonly ecsTask: EcsTaskAllocation;
    readonly asg: AsgAllocation;
    readonly dynamodb: DynamoDbAllocation;
    readonly serviceScaling: ServiceScalingAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

/**
 * NextJS resource allocations by environment
 */
export const NEXTJS_ALLOCATIONS: Record<DeployableEnvironment, NextJsAllocations> = {
    [Environment.DEVELOPMENT]: {
        lambda: {
            memoryMiB: 256,
            reservedConcurrency: undefined, // No limit in dev
        },
        ecs: {
            cpu: 256,      // 0.25 vCPU
            memoryMiB: 512,
        },
        ecsTask: {
            cpu: 256,
            memoryMiB: 512,
            tmpfsSizeMiB: 128,
            nofileLimit: 65536,
            stopTimeoutSeconds: 30, // Faster turnover in dev
        },
        asg: {
            minCapacity: 1,
            maxCapacity: 2,
            desiredCapacity: 1,
        },
        dynamodb: {
            // On-demand billing (no capacity units)
        },
        serviceScaling: {
            minCapacity: 1,
            maxCapacity: 4,
            cpuTargetUtilizationPercent: 70,
            memoryTargetUtilizationPercent: 80,
        },
    },

    [Environment.STAGING]: {
        lambda: {
            memoryMiB: 512,
            reservedConcurrency: undefined,
        },
        ecs: {
            cpu: 512,      // 0.5 vCPU
            memoryMiB: 1024,
        },
        ecsTask: {
            cpu: 512,
            memoryMiB: 1024,
            tmpfsSizeMiB: 256,
            nofileLimit: 65536,
            stopTimeoutSeconds: 60,
        },
        asg: {
            minCapacity: 1,
            maxCapacity: 3,
            desiredCapacity: 1,
        },
        dynamodb: {
            // On-demand billing
        },
        serviceScaling: {
            minCapacity: 1,
            maxCapacity: 6,
            cpuTargetUtilizationPercent: 70,
            memoryTargetUtilizationPercent: 80,
        },
    },

    [Environment.PRODUCTION]: {
        lambda: {
            memoryMiB: 512,
            reservedConcurrency: 10, // Limit concurrency for cost control
        },
        ecs: {
            cpu: 512,      // 0.5 vCPU
            memoryMiB: 1024,
        },
        ecsTask: {
            cpu: 512,
            memoryMiB: 1024,
            tmpfsSizeMiB: 256,
            nofileLimit: 65536,
            stopTimeoutSeconds: 120, // More time for graceful shutdown in prod
        },
        asg: {
            minCapacity: 2,
            maxCapacity: 4,
            desiredCapacity: 2,
        },
        dynamodb: {
            // On-demand billing
        },
        serviceScaling: {
            minCapacity: 2,
            maxCapacity: 10,
            cpuTargetUtilizationPercent: 70,
            memoryTargetUtilizationPercent: 80,
        },
    },
};

// =============================================================================
// ALLOCATION HELPER FUNCTIONS
// =============================================================================

/**
 * Get NextJS allocations for an environment
 */
export function getNextJsAllocations(env: Environment): NextJsAllocations {
    return NEXTJS_ALLOCATIONS[env as DeployableEnvironment];
}

/**
 * Get Lambda allocation for an environment
 */
export function getLambdaAllocation(env: Environment): LambdaAllocation {
    return NEXTJS_ALLOCATIONS[env as DeployableEnvironment].lambda;
}

/**
 * Get ECS allocation for an environment
 */
export function getEcsAllocation(env: Environment): EcsAllocation {
    return NEXTJS_ALLOCATIONS[env as DeployableEnvironment].ecs;
}

/**
 * Get ECS task allocation for an environment
 */
export function getEcsTaskAllocation(env: Environment): EcsTaskAllocation {
    return NEXTJS_ALLOCATIONS[env as DeployableEnvironment].ecsTask;
}

// =============================================================================
// CONFIGURATION TYPE DEFINITIONS
// =============================================================================

/**
 * API Gateway throttling configuration
 */
export interface ThrottleConfig {
    readonly rateLimit: number;
    readonly burstLimit: number;
}

/**
 * CORS configuration
 */
export interface CorsConfig {
    readonly allowOrigins: readonly string[];
    readonly allowMethods: readonly string[];
    readonly allowHeaders: readonly string[];
    readonly allowCredentials: boolean;
    readonly maxAge: cdk.Duration;
}

/**
 * API Gateway configuration
 */
export interface ApiGatewayConfig {
    readonly throttle: ThrottleConfig;
    readonly stageName: string;
    readonly enableTracing: boolean;
    readonly enableDetailedMetrics: boolean;
    /** Enable KMS encryption for access logs */
    readonly enableLogEncryption: boolean;
}

/**
 * Lambda configuration
 */
export interface LambdaConfig {
    readonly timeout: cdk.Duration;
    readonly logLevel: string;
    readonly logRetention: logs.RetentionDays;
}

/**
 * DLQ configuration
 */
export interface DlqConfig {
    readonly retentionPeriod: cdk.Duration;
}

/**
 * ALB configuration
 */
export interface AlbConfig {
    readonly deletionProtection: boolean;
    readonly accessLogsEnabled: boolean;
}

/**
 * S3 configuration
 */
export interface S3Config {
    readonly versionExpirationDays: number;
    readonly enableIntelligentTiering: boolean;
    readonly corsOrigins: readonly string[];
}

/**
 * CloudFront cache TTL configuration
 */
export interface CacheTtlConfig {
    readonly default: cdk.Duration;
    readonly max: cdk.Duration;
    readonly min: cdk.Duration;
}

/**
 * CloudFront origin timeout configuration
 */
export interface OriginTimeoutConfig {
    readonly connectionAttempts: number;
    readonly connectionTimeout: cdk.Duration;
    readonly readTimeout: cdk.Duration;
    readonly keepaliveTimeout: cdk.Duration;
}

/**
 * CloudFront configuration
 */
export interface CloudFrontConfig {
    readonly priceClass: cloudfront.PriceClass;
    readonly minimumProtocolVersion: cloudfront.SecurityPolicyProtocol;
    readonly httpVersion: cloudfront.HttpVersion;
    readonly loggingEnabled: boolean;
    readonly staticAssetsTtl: CacheTtlConfig;
    readonly dynamicContentTtl: CacheTtlConfig;
    readonly noCacheTtl: CacheTtlConfig;
    readonly albOriginTimeouts: OriginTimeoutConfig;
    readonly errorResponseTtl: cdk.Duration;
    readonly cacheHeaders: {
        readonly dynamic: readonly string[];
        readonly api: readonly string[];
    };
    readonly originRequestHeaders: readonly string[];
    /**
     * Cookies forwarded to the origin for admin/auth routes.
     * NextAuth.js v5 uses these cookies for session management.
     */
    readonly adminCookies: readonly string[];
}

/**
 * ECS deployment strategy configuration
 */
export interface DeploymentConfig {
    /** Minimum healthy percent during deployments */
    readonly minHealthyPercent: number;
    /** Maximum healthy percent during deployments */
    readonly maxHealthyPercent: number;
}

/**
 * Container health check timing configuration
 */
export interface HealthCheckConfig {
    /** Interval between health checks in seconds */
    readonly intervalSeconds: number;
    /** Timeout for each health check in seconds */
    readonly timeoutSeconds: number;
    /** Number of consecutive failures before marking unhealthy */
    readonly retries: number;
    /** Grace period before health checks begin in seconds */
    readonly startPeriodSeconds: number;
}

/**
 * CloudWatch alarm threshold configuration
 */
export interface AlarmsConfig {
    /** Enable alarms */
    readonly enabled: boolean;
    /** CPU utilization threshold (0-100) */
    readonly cpuThreshold: number;
    /** Memory utilization threshold (0-100) */
    readonly memoryThreshold: number;
}

/**
 * ECS Task Definition configuration
 */
export interface EcsTaskConfig {
    /** Log retention days */
    readonly logRetention: logs.RetentionDays;
    /** Enable KMS encryption for logs */
    readonly enableLogEncryption: boolean;
    /** Enable init process for zombie reaping (HIGH-5) */
    readonly initProcessEnabled: boolean;
    /** Drop all Linux capabilities (HIGH-4) */
    readonly dropAllCapabilities: boolean;
    /** Use removal policy RETAIN for logs */
    readonly retainLogs: boolean;
    /** Enable deployment circuit breaker with automatic rollback */
    readonly enableCircuitBreaker: boolean;
    /** Deployment strategy (min/max healthy percent) */
    readonly deployment: DeploymentConfig;
    /** Container health check timing */
    readonly healthCheck: HealthCheckConfig;
    /** CloudWatch alarm thresholds */
    readonly alarms: AlarmsConfig;
}

/**
 * Complete resource configurations for NextJS project
 */
export interface NextJsConfigs {
    // =========================================================================
    // Synth-time context — Edge/CloudFront
    // =========================================================================

    /** Domain name for CloudFront distribution */
    readonly domainName?: string;
    /** Route53 Hosted Zone ID for DNS validation and alias records */
    readonly hostedZoneId?: string;
    /** Cross-account IAM role ARN for Route53 access */
    readonly crossAccountRoleArn?: string;

    // =========================================================================
    // Synth-time context — WAF Access Restriction (Pre-launch)
    //
    // Controls CloudFront IP allowlist for pre-launch access restriction.
    //
    // To go live: set RESTRICT_ACCESS to "false" in GitHub Environment
    // variables and re-run the pipeline. No code change, commit, or PR
    // needed — the WAF default action flips from BLOCK to ALLOW.
    //
    // To lock down again: set RESTRICT_ACCESS back to "true".
    //
    // GitHub Environment settings (Settings → Environments → development):
    //   Variable: RESTRICT_ACCESS = "true" | "false"
    //   Secret:   ALLOW_IPV4 = "<your-ipv4>/32"  (e.g., "203.0.113.42/32")
    //   Secret:   ALLOW_IPV6 = "<your-ipv6>/128" (e.g., "2a02:8084::/128")
    // =========================================================================

    /** Whether to restrict CloudFront access to allowlisted IPs only */
    readonly restrictAccess?: boolean;
    /** IPv4 address in CIDR notation to allowlist (e.g., "203.0.113.42/32") */
    readonly allowedIpv4?: string;
    /** IPv6 address in CIDR notation to allowlist (e.g., "2a02:8084::/128") */
    readonly allowedIpv6?: string;

    // =========================================================================
    // Synth-time context — Email/Secrets
    // =========================================================================

    /** Notification email for contact form submissions */
    readonly notificationEmail?: string;
    /** SES sender email address */
    readonly sesFromEmail?: string;
    /** Verification secret for email verification */
    readonly verificationSecret?: string;
    /** Base URL for email verification links */
    readonly verificationBaseUrl?: string;

    // =========================================================================
    // Resource behavior (policies, throttles, timeouts)
    // =========================================================================

    readonly apiGateway: ApiGatewayConfig;
    readonly lambda: LambdaConfig;
    readonly dlq: DlqConfig;
    readonly alb: AlbConfig;
    readonly s3: S3Config;
    readonly cors: CorsConfig;
    readonly cloudfront: CloudFrontConfig;
    readonly ecsTask: EcsTaskConfig;
    readonly isProduction: boolean;
    readonly removalPolicy: cdk.RemovalPolicy;
}

// =============================================================================
// CLOUDFRONT SHARED CONSTANTS
// =============================================================================

/**
 * CloudFront path patterns for Next.js
 */
export const CLOUDFRONT_PATH_PATTERNS = {
    nextjs: {
        static: '/_next/static/*',
        data: '/_next/data/*',
    },
    assets: {
        images: '/images/*',
        videos: '/videos/*',
        public: '/public/*',
    },
    api: '/api/*',
    /** Admin pages — caching disabled, cookies forwarded */
    admin: '/admin/*',
    /** Admin Backend API routes — caching disabled, cookies forwarded */
    adminApi: '/api/admin/*',
    /** NextAuth.js callback/session routes — caching disabled, cookies forwarded */
    authCallback: '/api/auth/*',
} as const;

/**
 * CloudFront error responses
 *
 * NOTE: 404 is intentionally excluded. CloudFront error response overrides
 * replace the ENTIRE response body — including JSON API responses — with
 * the HTML page at responsePagePath. This breaks any JSON API that
 * legitimately returns 404 (e.g. /api/auth/csrf when CSRF is disabled).
 * Next.js handles its own 404 pages natively via not-found.tsx.
 */
/** Shape of a CloudFront custom error response override */
interface CloudFrontErrorOverride {
    readonly httpStatus: number;
    readonly responseHttpStatus: number;
    readonly responsePagePath: string;
}

export const CLOUDFRONT_ERROR_RESPONSES: readonly CloudFrontErrorOverride[] = [
    // All status-code overrides removed.
    //
    // CloudFront error response overrides replace the ENTIRE response body —
    // including JSON API responses — with the HTML page at responsePagePath.
    // This breaks any JSON API that returns 4xx/5xx status codes (e.g.
    // /api/admin/articles/publish returning 500 on DynamoDB errors).
    // Next.js handles its own error pages natively via error.tsx / not-found.tsx.
];

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
//
// IMPORTANT: Configs are evaluated lazily (inside a function) so that fromEnv()
// reads process.env AFTER dotenv has loaded .env values. If these were a
// top-level constant, fromEnv() would execute at module import time — before
// dotenv.config() runs — resulting in empty values during local synth.
// =============================================================================

/**
 * Build NextJS resource configurations for all environments.
 * Called lazily to ensure process.env is populated by dotenv first.
 */
function buildNextJsConfigs(): Record<DeployableEnvironment, NextJsConfigs> {
    return {
    [Environment.DEVELOPMENT]: {
        // Synth-time context — Edge (env var > hardcoded default)
        domainName: fromEnv('DOMAIN_NAME') ?? 'dev.nelsonlamounier.com',
        hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
        crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),

        // WAF access restriction (env var at synth time)
        restrictAccess: fromEnv('RESTRICT_ACCESS') === 'true',
        allowedIpv4: fromEnv('ALLOW_IPV4'),
        allowedIpv6: fromEnv('ALLOW_IPV6'),

        // Synth-time context — Email (env var at synth time)
        notificationEmail: fromEnv('NOTIFICATION_EMAIL'),
        sesFromEmail: fromEnv('SES_FROM_EMAIL'),
        verificationSecret: fromEnv('VERIFICATION_SECRET'),
        verificationBaseUrl: fromEnv('VERIFICATION_BASE_URL'),

        // Resource behavior
        apiGateway: {
            throttle: { rateLimit: 100, burstLimit: 200 },
            stageName: 'api',
            enableTracing: true,
            enableDetailedMetrics: false,
            enableLogEncryption: false,  // KMS encryption disabled in dev (cost)
        },
        lambda: {
            timeout: cdk.Duration.seconds(30),
            logLevel: 'DEBUG',
            logRetention: logs.RetentionDays.ONE_MONTH,  // Increased from ONE_WEEK
        },
        dlq: {
            retentionPeriod: cdk.Duration.days(7),
        },
        alb: {
            deletionProtection: false,
            accessLogsEnabled: false,
        },
        s3: {
            versionExpirationDays: 7,
            enableIntelligentTiering: false,
            // Removed wildcard - use specific preview URLs
            corsOrigins: ['http://localhost:3000'],
        },
        cors: {
            // Removed wildcard - use specific preview URLs or configure dynamically
            allowOrigins: ['http://localhost:3000', 'https://nelsonlamounier.com'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
            allowCredentials: true,
            maxAge: cdk.Duration.hours(1),
        },
        cloudfront: {
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/Canada/Europe only
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            loggingEnabled: true,
            staticAssetsTtl: { default: cdk.Duration.days(365), max: cdk.Duration.days(365), min: cdk.Duration.days(1) },
            dynamicContentTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(300), min: cdk.Duration.seconds(0) },
            noCacheTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(0), min: cdk.Duration.seconds(0) },
            albOriginTimeouts: { connectionAttempts: 3, connectionTimeout: cdk.Duration.seconds(10), readTimeout: cdk.Duration.seconds(30), keepaliveTimeout: cdk.Duration.seconds(5) },
            errorResponseTtl: cdk.Duration.seconds(60),
            cacheHeaders: { dynamic: ['Accept', 'Accept-Language'], api: ['Accept', 'Accept-Language', 'Authorization', 'Content-Type'] },
            originRequestHeaders: ['Host', 'CloudFront-Viewer-Country', 'CloudFront-Is-Mobile-Viewer', 'CloudFront-Is-Desktop-Viewer', 'User-Agent', 'Content-Type', 'x-tsr-serverFn'],
            adminCookies: [...AUTH_COOKIES],
        },
        ecsTask: {
            logRetention: logs.RetentionDays.ONE_MONTH,
            enableLogEncryption: false,  // KMS disabled in dev for cost
            initProcessEnabled: true,    // Always enable for proper signal handling
            dropAllCapabilities: true,   // Always drop caps
            retainLogs: false,           // Can destroy in dev
            enableCircuitBreaker: false,  // Disabled in dev for faster iteration
            deployment: {
                minHealthyPercent: 0,    // t3.small ENI constraints — brief downtime ok
                maxHealthyPercent: 100,
            },
            healthCheck: {
                intervalSeconds: 30,
                timeoutSeconds: 5,
                retries: 3,
                startPeriodSeconds: 60,
            },
            alarms: {
                enabled: true,
                cpuThreshold: 80,
                memoryThreshold: 80,
            },
        },
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.STAGING]: {
        // Synth-time context — Edge (env var > hardcoded default)
        domainName: fromEnv('DOMAIN_NAME') ?? 'staging.nelsonlamounier.com',
        hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
        crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),

        // WAF access restriction (env var at synth time)
        restrictAccess: fromEnv('RESTRICT_ACCESS') === 'true',
        allowedIpv4: fromEnv('ALLOW_IPV4'),
        allowedIpv6: fromEnv('ALLOW_IPV6'),

        // Synth-time context — Email (env var at synth time)
        notificationEmail: fromEnv('NOTIFICATION_EMAIL'),
        sesFromEmail: fromEnv('SES_FROM_EMAIL'),
        verificationSecret: fromEnv('VERIFICATION_SECRET'),
        verificationBaseUrl: fromEnv('VERIFICATION_BASE_URL'),

        // Resource behavior
        apiGateway: {
            throttle: { rateLimit: 500, burstLimit: 1000 },
            stageName: 'api',
            enableTracing: true,
            enableDetailedMetrics: true,
            enableLogEncryption: true,
        },
        lambda: {
            timeout: cdk.Duration.seconds(30),
            logLevel: 'INFO',
            logRetention: logs.RetentionDays.THREE_MONTHS,
        },
        dlq: {
            retentionPeriod: cdk.Duration.days(14),
        },
        alb: {
            deletionProtection: false,
            accessLogsEnabled: true,
        },
        s3: {
            versionExpirationDays: 30,
            enableIntelligentTiering: false,
            corsOrigins: ['https://staging.nelsonlamounier.com'],
        },
        cors: {
            allowOrigins: ['https://staging.nelsonlamounier.com'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
            allowCredentials: true,
            maxAge: cdk.Duration.hours(1),
        },
        cloudfront: {
            priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // US/Canada/Europe/Asia
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            loggingEnabled: true,
            staticAssetsTtl: { default: cdk.Duration.days(365), max: cdk.Duration.days(365), min: cdk.Duration.days(1) },
            dynamicContentTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(300), min: cdk.Duration.seconds(0) },
            noCacheTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(0), min: cdk.Duration.seconds(0) },
            albOriginTimeouts: { connectionAttempts: 3, connectionTimeout: cdk.Duration.seconds(10), readTimeout: cdk.Duration.seconds(30), keepaliveTimeout: cdk.Duration.seconds(5) },
            errorResponseTtl: cdk.Duration.seconds(60),
            cacheHeaders: { dynamic: ['Accept', 'Accept-Language'], api: ['Accept', 'Accept-Language', 'Authorization', 'Content-Type'] },
            originRequestHeaders: ['Host', 'CloudFront-Viewer-Country', 'CloudFront-Is-Mobile-Viewer', 'CloudFront-Is-Desktop-Viewer', 'User-Agent', 'Content-Type', 'x-tsr-serverFn'],
            adminCookies: [...AUTH_COOKIES],
        },
        ecsTask: {
            logRetention: logs.RetentionDays.THREE_MONTHS,
            enableLogEncryption: true,   // KMS enabled
            initProcessEnabled: true,    // Always enable for proper signal handling
            dropAllCapabilities: true,   // Always drop caps
            retainLogs: true,            // Retain logs for staging
            enableCircuitBreaker: true,  // Catch bad deploys before prod
            deployment: {
                minHealthyPercent: 50,   // Keep tasks running during rolling deploy
                maxHealthyPercent: 100,
            },
            healthCheck: {
                intervalSeconds: 30,
                timeoutSeconds: 5,
                retries: 3,
                startPeriodSeconds: 90,  // Slightly more time for staging
            },
            alarms: {
                enabled: true,
                cpuThreshold: 80,
                memoryThreshold: 80,
            },
        },
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.PRODUCTION]: {
        // Synth-time context — Edge (env var > hardcoded default)
        domainName: fromEnv('DOMAIN_NAME') ?? 'nelsonlamounier.com',
        hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
        crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),

        // WAF access restriction (env var at synth time)
        restrictAccess: fromEnv('RESTRICT_ACCESS') === 'true',
        allowedIpv4: fromEnv('ALLOW_IPV4'),
        allowedIpv6: fromEnv('ALLOW_IPV6'),

        // Synth-time context — Email (env var at synth time)
        notificationEmail: fromEnv('NOTIFICATION_EMAIL'),
        sesFromEmail: fromEnv('SES_FROM_EMAIL'),
        verificationSecret: fromEnv('VERIFICATION_SECRET'),
        verificationBaseUrl: fromEnv('VERIFICATION_BASE_URL'),

        // Resource behavior
        apiGateway: {
            throttle: { rateLimit: 1000, burstLimit: 2000 },
            stageName: 'api',
            enableTracing: true,
            enableDetailedMetrics: true,
            enableLogEncryption: true,
        },
        lambda: {
            timeout: cdk.Duration.seconds(30),
            logLevel: 'INFO',
            logRetention: logs.RetentionDays.ONE_YEAR,  // Increased for compliance
        },
        dlq: {
            retentionPeriod: cdk.Duration.days(14),
        },
        alb: {
            deletionProtection: true,
            accessLogsEnabled: true,
        },
        s3: {
            versionExpirationDays: 90,
            enableIntelligentTiering: true,
            corsOrigins: ['https://nelsonlamounier.com'],
        },
        cors: {
            allowOrigins: ['https://nelsonlamounier.com'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
            allowCredentials: true,
            maxAge: cdk.Duration.hours(1),
        },
        cloudfront: {
            priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, // Global
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            loggingEnabled: true,
            staticAssetsTtl: { default: cdk.Duration.days(365), max: cdk.Duration.days(365), min: cdk.Duration.days(1) },
            dynamicContentTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(300), min: cdk.Duration.seconds(0) },
            noCacheTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(0), min: cdk.Duration.seconds(0) },
            albOriginTimeouts: { connectionAttempts: 3, connectionTimeout: cdk.Duration.seconds(10), readTimeout: cdk.Duration.seconds(30), keepaliveTimeout: cdk.Duration.seconds(5) },
            errorResponseTtl: cdk.Duration.seconds(60),
            cacheHeaders: { dynamic: ['Accept', 'Accept-Language'], api: ['Accept', 'Accept-Language', 'Authorization', 'Content-Type'] },
            originRequestHeaders: ['Host', 'CloudFront-Viewer-Country', 'CloudFront-Is-Mobile-Viewer', 'CloudFront-Is-Desktop-Viewer', 'User-Agent', 'Content-Type', 'x-tsr-serverFn'],
            adminCookies: [...AUTH_COOKIES],
        },
        ecsTask: {
            logRetention: logs.RetentionDays.ONE_YEAR,  // Compliance requirement
            enableLogEncryption: true,   // KMS enabled
            initProcessEnabled: true,    // Always enable for proper signal handling
            dropAllCapabilities: true,   // Always drop caps
            retainLogs: true,            // Never delete prod logs
            enableCircuitBreaker: true,  // Mandatory safety net in production
            deployment: {
                minHealthyPercent: 50,   // Zero-downtime rolling deployments
                maxHealthyPercent: 100,
            },
            healthCheck: {
                intervalSeconds: 30,
                timeoutSeconds: 5,
                retries: 3,
                startPeriodSeconds: 120, // More time for prod startup
            },
            alarms: {
                enabled: true,
                cpuThreshold: 80,
                memoryThreshold: 80,
            },
        },
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
};
}

// Memoised cache — built once on first access
let _cachedConfigs: Record<DeployableEnvironment, NextJsConfigs> | undefined;

// =============================================================================
// CONFIGURATION HELPER FUNCTIONS
// =============================================================================

/**
 * Get NextJS configurations for an environment.
 * Lazily evaluates fromEnv() on first call — ensures dotenv has loaded.
 */
export function getNextJsConfigs(env: Environment): NextJsConfigs {
    if (!_cachedConfigs) {
        _cachedConfigs = buildNextJsConfigs();
    }
    return _cachedConfigs[env as DeployableEnvironment];
}

/**
 * Get CloudFront log prefix for an environment
 */
export function getCloudFrontLogPrefix(envName: string): string {
    return `cloudfront-${envName}`;
}

// =============================================================================
// KUBERNETES DEPLOYMENT CONFIGURATION
// =============================================================================

/**
 * EC2 capacity type for cost optimization
 */
export type CapacityType = 'on-demand' | 'spot';

/**
 * K8s deployment configuration for the Next.js application node.
 *
 * The application node runs as a kubeadm worker that joins the existing
 * kubeadm cluster via the join token and CA hash.
 */
export interface NextJsK8sConfig {
    /** EC2 instance type for the application node */
    readonly instanceType: ec2.InstanceType;
    /** Capacity type (on-demand or spot) */
    readonly capacityType: CapacityType;
    /** Kubernetes node label for workload placement (observability, not exclusive) */
    readonly nodeLabel: string;
    /**
     * SSM parameter prefix of the kubeadm control plane cluster.
     * Used to discover the server URL and join token.
     * @example '/k8s/development'
     */
    readonly controlPlaneSsmPrefix: string;
    /** Whether to enable detailed CloudWatch monitoring */
    readonly detailedMonitoring: boolean;
    /** Whether to use CloudFormation signals for ASG */
    readonly useSignals: boolean;
    /** Timeout for CloudFormation signals in minutes */
    readonly signalsTimeoutMinutes: number;
    /** EBS root volume size in GB */
    readonly rootVolumeSizeGb: number;
    /** Whether this is a production environment */
    readonly isProduction: boolean;
}

/**
 * Next.js K8s configurations by environment
 */
export const NEXTJS_K8S_CONFIGS: Record<DeployableEnvironment, NextJsK8sConfig> = {
    [Environment.DEVELOPMENT]: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        capacityType: 'on-demand',
        nodeLabel: 'workload=frontend,environment=development',
        controlPlaneSsmPrefix: '/k8s/development',
        detailedMonitoring: false,
        useSignals: true,
        signalsTimeoutMinutes: 15,
        rootVolumeSizeGb: 30, // Must be >= Golden AMI snapshot size (30GB)
        isProduction: false,
    },

    [Environment.STAGING]: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        capacityType: 'on-demand',
        nodeLabel: 'workload=frontend,environment=staging',
        controlPlaneSsmPrefix: '/k8s/staging',
        detailedMonitoring: true,
        useSignals: true,
        signalsTimeoutMinutes: 15,
        rootVolumeSizeGb: 30, // Must be >= Golden AMI snapshot size (30GB)
        isProduction: false,
    },

    [Environment.PRODUCTION]: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        capacityType: 'on-demand', // Switch to reserved via AWS console/CLI after purchase
        nodeLabel: 'workload=frontend,environment=production',
        controlPlaneSsmPrefix: '/k8s/production',
        detailedMonitoring: true,
        useSignals: true,
        signalsTimeoutMinutes: 15,
        rootVolumeSizeGb: 30, // Must be >= Golden AMI snapshot size (30GB)
        isProduction: true,
    },
};

/**
 * Get Next.js K8s configuration for an environment
 */
export function getNextJsK8sConfig(env: Environment): NextJsK8sConfig {
    return NEXTJS_K8S_CONFIGS[env as DeployableEnvironment];
}
