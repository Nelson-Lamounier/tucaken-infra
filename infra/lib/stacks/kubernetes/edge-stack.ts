/**
 * @format
 * Kubernetes Edge Stack - Global CDN and Edge Security
 *
 * Consolidated edge infrastructure for the K8s-hosted Next.js application.
 * **MUST be deployed in us-east-1** (CloudFront + WAF requirement).
 *
 * ## Traffic Flow
 * ```
 * User → CloudFront (HTTPS) → Elastic IP (HTTP) → Traefik → Next.js pod
 *        └── Certificate: nelsonlamounier.com
 *
 * NOTE: CloudFront→EIP uses HTTP because Traefik's Let's Encrypt cert
 *       covers ops.nelsonlamounier.com only, not the main domain.
 * ```
 *
 * ## Resources Created
 * 1. **ACM Certificate** - SSL/TLS with cross-account DNS validation
 * 2. **WAF WebACL** - CloudFront protection with AWS managed rules
 * 3. **CloudFront Distribution** - CDN with dual-origin (EIP + S3)
 * 4. **DNS Alias Record** - Route 53 A record → CloudFront
 *
 * ## Cross-Region Architecture
 * - Edge Stack: us-east-1 (CloudFront, WAF, ACM edge cert)
 * - Compute Stack: eu-west-1 (EC2 kubeadm + Elastic IP)
 *
 * ## Deployment Ordering (Day-1 Safety)
 * EdgeStack reads EIP and bucket-name SSM parameters from eu-west-1.
 * The CI/CD pipeline guarantees these exist before EdgeStack deploys via
 * a transitive dependency chain:
 *
 *   deploy-data → deploy-base (writes EIP + bucket SSM)
 *               → sync-bootstrap → deploy-compute
 *                                → deploy-appiam
 *                                → deploy-edge  ← reads SSM here
 *
 * If this ordering is ever broken (e.g. parallelising edge with base),
 * the AwsCustomResource SSM readers will fail with ParameterNotFound.
 *
 * ## Origin Architecture
 * - EIP origin (Traefik Ingress handles routing)
 * - Reads EIP from SSM (no ALB)
 * - S3 origin for static assets
 */

import { NagSuppressions } from 'cdk-nag';

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import {
    getNextJsConfigs,
    getCloudFrontLogPrefix,
    CLOUDFRONT_PATH_PATTERNS,
    CLOUDFRONT_ERROR_RESPONSES,
} from '../../config/nextjs';
import { k8sSsmPaths, nextjsSsmPaths, bedrockSsmPaths } from '../../config/ssm-paths';
import { LambdaFunctionConstruct } from '../../constructs/compute';
import { CloudFrontConstruct } from '../../constructs/networking/cloudfront';
import { AcmCertificateDnsValidationConstruct } from '../../constructs/security/acm-certificate';
import { WafWebAclConstruct } from '../../constructs/security/waf-web-acl';

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Configuration props for KubernetesEdgeStack.
 *
 * @example
 * ```typescript
 * const edgeStack = new KubernetesEdgeStack(app, 'Edge', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     domainName: 'dev.example.com',
 *     hostedZoneId: 'Z123ABC',
 *     crossAccountRoleArn: 'arn:aws:iam::ROOT:role/Route53Role',
 *     eipSsmPath: '/k8s/development/elastic-ip',
 *     assetsBucketSsmPath: '/nextjs/development/assets-bucket-name',
 *     env: { region: 'us-east-1' }, // Required!
 * });
 * ```
 */
export interface KubernetesEdgeStackProps extends cdk.StackProps {
    // =========================================================================
    // Required Props
    // =========================================================================

    /** Target deployment environment (development/staging/production) */
    readonly targetEnvironment: Environment;

    /** Primary domain for SSL certificate (e.g., `dev.example.com`) */
    readonly domainName: string;

    /** Route 53 Hosted Zone ID in root account for DNS validation */
    readonly hostedZoneId: string;

    /** IAM role ARN in root account for cross-account Route 53 access */
    readonly crossAccountRoleArn: string;

    /** SSM parameter path for Elastic IP address (read cross-region) */
    readonly eipSsmPath: string;

    /** Region where the EIP SSM parameter is stored @default 'eu-west-1' */
    readonly eipSsmRegion?: string;

