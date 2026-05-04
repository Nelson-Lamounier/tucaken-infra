/**
 * @format
 * Tucaken Edge Stack — Global CDN + Edge Security for tucaken.io / tucaken.com
 *
 * Customer-facing SaaS edge infrastructure. Independent from the portfolio
 * (`KubernetesEdgeStack`) — own CloudFront distributions, own WAF, own
 * ACM certificate, own origin secret. Both edges land at the same Traefik
 * ingress on the shared cluster but route to different IngressRoutes by
 * Host header (Host=tucaken.io → tucaken-app namespace).
 *
 * MUST be deployed in us-east-1 (CloudFront + WAF requirement).
 *
 * ## Traffic Flow
 * ```
 * tucaken.io        → CloudFront (primary)  → EIP → Traefik → tucaken-app
 * www.tucaken.io    → CloudFront (primary)  → 301 → tucaken.io  (CF Function)
 * tucaken.com       → CloudFront (redirect) → 301 → tucaken.io  (CF Function)
 * www.tucaken.com   → CloudFront (redirect) → 301 → tucaken.io  (CF Function)
 * ```
 *
 * ## Two Distributions Rationale
 * The cross-account DNS validation Lambda accepts ONE hosted zone per cert,
 * so a single SAN cert spanning .io + .com can't validate today. Two distros
 * (one per zone/cert) is the standard apex-redirect pattern used by most
 * SaaS that own multiple TLDs (Stripe, Linear, Vercel). The redirect distro
 * has a tiny CloudFront Function and trivial cost.
 *
 * If/when the validation Lambda is enhanced to support multi-zone certs,
 * collapse into one distribution.
 *
 * ## Resources Created
 * 1. **Validation Lambda** — DNS-01 for ACM certs (re-uses existing handler)
 * 2. **ACM Certificate (.io)** — tucaken.io + www.tucaken.io
 * 3. **ACM Certificate (.com)** — tucaken.com + www.tucaken.com
 * 4. **WAF WebACL** — shared between both distributions (CLOUDFRONT scope)
 * 5. **CloudFront Function** — host normalization + apex redirect
 * 6. **CloudFront Distribution (primary)** — serves tucaken.io
 * 7. **CloudFront Distribution (redirect)** — 301s tucaken.com → tucaken.io
 * 8. **Route53 Alias Records** — 4 records (apex + www, both domains)
 * 9. **SSM Outputs** — distribution IDs, cert ARNs, WAF ARN
 */

import { NagSuppressions } from 'cdk-nag';

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { getNextJsConfigs } from '../../config/nextjs';
import { k8sSsmPaths, tucakenSsmPaths } from '../../config/ssm-paths';
import { LambdaFunctionConstruct } from '../../constructs/compute';
import { CloudFrontConstruct } from '../../constructs/networking/cloudfront';
import { AcmCertificateDnsValidationConstruct } from '../../constructs/security/acm-certificate';
import { WafWebAclConstruct } from '../../constructs/security/waf-web-acl';

// =============================================================================
// STACK PROPS
// =============================================================================

export interface TucakenEdgeStackProps extends cdk.StackProps {
    /** Target deployment environment (development/staging/production) */
    readonly targetEnvironment: Environment;

    /** Primary domain (canonical) — e.g. `tucaken.io` */
    readonly ioDomain: string;
    /** Secondary domain (redirected to primary) — e.g. `tucaken.com` */
    readonly comDomain: string;

    /** Route 53 hosted zone ID (root account) for tucaken.io */
    readonly ioHostedZoneId: string;
    /** Route 53 hosted zone ID (root account) for tucaken.com */
    readonly comHostedZoneId: string;

    /** IAM role ARN in root account for cross-account Route 53 access */
    readonly crossAccountRoleArn: string;

    /** SSM parameter path for Elastic IP address (read cross-region) */
    readonly eipSsmPath: string;
    /** Region where the EIP SSM parameter is stored @default 'eu-west-1' */
    readonly eipSsmRegion?: string;