    /** SSM parameter path for S3 assets bucket name (read cross-region) */
    readonly assetsBucketSsmPath: string;

    /** Region where the assets bucket SSM parameter is stored @default 'eu-west-1' */
    readonly assetsBucketSsmRegion?: string;

    // =========================================================================
    // Optional Props
    // =========================================================================

    /** Additional domains for certificate SANs (e.g., `['www.example.com']`) */
    readonly subjectAlternativeNames?: string[];

    /** WAF rate limit per IP per 5 minutes @default 5000 */
    readonly rateLimitPerIp?: number;

    /** Enable AWS IP reputation list in WAF @default true */
    readonly enableIpReputationList?: boolean;

    /** Enable WAF rate limiting @default true */
    readonly enableRateLimiting?: boolean;

    /** Enable CloudFront access logging @default from config */
    readonly enableLogging?: boolean;

    /** Create Route 53 alias A record for CloudFront @default true */
    readonly createDnsRecords?: boolean;

    /** Resource name prefix @default 'k8s' */
    readonly namePrefix?: string;

    /**
     * Whether to restrict CloudFront access to allowlisted IPs only.
     * When true, only IPs in allowedIps/allowedIpv6s can reach the site.
     * All other traffic is blocked at the CloudFront edge.
     *
     * To go live: set RESTRICT_ACCESS=false in GitHub Environment variables
     * and re-run the pipeline. No code change, commit, or PR needed.
     *
     * @default false
     */
    readonly restrictAccess?: boolean;

    /**
     * IPv4 addresses allowed to access the site when restrictAccess is enabled.
     * CIDR notation (e.g., `['203.0.113.42/32']`).
     * @default []
     */
    readonly allowedIps?: string[];

    /**
     * IPv6 addresses allowed to access the site when restrictAccess is enabled.
     * CIDR notation (e.g., `['2a02:8084::/32']`).
     * @default []
     */
    readonly allowedIpv6s?: string[];

    /**
     * Subdomain prefix for admin services (e.g., 'ops').
     * Creates an A record (ops.domain.com) pointing to the EIP for
     * Traefik-managed HTTPS access to Grafana, Prometheus, ArgoCD.
     */
    readonly opsSubdomain?: string;

    /**
     * Root domain (e.g., 'nelsonlamounier.com') for the ops A record.
     * Required when opsSubdomain is set.
     */
    readonly baseDomain?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * KubernetesEdgeStack - Edge infrastructure for K8s-hosted application
 *
 * IMPORTANT: This stack MUST be deployed in us-east-1 because:
 * - CloudFront requires ACM certificates in us-east-1
 * - WAF for CloudFront must have CLOUDFRONT scope (us-east-1)
 *
 * Creates:
 * 1. ACM Certificate with cross-account DNS validation
 * 2. WAF Web ACL with AWS Managed Rules
 * 3. CloudFront Distribution with dual-origin (EIP + S3)
 */
export class KubernetesEdgeStack extends cdk.Stack {
    // ACM Certificate
    public readonly certificateArn: string;
    public readonly certificate: acm.ICertificate;
    public readonly validationLambda: LambdaFunctionConstruct;

    // WAF
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly webAclArn: string;

    // CloudFront
    public readonly distribution: CloudFrontConstruct;

    // Environment
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: KubernetesEdgeStackProps) {
        super(scope, id, {
            ...props,
            description: `K8s Edge infrastructure (ACM + WAF + CloudFront) for ${props.namePrefix ?? 'k8s'}`,
        });

        this.targetEnvironment = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'k8s';
        const envName = props.targetEnvironment;

        // =====================================================================
        // VALIDATION
        // =====================================================================
        if (props.env?.region && props.env.region !== 'us-east-1') {
            throw new Error(
                `Edge stack MUST be deployed in us-east-1. Got: ${props.env.region}`
            );
        }
        if (this.region !== 'us-east-1') {
            cdk.Annotations.of(this).addError(
                'Edge stack MUST be deployed in us-east-1 region.\n' +
                `Current region: ${this.region}`
            );
        }

        // Soft-fail: allow synth to complete for CI validation and non-edge deploys.
        // These values are required at DEPLOY time (provided via GitHub Environment
        // secrets/vars) but not needed for synthesis validation.
        if (!props.domainName) {
            cdk.Annotations.of(this).addWarning('domainName is required for Edge stack deployment');
        }
        if (!props.hostedZoneId) {
            cdk.Annotations.of(this).addWarning('hostedZoneId is required for Edge stack deployment');
        }
        if (!props.crossAccountRoleArn) {
            cdk.Annotations.of(this).addWarning('crossAccountRoleArn is required for cross-account DNS');
        }

        // =====================================================================
        // CONFIGURATION
        // =====================================================================
        const configs = getNextJsConfigs(props.targetEnvironment);
        const cfConfig = configs.cloudfront;
        const logPrefix = getCloudFrontLogPrefix(envName);
        const allDomains = [props.domainName, ...(props.subjectAlternativeNames ?? [])];
        const loggingEnabled = props.enableLogging ?? cfConfig.loggingEnabled;

        // Environment-aware removal policy for log groups.
        // Development: DESTROY — prevent orphaned log groups on stack deletion.
        // Staging/Production: RETAIN — preserve logs for audit trail.
        const logRemovalPolicy = envName === Environment.DEVELOPMENT
            ? cdk.RemovalPolicy.DESTROY
            : cdk.RemovalPolicy.RETAIN;

        // =====================================================================
        // ACM CERTIFICATE (Cross-account DNS validation)
        // =====================================================================
        this.validationLambda = new LambdaFunctionConstruct(this, 'ValidationLambda', {
            functionName: `${namePrefix}-acm-dns-validation-${envName}`,
            description: `ACM certificate DNS validation for ${props.domainName}`,
            entry: 'lambda/dns/acm-certificate-dns-validation.ts',
            handler: 'handler',
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            namePrefix,
            logRetention: logs.RetentionDays.TWO_WEEKS,
            environment: {
                AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
            },
        });

        const certificateConstruct = new AcmCertificateDnsValidationConstruct(
            this,
            'Certificate',
            {
                environment: envName,
                domainName: props.domainName,
                subjectAlternativeNames: props.subjectAlternativeNames,
                hostedZoneId: props.hostedZoneId,
                crossAccountRoleArn: props.crossAccountRoleArn,
                validationFunction: this.validationLambda.function,
                namePrefix,
            }
        );

        this.certificateArn = certificateConstruct.certificateArn;
        this.certificate = acm.Certificate.fromCertificateArn(
            this,
            'ImportedCertificate',
            this.certificateArn
        );

        // =====================================================================
        // WAF WEB ACL
        // =====================================================================
        const wafConstruct = new WafWebAclConstruct(this, 'CloudFrontWebAcl', {
            envName,
            namePrefix,
            scope: 'CLOUDFRONT',
            rateLimitPerIp: props.rateLimitPerIp ?? 5000,
            enableIpReputation: props.enableIpReputationList ?? true,
            enableRateLimiting: props.enableRateLimiting ?? true,
            restrictAccess: props.restrictAccess,
            allowedIps: props.allowedIps,
            allowedIpv6s: props.allowedIpv6s,
        });

        this.webAcl = wafConstruct.webAcl;
        this.webAclArn = wafConstruct.webAclArn;

        // =====================================================================
        // CLOUDFRONT DISTRIBUTION
        // =====================================================================

        // =================================================================
        // CROSS-REGION SSM READERS
        // Read values from eu-west-1 SSM into us-east-1 via AwsCustomResource
        // =================================================================
        const ssmRegion = props.eipSsmRegion ?? 'eu-west-1';

        const k8sPaths = k8sSsmPaths(envName);

        const ssmParameterArns = [
            `arn:aws:ssm:${ssmRegion}:${this.account}:parameter${props.eipSsmPath}`,
            `arn:aws:ssm:${props.assetsBucketSsmRegion ?? ssmRegion}:${this.account}:parameter${props.assetsBucketSsmPath}`,
            `arn:aws:ssm:${ssmRegion}:${this.account}:parameter${k8sPaths.cloudfrontOriginSecret}`,
        ];
        const ssmReaderPolicy = cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: ssmParameterArns,
            }),
            new iam.PolicyStatement({
                actions: ['kms:Decrypt'],
                resources: ['*'], // We only need this if using a CMK, but good practice for SecureStrings
            }),
        ]);

        // Read Elastic IP address (replaces ALB DNS in ECS version)
        const eipAddress = this.readSsmParameter(
            'ReadEipAddress', props.eipSsmPath, ssmRegion, ssmReaderPolicy,
        );

        // Read S3 bucket name
        const bucketName = this.readSsmParameter(
            'ReadAssetsBucketName', props.assetsBucketSsmPath,
            props.assetsBucketSsmRegion ?? ssmRegion, ssmReaderPolicy,
        );
        const bucketRegion = props.assetsBucketSsmRegion ?? ssmRegion;

        // Import bucket with SSM-resolved name
        const staticAssetsBucket = s3.Bucket.fromBucketAttributes(
            this,
            'ImportedAssetsBucket',
            {
                bucketArn: `arn:aws:s3:::${bucketName}`,
                bucketName: bucketName,
                region: bucketRegion,
                bucketRegionalDomainName: `${bucketName}.s3.${bucketRegion}.amazonaws.com`,
            }
        );

        // Read Origin Secret
        //
        // PREREQUISITE: /k8s/{env}/cloudfront-origin-secret must exist in
        // eu-west-1 SSM as a SecureString BEFORE this stack deploys.
        //
        // The CI pipeline's `seed-cloudfront-secret` job ensures this by
        // creating the parameter with a fresh `openssl rand -hex 32` value
        // if it doesn't already exist.  If the parameter is missing, the
        // AwsCustomResource Lambda receives ParameterNotFound from the AWS
        // SDK, which CloudFormation surfaces as an opaque "UnknownError"
        // on the ReadCloudfrontOriginSecret custom resource.
        //
        // ── Secret Rotation (zero-downtime) ───────────────────────────
        // 1. Generate:  NEW=$(openssl rand -hex 32)
        // 2. Update SSM with NEW (--overwrite), run deploy-edge
        //    → CloudFront begins forwarding the new header value
        // 3. While CloudFront propagates (≤15 min), patch Traefik to
        //    accept both values via deploy.py which sets the ArgoCD
        //    Application's cloudfront.originSecret helm parameter to
        //    the regex "OLD_HEX|NEW_HEX"  (HeadersRegexp accepts regex)
        // 4. After propagation: re-run deploy.py with NEW_HEX only
        const originSecret = this.readSsmParameter(
            'ReadCloudfrontOriginSecret',
            k8sPaths.cloudfrontOriginSecret,
            ssmRegion,
            ssmReaderPolicy,
            true, // withDecryption — SecureString requires KMS decrypt
        );

        // S3 origin for static assets (OAC)
        const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(staticAssetsBucket);

        // EIP origin — Traefik Ingress on the Kubernetes node
        // Uses HTTP_ONLY because Traefik's Let's Encrypt cert (via cert-manager)
        // covers ops.nelsonlamounier.com only — not the main domain. CloudFront
        // would fail the SSL handshake due to hostname mismatch.
        //
        // IMPORTANT: CloudFront rejects raw IP addresses as origin domain names.
        // Convert the EIP to its AWS EC2 public DNS hostname:
        //   1.2.3.4 → ec2-1-2-3-4.eu-west-1.compute.amazonaws.com
        // This hostname is auto-assigned by AWS and resolves to the same IP.
        //
        // PREREQUISITE: The VPC in eu-west-1 MUST have "DNS Hostnames" enabled
        // (enableDnsHostnames = true). Without it, AWS does not assign the
        // ec2-x-x-x-x.region.compute.amazonaws.com hostname and CloudFront
        // will fail to resolve the origin. This is a VPC-level setting managed
        // outside CDK (the VPC is imported via Vpc.fromLookup in BaseStack).
        const eipDnsName = cdk.Fn.join('', [
            'ec2-',
            cdk.Fn.join('-', cdk.Fn.split('.', eipAddress)),
            `.${ssmRegion}.compute.amazonaws.com`,
        ]);

        // SECURITY — Origin Bypass Mitigation
        // The X-CloudFront-Origin custom header prevents direct access to the
        // EIP on port 80 (bypassing WAF + CloudFront). Traefik IngressRoute
        // should reject requests missing this header.
        //
        // For defense-in-depth, consider restricting the EC2 security group:
        //   - Allow port 80 ONLY from CloudFront managed prefix list
        //     (com.amazonaws.global.cloudfront.origin-facing)
        //   - This ensures even without the header check, only CloudFront
        //     edge nodes can reach the origin.
        const eipOrigin = new origins.HttpOrigin(eipDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            connectionAttempts: cfConfig.albOriginTimeouts.connectionAttempts,
            connectionTimeout: cfConfig.albOriginTimeouts.connectionTimeout,
            readTimeout: cfConfig.albOriginTimeouts.readTimeout,
            keepaliveTimeout: cfConfig.albOriginTimeouts.keepaliveTimeout,
            customHeaders: { 'X-CloudFront-Origin-Secret': originSecret },
        });

        // Cache Policies
        const staticAssetsCachePolicy = new cloudfront.CachePolicy(this, 'StaticAssetsCachePolicy', {
            comment: 'Cache policy for immutable static assets (1 year TTL)',
            defaultTtl: cfConfig.staticAssetsTtl.default,
            maxTtl: cfConfig.staticAssetsTtl.max,
            minTtl: cfConfig.staticAssetsTtl.min,
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        // ISR Cache-Control Caveat:
        // This policy defines a default TTL, but CloudFront always honours the
        // origin's Cache-Control header when present. If Next.js sends
        //   Cache-Control: private, no-cache
        // then CloudFront will NOT cache the response at the edge regardless
        // of the TTL configured here. Ensure Next.js ISR routes send
        //   Cache-Control: s-maxage=<revalidate>, stale-while-revalidate
        // and that Traefik does NOT strip or override these headers.
        const dynamicContentCachePolicy = new cloudfront.CachePolicy(this, 'DynamicContentCachePolicy', {
            comment: 'Cache policy for ISR pages with revalidation',
            defaultTtl: cfConfig.dynamicContentTtl.default,
            maxTtl: cfConfig.dynamicContentTtl.max,
            minTtl: cfConfig.dynamicContentTtl.min,
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList(...cfConfig.cacheHeaders.dynamic),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

        // Auth-aware no-cache policy: MaxTTL must be >0 so CloudFront permits
        // CookieBehavior.ALL — but the origin sends Cache-Control: no-store,
        // so CloudFront will never cache an actual response.  The critical
        // difference from CACHING_DISABLED is that CookieBehavior.ALL causes
        // CloudFront to forward Set-Cookie response headers back to the viewer,
        // which is required for the Auth.js CSRF double-submit flow.
        //
        // Authorization is included in the cache key (required by CloudFront —
        // it cannot go in OriginRequestPolicy) so admin-api receives the Bearer
        // token. With TTL=0 the cache key is never used for actual caching.
        const authNoCachePolicy = new cloudfront.CachePolicy(this, 'AuthNoCachePolicy', {
            comment: 'No caching — passes Set-Cookie headers for Auth.js CSRF/session flow',
            defaultTtl: cdk.Duration.seconds(0),
            maxTtl: cdk.Duration.seconds(1),
            minTtl: cdk.Duration.seconds(0),
            cookieBehavior: cloudfront.CacheCookieBehavior.all(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
            enableAcceptEncodingGzip: false,
            enableAcceptEncodingBrotli: false,
        });

        // Origin Request Policy (forwarded to Traefik/EIP)
        const eipOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'EipOriginRequestPolicy', {
            comment: 'Forward necessary headers to EIP/Traefik origin',
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...cfConfig.originRequestHeaders),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        });

        // Admin/Auth Origin Request Policy — forwards NextAuth.js session cookies
        // Required for login, session validation, and CSRF protection on admin routes.
        const adminOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'AdminOriginRequestPolicy', {
            comment: 'Forward headers + NextAuth.js session cookies for admin/auth routes',
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...cfConfig.originRequestHeaders),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.allowList(...cfConfig.adminCookies),
        });

        // CloudFront Distribution
        this.distribution = new CloudFrontConstruct(this, 'Distribution', {
            environment: props.targetEnvironment,
            projectName: namePrefix,
            defaultOrigin: eipOrigin,
            certificate: this.certificate,
            domainNames: allDomains,
            minimumProtocolVersion: cfConfig.minimumProtocolVersion,
            defaultCachePolicy: dynamicContentCachePolicy,
            defaultOriginRequestPolicy: eipOriginRequestPolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            additionalBehaviors: [
                // Next.js static assets
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.nextjs.static,
                    origin: s3Origin,
                    cachePolicy: staticAssetsCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    description: 'Next.js build assets (immutable)',
                },
                // Next.js data files
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.nextjs.data,
                    origin: s3Origin,
                    cachePolicy: dynamicContentCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    description: 'Next.js ISR data files',
                },
                // Images
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.assets.images,
                    origin: s3Origin,
                    cachePolicy: staticAssetsCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    description: 'Article images and media',
                },
                // Videos
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.assets.videos,
                    origin: s3Origin,
                    cachePolicy: staticAssetsCachePolicy, // Uses the exact same heavy-cache TTL edge optimization layer
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    description: 'Article videos and media',
                },
                // NextAuth.js callback/session routes — must forward cookies
                // IMPORTANT: Must be listed BEFORE /api/* because CloudFront
                // evaluates behaviours in listed order (first match wins),
                // NOT by path specificity.
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.authCallback,
                    origin: eipOrigin,
                    cachePolicy: authNoCachePolicy,
                    originRequestPolicy: adminOriginRequestPolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    compress: false,
                    description: 'NextAuth.js auth callbacks (no caching, Set-Cookie forwarded)',
                },
                // Admin pages — caching disabled, cookies forwarded for session validation
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.admin,
                    origin: eipOrigin,
                    cachePolicy: authNoCachePolicy,
                    originRequestPolicy: adminOriginRequestPolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    compress: true,
                    description: 'Admin pages (no caching, Set-Cookie forwarded for auth)',
                },
                // Admin API routes — caching disabled, cookies forwarded for session validation
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.adminApi,
                    origin: eipOrigin,
                    cachePolicy: authNoCachePolicy,
                    originRequestPolicy: adminOriginRequestPolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    compress: true,
                    description: 'Admin API routes (no caching, Set-Cookie forwarded for auth)',
                },
                // API routes — general (catch-all for /api/* after more specific patterns above)
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.api,
                    origin: eipOrigin,
                    cachePolicy: noCachePolicy,
                    originRequestPolicy: eipOriginRequestPolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    compress: false,
                    description: 'Next.js API routes (no caching)',
                },
            ],
            errorResponses: CLOUDFRONT_ERROR_RESPONSES.map((err) => ({
                ...err,
                ttl: cfConfig.errorResponseTtl,
            })),
            enableLogging: loggingEnabled,
            logPrefix,
            logIncludeCookies: true,
            priceClass: cfConfig.priceClass,
            httpVersion: cfConfig.httpVersion,
            enableIpv6: true,
            webAclId: this.webAclArn,
        });

        // Suppress CFR3 when logging is explicitly disabled (non-production)
        if (!loggingEnabled) {
            NagSuppressions.addResourceSuppressions(
                this.distribution.distribution,
                [
                    {
                        id: 'AwsSolutions-CFR3',
                        reason: 'CloudFront logging disabled for development/non-production environment to reduce costs',
                    },
                ],
                true
            );
        }

        // Suppress CFR5: EIP origin uses HTTP_ONLY protocol, SSL version is not applicable
        NagSuppressions.addResourceSuppressions(
            this.distribution.distribution,
            [
                {
                    id: 'AwsSolutions-CFR5',
                    reason: 'EIP origin uses HTTP_ONLY protocol (no SSL). HTTPS is terminated at CloudFront edge.',
                },
            ],
            true
        );

        // =====================================================================
        // DNS ALIAS RECORD (CloudFront -> Route 53)
        // =====================================================================
        const dnsAliasLogGroup = new logs.LogGroup(this, 'DnsAliasProviderLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-dns-alias-provider-${envName}`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: logRemovalPolicy,
        });

        const dnsAliasProvider = new cr.Provider(this, 'DnsAliasProvider', {
            onEventHandler: this.validationLambda.function,
            logGroup: dnsAliasLogGroup,
        });

        const dnsAliasRecord = new cdk.CustomResource(this, 'DnsAliasRecord', {
            serviceToken: dnsAliasProvider.serviceToken,
            properties: {
                DomainName: props.domainName,
                HostedZoneId: props.hostedZoneId,
                CrossAccountRoleArn: props.crossAccountRoleArn,
                Environment: envName,
                CloudFrontDomainName: this.distribution.distribution.distributionDomainName,
                SkipCertificateCreation: 'true',
            },
            removalPolicy: logRemovalPolicy,
        });

        dnsAliasRecord.node.addDependency(this.distribution);

        // =====================================================================
        // OPS DNS A RECORD (Admin services — ops.domain.com → EIP)
        // =====================================================================
        // Creates a simple A record for the admin services domain (e.g., ops.nelsonlamounier.com)
        // pointing directly to the Elastic IP. TLS is handled by Traefik Let's Encrypt.
        if (props.opsSubdomain && props.baseDomain) {
            const opsDomainName = `${props.opsSubdomain}.${props.baseDomain}`;
            new cdk.CustomResource(this, 'OpsDnsRecord', {
                serviceToken: dnsAliasProvider.serviceToken,
                properties: {
                    DomainName: opsDomainName,
                    HostedZoneId: props.hostedZoneId,
                    CrossAccountRoleArn: props.crossAccountRoleArn,
                    Environment: envName,
                    SkipCertificateCreation: 'true',
                    RecordValue: eipAddress,
                },
                removalPolicy: logRemovalPolicy,
            });
        }

        // Suppress cdk-nag warning for CDK-managed framework Lambda runtime
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/DnsAliasProvider/framework-onEvent/Resource`,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Framework Lambda runtime is managed by CDK cr.Provider and cannot be configured',
                },
            ],
        );

        // =====================================================================
        // SSM PARAMETERS
        // =====================================================================
        const ssmPaths = nextjsSsmPaths(envName, namePrefix);

        new ssm.StringParameter(this, 'CertificateArnParameter', {
            parameterName: ssmPaths.acmCertificateArn,
            stringValue: this.certificateArn,
            description: `ACM Certificate ARN for ${props.domainName}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'WebAclArnParameter', {
            parameterName: ssmPaths.cloudfront.wafArn,
            stringValue: this.webAclArn,
            description: `CloudFront WAF Web ACL ARN`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'DistributionDomainParameter', {
            parameterName: ssmPaths.cloudfront.distributionDomain,
            stringValue: this.distribution.distribution.distributionDomainName,
            description: 'CloudFront distribution domain for DNS alias records',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'DistributionIdParameter', {
            parameterName: ssmPaths.cloudfront.distributionId,
            stringValue: this.distribution.distributionId,
            description: 'CloudFront distribution ID for cache invalidation',
            tier: ssm.ParameterTier.STANDARD,
        });

        // BFF Service URL Parameters
        //
        // These are written here (Edge Stack, us-east-1) because this is the
        // canonical place where domain names are resolved. Downstream consumers
        // (deploy.py for start-admin / site ConfigMaps) read these paths via
        // the AWS CLI to avoid hardcoding hostnames in environment-specific
        // scripts.
        //
        // Path convention: /bedrock-{shortEnv}/admin-api-url
        //                  /bedrock-{shortEnv}/public-api-url
        //
        // The bedrock prefix is intentional — these BFF services sit alongside
        // Bedrock AI pipelines in the same "application services" SSM namespace.
        // If baseDomain is not provided, these parameters are skipped (e.g. CI
        // synth runs that only validate CloudFormation templates).
        if (props.baseDomain) {
            const bffSsmPaths = bedrockSsmPaths(props.targetEnvironment);

            // In-cluster Kubernetes service DNS is used for server-to-server calls.
            // admin-api and public-api are BFF services — only reachable within the
            // cluster, not via public subdomains. Using in-cluster DNS avoids the
            // need for external DNS records (admin-api.nelsonlamounier.com /
            // api.nelsonlamounier.com do not exist) and keeps BFF traffic off the
            // public internet.
            new ssm.StringParameter(this, 'AdminApiUrlParameter', {
                parameterName: bffSsmPaths.adminApiUrl,
                stringValue: `http://admin-api.admin-api:3002`,
                description: `admin-api BFF in-cluster URL (start-admin ADMIN_API_URL)`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'PublicApiUrlParameter', {
                parameterName: bffSsmPaths.publicApiUrl,
                stringValue: `http://public-api.public-api:3001`,
                description: `public-api BFF in-cluster URL (site PUBLIC_API_URL)`,
                tier: ssm.ParameterTier.STANDARD,
            });
        }

        // Suppress cdk-nag for AwsCustomResource Lambda (SSM cross-region readers)
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Lambda runtime is managed by CDK AwsCustomResource and cannot be configured',
                },
            ],
        );

        // =====================================================================
        // OUTPUTS
        // =====================================================================
        new cdk.CfnOutput(this, 'CertificateArn', {
            value: this.certificateArn,
            description: 'ACM Certificate ARN',
            exportName: `${this.stackName}-cert-arn`,
        });

        new cdk.CfnOutput(this, 'WebAclArn', {
            value: this.webAclArn,
            description: 'WAF Web ACL ARN',
            exportName: `${this.stackName}-waf-arn`,
        });

        new cdk.CfnOutput(this, 'DistributionId', {
            value: this.distribution.distributionId,
            description: 'CloudFront Distribution ID',
            exportName: `${this.stackName}-dist-id`,
        });

        new cdk.CfnOutput(this, 'DistributionDomainName', {
            value: this.distribution.domainName,
            description: 'CloudFront Distribution domain name',
            exportName: `${this.stackName}-dist-domain`,
        });

        // DNS note
        if (props.createDnsRecords !== false) {
            cdk.Annotations.of(this).addInfo(
                `DNS alias records for ${allDomains.join(', ')} need to be created in Route53 ` +
                `(hosted zone: ${props.hostedZoneId}). Use crossAccountRoleArn to create them via Lambda.`
            );
        }
    }

    /**
     * Get cache invalidation command for CI/CD
     */
    public getCacheInvalidationCommand(paths: string[] = ['/*']): string {
        return (
            `aws cloudfront create-invalidation ` +
            `--distribution-id ${this.distribution.distributionId} ` +
            `--paths ${paths.join(' ')}`
        );
    }

    /**
     * Reads an SSM parameter from a remote region via AwsCustomResource.
     *
     * ## Physical Resource ID strategy
     *
     * - **onCreate**: uses `Parameter.ARN` — stable across versions, guarantees
     *   idempotent stack creation (CloudFormation only calls onCreate once).
     * - **onUpdate**: uses a synthesise-time ISO-8601 timestamp (`DEPLOY_TIME`).
     *   Because the timestamp changes on every `cdk deploy` invocation, CloudFormation
     *   always sees a different physical ID and therefore always calls the Lambda,
     *   forcing a fresh `ssm:GetParameter` read on every deploy.
     *
     * Without this fix, `Parameter.ARN` never changes between SSM parameter versions
     * so CloudFormation skips the update entirely — CloudFront ends up reading a
     * stale value (e.g., a rotated `cloudfront-origin-secret`) until the custom
     * resource is manually deleted and re-created.
     *
     * @param id              - CDK construct id (must be unique in the stack).
     * @param parameterPath   - SSM parameter path (e.g. `/k8s/development/elastic-ip`).
     * @param region          - AWS region where the parameter lives (e.g. `eu-west-1`).
     * @param policy          - IAM policy granting `ssm:GetParameter` on the target ARN.
     * @param withDecryption  - Set `true` for SecureString parameters. @default false
     * @returns The resolved parameter value as a CloudFormation token.
     */
    private readSsmParameter(
        id: string,
        parameterPath: string,
        region: string,
        policy: cr.AwsCustomResourcePolicy,
        withDecryption: boolean = false,
    ): string {
        // Synthesise-time timestamp — changes on every `cdk deploy`, causing
        // CloudFormation to treat this as a changed physical resource and
        // invoke the onUpdate handler unconditionally.
        const deployTimestamp = new Date().toISOString();

        const reader = new cr.AwsCustomResource(this, id, {
            onCreate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: parameterPath, WithDecryption: withDecryption },
                region,
                // Stable ID for first-time creation — avoids replacement on Day-0.
                physicalResourceId: cr.PhysicalResourceId.fromResponse('Parameter.ARN'),
            },
            onUpdate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: parameterPath, WithDecryption: withDecryption },
                region,
                // Timestamp-based ID: always different → CloudFormation always
                // re-invokes the Lambda → SSM value is always fresh on every deploy.
                physicalResourceId: cr.PhysicalResourceId.of(
                    `${parameterPath}@${deployTimestamp}`,
                ),
            },
            policy,
        });
        return reader.getResponseField('Parameter.Value');
    }
}