    /** WAF rate limit per IP per 5 minutes @default 5000 */
    readonly rateLimitPerIp?: number;
    /** Enable AWS IP reputation list in WAF @default true */
    readonly enableIpReputationList?: boolean;
    /** Enable WAF rate limiting @default true */
    readonly enableRateLimiting?: boolean;
    /** Enable CloudFront access logging @default from config */
    readonly enableLogging?: boolean;

    /** Resource name prefix @default 'tucaken' */
    readonly namePrefix?: string;

    /**
     * Pre-launch IP restriction. When true, only allowedIps/allowedIpv6s
     * may reach the site at the CloudFront edge.
     * @default false
     */
    readonly restrictAccess?: boolean;
    readonly allowedIps?: string[];
    readonly allowedIpv6s?: string[];
}

// =============================================================================
// STACK
// =============================================================================

export class TucakenEdgeStack extends cdk.Stack {
    public readonly ioCertificateArn: string;
    public readonly comCertificateArn: string;
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly webAclArn: string;
    public readonly ioDistribution: CloudFrontConstruct;
    public readonly comDistribution: CloudFrontConstruct;
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: TucakenEdgeStackProps) {
        super(scope, id, {
            ...props,
            description: `Tucaken edge infrastructure (ACM + WAF + CloudFront) — ${props.targetEnvironment}`,
        });

        this.targetEnvironment = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'tucaken';
        const envName = props.targetEnvironment;

        // =====================================================================
        // VALIDATION
        // =====================================================================
        if (props.env?.region && props.env.region !== 'us-east-1') {
            throw new Error(
                `Tucaken edge stack MUST be deployed in us-east-1. Got: ${props.env.region}`,
            );
        }
        if (this.region !== 'us-east-1') {
            cdk.Annotations.of(this).addError(
                `Tucaken edge stack MUST be deployed in us-east-1. Current: ${this.region}`,
            );
        }
        for (const [k, v] of Object.entries({
            ioDomain: props.ioDomain,
            comDomain: props.comDomain,
            ioHostedZoneId: props.ioHostedZoneId,
            comHostedZoneId: props.comHostedZoneId,
            crossAccountRoleArn: props.crossAccountRoleArn,
        })) {
            if (!v) {
                cdk.Annotations.of(this).addWarning(
                    `Tucaken edge config missing ${k}; deploy will fail until set.`,
                );
            }
        }

        // =====================================================================
        // CONFIGURATION
        // =====================================================================
        const configs = getNextJsConfigs(props.targetEnvironment);
        const cfConfig = configs.cloudfront;
        const loggingEnabled = props.enableLogging ?? cfConfig.loggingEnabled;
        const tucakenPaths = tucakenSsmPaths(envName);

        // =====================================================================
        // VALIDATION LAMBDA (re-uses ACM DNS validation handler)
        // Single Lambda — both certificates share the same validation flow.
        // Each AcmCertificateDnsValidationConstruct passes its own zone ID
        // to the custom resource invocation.
        // =====================================================================
        const validationLambda = new LambdaFunctionConstruct(this, 'ValidationLambda', {
            functionName: `${namePrefix}-acm-dns-validation-${envName}`,
            description: `ACM DNS validation for tucaken.io / tucaken.com (${envName})`,
            entry: 'lambda/dns/acm-certificate-dns-validation.ts',
            handler: 'handler',
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            namePrefix,
            logRetention: logs.RetentionDays.TWO_WEEKS,
            environment: { AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1' },
        });

        // =====================================================================
        // ACM CERTIFICATES — one per hosted zone
        //
        // Two certs (one per zone) is the standard apex-redirect pattern: each
        // cert is validated entirely within its own hosted zone, so the existing
        // single-zone validation Lambda is reused unchanged.
        // =====================================================================
        const ioCertConstruct = new AcmCertificateDnsValidationConstruct(
            this,
            'IoCertificate',
            {
                environment: envName,
                domainName: props.ioDomain,
                subjectAlternativeNames: [`www.${props.ioDomain}`],
                hostedZoneId: props.ioHostedZoneId,
                crossAccountRoleArn: props.crossAccountRoleArn,
                validationFunction: validationLambda.function,
                namePrefix: `${namePrefix}-io`,
                forceUpdate: process.env.GITHUB_SHA ?? new Date().toISOString(),
            },
        );
        this.ioCertificateArn = ioCertConstruct.certificateArn;
        const ioCertificate = acm.Certificate.fromCertificateArn(
            this, 'ImportedIoCertificate', this.ioCertificateArn,
        );

        const comCertConstruct = new AcmCertificateDnsValidationConstruct(
            this,
            'ComCertificate',
            {
                environment: envName,
                domainName: props.comDomain,
                subjectAlternativeNames: [`www.${props.comDomain}`],
                hostedZoneId: props.comHostedZoneId,
                crossAccountRoleArn: props.crossAccountRoleArn,
                validationFunction: validationLambda.function,
                namePrefix: `${namePrefix}-com`,
                forceUpdate: process.env.GITHUB_SHA ?? new Date().toISOString(),
            },
        );
        this.comCertificateArn = comCertConstruct.certificateArn;
        const comCertificate = acm.Certificate.fromCertificateArn(
            this, 'ImportedComCertificate', this.comCertificateArn,
        );

        // =====================================================================
        // WAF — shared between both distributions
        // Same rate limit applies whether the request hits .io or .com.
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
        // CROSS-REGION SSM READERS (EIP + tucaken origin secret)
        // =====================================================================
        const ssmRegion = props.eipSsmRegion ?? 'eu-west-1';
        const k8sPaths = k8sSsmPaths(envName);

        const ssmReaderPolicy = cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: [
                    `arn:aws:ssm:${ssmRegion}:${this.account}:parameter${props.eipSsmPath}`,
                    `arn:aws:ssm:${ssmRegion}:${this.account}:parameter${k8sPaths.tucakenCloudfrontOriginSecret}`,
                ],
            }),
            new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: ['*'] }),
        ]);

        const eipAddress = this.readSsmParameter(
            'ReadEipAddress', props.eipSsmPath, ssmRegion, ssmReaderPolicy,
        );

        // PREREQUISITE: /k8s/{env}/tucaken-cloudfront-origin-secret must exist
        // in eu-west-1 SSM as a SecureString BEFORE this stack deploys.
        // CI seed job: `seed-tucaken-cloudfront-secret` (mirrors the portfolio
        // seed-cloudfront-secret job) creates it with `openssl rand -hex 32`
        // if absent.
        const originSecret = this.readSsmParameter(
            'ReadTucakenOriginSecret',
            k8sPaths.tucakenCloudfrontOriginSecret,
            ssmRegion,
            ssmReaderPolicy,
            true, // SecureString
        );

        // =====================================================================
        // EIP ORIGIN
        //
        // CloudFront rejects raw IPs — convert to AWS EC2 public DNS hostname.
        // VPC must have DNS Hostnames enabled (handled in BaseStack).
        //
        // HTTP_ONLY because TLS terminates at CloudFront. The X-CloudFront-
        // Origin-Secret header is the auth token — Traefik IngressRoute on the
        // tucaken-app namespace validates it via HeadersRegexp middleware and
        // rejects requests without the matching value.
        // =====================================================================
        const eipDnsName = cdk.Fn.join('', [
            'ec2-',
            cdk.Fn.join('-', cdk.Fn.split('.', eipAddress)),
            `.${ssmRegion}.compute.amazonaws.com`,
        ]);

        const tucakenOrigin = new origins.HttpOrigin(eipDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            connectionAttempts: cfConfig.albOriginTimeouts.connectionAttempts,
            connectionTimeout: cfConfig.albOriginTimeouts.connectionTimeout,
            readTimeout: cfConfig.albOriginTimeouts.readTimeout,
            keepaliveTimeout: cfConfig.albOriginTimeouts.keepaliveTimeout,
            customHeaders: { 'X-CloudFront-Origin-Secret': originSecret },
        });

        // =====================================================================
        // CACHE POLICIES
        //
        // Tucaken uses a SaaS routing model:
        //   /_next/static/*  → 1y immutable (Next.js build assets)
        //   /_next/data/*    → ISR with origin Cache-Control honoured
        //   /api/auth/*      → no-cache, cookies forwarded (NextAuth.js)
        //   /api/*           → no-cache, no cookies forwarded
        //   /                → ISR (origin honours Cache-Control)
        //
        // No /admin or /api/admin/* — tucaken-app does not have an admin
        // surface; that responsibility lives in tucaken-app (separate edge).
        // =====================================================================
        const staticAssetsCachePolicy = new cloudfront.CachePolicy(this, 'StaticAssetsCachePolicy', {
            comment: 'Immutable Next.js build assets (1y TTL)',
            defaultTtl: cfConfig.staticAssetsTtl.default,
            maxTtl: cfConfig.staticAssetsTtl.max,
            minTtl: cfConfig.staticAssetsTtl.min,
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        const dynamicContentCachePolicy = new cloudfront.CachePolicy(this, 'DynamicContentCachePolicy', {
            comment: 'ISR pages — origin Cache-Control honoured',
            defaultTtl: cfConfig.dynamicContentTtl.default,
            maxTtl: cfConfig.dynamicContentTtl.max,
            minTtl: cfConfig.dynamicContentTtl.min,
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList(...cfConfig.cacheHeaders.dynamic),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        // Auth-aware no-cache: TTL > 0 required so CookieBehavior.ALL works,
        // origin sends Cache-Control: no-store so nothing is actually cached.
        const authNoCachePolicy = new cloudfront.CachePolicy(this, 'AuthNoCachePolicy', {
            comment: 'NextAuth.js callbacks — no caching, Set-Cookie forwarded',
            defaultTtl: cdk.Duration.seconds(0),
            maxTtl: cdk.Duration.seconds(1),
            minTtl: cdk.Duration.seconds(0),
            cookieBehavior: cloudfront.CacheCookieBehavior.all(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
            enableAcceptEncodingGzip: false,
            enableAcceptEncodingBrotli: false,
        });

        const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

        const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'OriginRequestPolicy', {
            comment: 'Forward standard headers to Traefik origin',
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...cfConfig.originRequestHeaders),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        });

        const authOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'AuthOriginRequestPolicy', {
            comment: 'Forward NextAuth.js session cookies on /api/auth/*',
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...cfConfig.originRequestHeaders),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.allowList(...cfConfig.adminCookies),
        });

        // =====================================================================
        // CLOUDFRONT FUNCTION — apex/www normalization + (gated) basic-auth gate
        //
        // Runs at viewer-request on BOTH distributions. Order:
        //   1. If host !== canonical apex → 301 to https://<apex><uri>
        //      (handles www.tucaken.io, tucaken.com, www.tucaken.com)
        //   2. (NON-PROD only) If `Authorization` header missing/wrong →
        //      401 with `WWW-Authenticate: Basic realm="tucaken-private"`
        //   3. Pass-through to origin
        //
        // The auth gate is enabled on every NON-PRODUCTION environment so the
        // public can't browse work-in-progress dev or staging deployments.
        // Production stays open. Removing the gate from a given env later
        // is a one-line config flip (or moving the env into PRODUCTION).
        //
        // Credentials are read from SSM at synth time:
        //   /tucaken/{env}/edge/auth-expected = "Basic <base64(user:pass)>"
        //
        // The SSM parameter MUST exist in the target account before the first
        // synth/deploy of a gated env. If absent, valueFromLookup returns a
        // CDK dummy token, the function compiles with the dummy as `expected`,
        // and every request 401s — including yours.
        //
        // Rotation today = update SSM + `cdk deploy`. For zero-deploy rotation,
        // migrate to CloudFront KeyValueStore (deferred — see commit history).
        // =====================================================================
        const ioDomain = props.ioDomain;
        const enableEdgeAuth = envName !== Environment.PRODUCTION;
        const expectedAuthHeader = enableEdgeAuth
            ? ssm.StringParameter.valueFromLookup(this, tucakenPaths.edgeAuthExpected)
            : '';

        const authBlock = enableEdgeAuth
            ? `
    var expected = '${expectedAuthHeader}';
    var auth = req.headers.authorization && req.headers.authorization.value;
    if (auth !== expected) {
        return {
            statusCode: 401,
            statusDescription: 'Unauthorized',
            headers: {
                'www-authenticate': { value: 'Basic realm="tucaken-private"' },
                'cache-control': { value: 'no-store' }
            }
        };
    }`
            : '';

        const edgeFunction = new cloudfront.Function(this, 'EdgeFunction', {
            functionName: `${namePrefix}-edge-${envName}`,
            comment: enableEdgeAuth
                ? `Host normalize → 301; then basic-auth gate (${envName})`
                : 'Host normalize: redirect www/.com variants to https://tucaken.io',
            code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    var req = event.request;
    var host = req.headers.host && req.headers.host.value;
    var canonical = '${ioDomain}';
    if (host && host !== canonical) {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                'location': { value: 'https://' + canonical + req.uri }
            }
        };
    }${authBlock}
    return req;
}
            `.trim()),
        });

        const edgeFunctionAssociations: cloudfront.FunctionAssociation[] = [
            { function: edgeFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ];

        // =====================================================================
        // PRIMARY DISTRIBUTION (.io)
        //
        // Serves the actual application. www.tucaken.io is included as a SAN
        // so the cert validates, but the CloudFront Function 301s it to the
        // apex before the request ever hits the origin.
        // =====================================================================
        this.ioDistribution = new CloudFrontConstruct(this, 'IoDistribution', {
            environment: props.targetEnvironment,
            projectName: namePrefix,
            comment: `Tucaken primary distribution (${props.ioDomain}) — ${envName}`,
            defaultOrigin: tucakenOrigin,
            certificate: ioCertificate,
            domainNames: [props.ioDomain, `www.${props.ioDomain}`],
            minimumProtocolVersion: cfConfig.minimumProtocolVersion,
            defaultCachePolicy: dynamicContentCachePolicy,
            defaultOriginRequestPolicy: originRequestPolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            additionalBehaviors: [
                {
                    pathPattern: '/_next/static/*',
                    origin: tucakenOrigin,
                    cachePolicy: staticAssetsCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    functionAssociations: edgeFunctionAssociations,
                },
                {
                    pathPattern: '/_next/data/*',
                    origin: tucakenOrigin,
                    cachePolicy: dynamicContentCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    functionAssociations: edgeFunctionAssociations,
                },
                // NextAuth.js callbacks — listed BEFORE /api/* (first-match-wins).
                {
                    pathPattern: '/api/auth/*',
                    origin: tucakenOrigin,
                    cachePolicy: authNoCachePolicy,
                    originRequestPolicy: authOriginRequestPolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    compress: false,
                    functionAssociations: edgeFunctionAssociations,
                },
                {
                    pathPattern: '/api/*',
                    origin: tucakenOrigin,
                    cachePolicy: noCachePolicy,
                    originRequestPolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    compress: false,
                    functionAssociations: edgeFunctionAssociations,
                },
            ],
            enableLogging: loggingEnabled,
            logPrefix: `${namePrefix}-io`,
            logIncludeCookies: true,
            priceClass: cfConfig.priceClass,
            httpVersion: cfConfig.httpVersion,
            enableIpv6: true,
            webAclId: this.webAclArn,
        });

        // Attach the edge function to the .io default behavior. The wrapper
        // construct doesn't expose `functionAssociations` for the default
        // behavior, so we go direct on the underlying CfnDistribution.
        // (additionalBehaviors[] receive the function via BehaviorOptions
        // above; this override only covers the default cache behavior.)
        const ioCfn = this.ioDistribution.distribution.node.defaultChild as cloudfront.CfnDistribution;
        ioCfn.addPropertyOverride(
            'DistributionConfig.DefaultCacheBehavior.FunctionAssociations',
            [{ EventType: 'viewer-request', FunctionARN: edgeFunction.functionArn }],
        );

        // =====================================================================
        // REDIRECT DISTRIBUTION (.com)
        //
        // No real origin behavior — every request 301s to tucaken.io via the
        // CloudFront Function at viewer-request. The origin is still set to
        // the EIP as a formality (CloudFront requires one), but the function
        // returns the redirect before any origin call is made.
        //
        // Path patterns are NOT replicated — first-match handles everything
        // because the function fires on the default behavior and short-
        // circuits the response.
        // =====================================================================
        this.comDistribution = new CloudFrontConstruct(this, 'ComDistribution', {
            environment: props.targetEnvironment,
            projectName: `${namePrefix}-com-redirect`,
            comment: `Tucaken redirect distribution (${props.comDomain} → ${props.ioDomain}) — ${envName}`,
            defaultOrigin: tucakenOrigin,
            certificate: comCertificate,
            domainNames: [props.comDomain, `www.${props.comDomain}`],
            minimumProtocolVersion: cfConfig.minimumProtocolVersion,
            defaultCachePolicy: noCachePolicy,
            defaultOriginRequestPolicy: originRequestPolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
            enableLogging: loggingEnabled,
            logPrefix: `${namePrefix}-com`,
            logIncludeCookies: false,
            priceClass: cfConfig.priceClass,
            httpVersion: cfConfig.httpVersion,
            enableIpv6: true,
            webAclId: this.webAclArn,
        });

        const comCfn = this.comDistribution.distribution.node.defaultChild as cloudfront.CfnDistribution;
        comCfn.addPropertyOverride(
            'DistributionConfig.DefaultCacheBehavior.FunctionAssociations',
            [{ EventType: 'viewer-request', FunctionARN: edgeFunction.functionArn }],
        );

        // CFR3: logging may be intentionally disabled in non-prod
        if (!loggingEnabled) {
            for (const dist of [this.ioDistribution, this.comDistribution]) {
                NagSuppressions.addResourceSuppressions(
                    dist.distribution,
                    [{ id: 'AwsSolutions-CFR3', reason: 'Logging disabled in non-production' }],
                    true,
                );
            }
        }
        // CFR5: HTTP_ONLY origin — TLS terminates at edge
        for (const dist of [this.ioDistribution, this.comDistribution]) {
            NagSuppressions.addResourceSuppressions(
                dist.distribution,
                [{ id: 'AwsSolutions-CFR5', reason: 'EIP origin is HTTP_ONLY; TLS terminates at CloudFront' }],
                true,
            );
        }

        // =====================================================================
        // ROUTE 53 ALIAS RECORDS — 4 total
        //
        // Re-uses the validation Lambda's DNS alias helper. Each record is
        // a single CustomResource invocation that creates an A-alias in the
        // appropriate hosted zone in the root account.
        // =====================================================================
        const dnsAliasLogGroup = new logs.LogGroup(this, 'DnsAliasProviderLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-dns-alias-provider-${envName}`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: envName === Environment.DEVELOPMENT
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        const dnsAliasProvider = new cr.Provider(this, 'DnsAliasProvider', {
            onEventHandler: validationLambda.function,
            logGroup: dnsAliasLogGroup,
        });

        const aliasRecords: Array<{
            id: string;
            domain: string;
            zoneId: string;
            target: string;
        }> = [
            { id: 'IoApexAlias', domain: props.ioDomain, zoneId: props.ioHostedZoneId, target: this.ioDistribution.distribution.distributionDomainName },
            { id: 'IoWwwAlias', domain: `www.${props.ioDomain}`, zoneId: props.ioHostedZoneId, target: this.ioDistribution.distribution.distributionDomainName },
            { id: 'ComApexAlias', domain: props.comDomain, zoneId: props.comHostedZoneId, target: this.comDistribution.distribution.distributionDomainName },
            { id: 'ComWwwAlias', domain: `www.${props.comDomain}`, zoneId: props.comHostedZoneId, target: this.comDistribution.distribution.distributionDomainName },
        ];

        for (const r of aliasRecords) {
            const record = new cdk.CustomResource(this, r.id, {
                serviceToken: dnsAliasProvider.serviceToken,
                properties: {
                    DomainName: r.domain,
                    HostedZoneId: r.zoneId,
                    CrossAccountRoleArn: props.crossAccountRoleArn,
                    Environment: envName,
                    CloudFrontDomainName: r.target,
                    SkipCertificateCreation: 'true',
                },
                removalPolicy: envName === Environment.DEVELOPMENT
                    ? cdk.RemovalPolicy.DESTROY
                    : cdk.RemovalPolicy.RETAIN,
            });
            record.node.addDependency(this.ioDistribution);
            record.node.addDependency(this.comDistribution);
        }

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/DnsAliasProvider/framework-onEvent/Resource`,
            [{ id: 'AwsSolutions-L1', reason: 'CDK-managed framework Lambda runtime' }],
        );

        // =====================================================================
        // SSM OUTPUTS
        // =====================================================================
        new ssm.StringParameter(this, 'IoCertificateArnParameter', {
            parameterName: tucakenPaths.ioCertificateArn,
            stringValue: this.ioCertificateArn,
            description: `ACM cert ARN for ${props.ioDomain}`,
        });
        new ssm.StringParameter(this, 'ComCertificateArnParameter', {
            parameterName: tucakenPaths.comCertificateArn,
            stringValue: this.comCertificateArn,
            description: `ACM cert ARN for ${props.comDomain}`,
        });
        new ssm.StringParameter(this, 'WebAclArnParameter', {
            parameterName: tucakenPaths.wafArn,
            stringValue: this.webAclArn,
            description: 'Tucaken CloudFront WAF Web ACL ARN',
        });
        new ssm.StringParameter(this, 'IoDistributionIdParameter', {
            parameterName: tucakenPaths.ioDistributionId,
            stringValue: this.ioDistribution.distributionId,
            description: 'Tucaken primary distribution ID (cache invalidation)',
        });
        new ssm.StringParameter(this, 'IoDistributionDomainParameter', {
            parameterName: tucakenPaths.ioDistributionDomain,
            stringValue: this.ioDistribution.distribution.distributionDomainName,
            description: 'Tucaken primary distribution domain',
        });
        new ssm.StringParameter(this, 'ComDistributionIdParameter', {
            parameterName: tucakenPaths.comDistributionId,
            stringValue: this.comDistribution.distributionId,
            description: 'Tucaken redirect distribution ID',
        });
        new ssm.StringParameter(this, 'ComDistributionDomainParameter', {
            parameterName: tucakenPaths.comDistributionDomain,
            stringValue: this.comDistribution.distribution.distributionDomainName,
            description: 'Tucaken redirect distribution domain',
        });

        // Suppress AwsCustomResource framework Lambda nags
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [{ id: 'AwsSolutions-L1', reason: 'CDK-managed AwsCustomResource Lambda runtime' }],
        );

        // =====================================================================
        // STACK OUTPUTS
        // =====================================================================
        new cdk.CfnOutput(this, 'IoCertificateArn', {
            value: this.ioCertificateArn,
            exportName: `${this.stackName}-io-cert-arn`,
        });
        new cdk.CfnOutput(this, 'ComCertificateArn', {
            value: this.comCertificateArn,
            exportName: `${this.stackName}-com-cert-arn`,
        });
        new cdk.CfnOutput(this, 'WebAclArn', {
            value: this.webAclArn,
            exportName: `${this.stackName}-waf-arn`,
        });
        new cdk.CfnOutput(this, 'IoDistributionId', {
            value: this.ioDistribution.distributionId,
            exportName: `${this.stackName}-io-dist-id`,
        });
        new cdk.CfnOutput(this, 'ComDistributionId', {
            value: this.comDistribution.distributionId,
            exportName: `${this.stackName}-com-dist-id`,
        });
    }

    /**
     * Read SSM parameter from a remote region via AwsCustomResource.
     * Mirrors the pattern in `KubernetesEdgeStack.readSsmParameter` —
     * timestamp-based onUpdate physical ID forces fresh reads on every deploy.
     */
    private readSsmParameter(
        id: string,
        parameterPath: string,
        region: string,
        policy: cr.AwsCustomResourcePolicy,
        withDecryption: boolean = false,
    ): string {
        const deployTimestamp = new Date().toISOString();
        const reader = new cr.AwsCustomResource(this, id, {
            onCreate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: parameterPath, WithDecryption: withDecryption },
                region,
                physicalResourceId: cr.PhysicalResourceId.fromResponse('Parameter.ARN'),
            },
            onUpdate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: parameterPath, WithDecryption: withDecryption },
                region,
                physicalResourceId: cr.PhysicalResourceId.of(`${parameterPath}@${deployTimestamp}`),
            },
            policy,
        });
        return reader.getResponseField('Parameter.Value');
    }
}
