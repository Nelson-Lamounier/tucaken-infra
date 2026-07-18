/**
 * @format
 * EKS Public WAF construct — REGIONAL WebACL for the shared ALB.
 *
 * Implements the host-scoped rule shape from Plan 5b § 0.4:
 *
 *   Default ALLOW. Hosts in `allowlistedHosts` (e.g. admin.*, ops.*) are
 *   reachable only from `allowlistedIpv4` / `allowlistedIpv6`. Hosts in
 *   `rateLimitedHosts` (e.g. api.*) get a per-IP rate limit. Every host
 *   on the ALB inherits the AWS Managed Rule Sets (Common, KnownBad,
 *   IpReputation, SQLi).
 *
 * Why bespoke instead of `WafWebAclConstruct` + `restrictAccess`:
 * the existing global-allowlist mode would gate every domain on the
 * ALB. Plan 5b mounts admin and public traffic on a single shared ALB
 * (Plan 5b § 0.6 IngressGroup design), so allowlisting must be
 * scoped down by Host header.
 */
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

import { Construct } from 'constructs';

/**
 * Config for {@link EksPublicWafProps.oversizeBodyExempt}. Relaxes the Common
 * rule set's 8 KB body cap for one authenticated request surface.
 */
/**
 * One additional surface exempted from the re-applied body cap. Each surface
 * must carry its own authenticity check (HMAC, collector-side validation,
 * authenticated session) — the cap is the only protection being waived.
 */
export interface OversizeExemptPathConfig {
    /** URI path prefix (lowercase, STARTS_WITH), e.g. `/faro/collect`. */
    readonly pathPrefix: string;
    /** HTTP method (exact). @default 'POST' */
    readonly method?: string;
    /** Hosts (lowercase, exact). Omit to exempt the path on ANY host. */
    readonly hosts?: readonly string[];
}

export interface OversizeBodyExemptConfig {
    /** Hosts (lowercase, exact) where oversize bodies on the exempt path are allowed. */
    readonly hosts: readonly string[];
    /** URI path prefix (lowercase, STARTS_WITH), e.g. `/_serverfn/`. */
    readonly pathPrefix: string;
    /** HTTP method (exact) the exemption applies to. @default 'POST' */
    readonly method?: string;
    /** Body-size cap (bytes) re-applied to non-exempt requests. @default 8192 */
    readonly maxBodyBytes?: number;
    /**
     * Further surfaces exempted from the re-applied cap (OR'd with the
     * server-function surface). Added 2026-07-18 for /faro/collect (RUM
     * batches, any host) and /api/github/webhook (large push deliveries),
     * both of which the cap was silently 403'ing.
     */
    readonly extraExemptPaths?: readonly OversizeExemptPathConfig[];
}

export interface EksPublicWafProps {
    readonly envName: string;
    readonly namePrefix: string;
    /**
     * Initial IPv4 CIDRs seeded into the IP set by CloudFormation.
     * IpSyncFn Lambda immediately overwrites this from SSM at deploy time,
     * so pass an empty array — CDK no longer needs to know the operator's IP.
     */
    readonly allowlistedIpv4: readonly string[];
    /**
     * Initial IPv6 CIDRs seeded into the IP set. Same as above — Lambda owns
     * runtime content; pass an empty array from the stack.
     */
    readonly allowlistedIpv6?: readonly string[];
    /**
     * Hosts that require an IP allowlist. Lowercase, exact-match against
     * the `Host` header (no port, no scheme).
     */
    readonly allowlistedHosts: readonly string[];
    /**
     * Hosts that get a per-IP rate-limit rule on top of the managed rules.
     */
    readonly rateLimitedHosts: readonly string[];
    /** Rate limit per IP per 5 minutes on `rateLimitedHosts`. @default 2000 */
    readonly rateLimitPerIp?: number;
    /**
     * URI paths (lowercase, exact match) that carry their own request
     * authentication (e.g. HMAC-signed webhooks) and therefore bypass BOTH
     * the host IP allowlist and the body-inspecting managed rule sets
     * (Common, KnownBadInputs, SQLi):
     *
     *   - GitHub webhook deliveries originate from GitHub's IPs, which are
     *     never in the operator allowlist, so the allowlist rule 403s them
     *     at the ALB.
     *   - Push payloads routinely exceed the Common rule set's 8 KB
     *     SizeRestrictions_BODY cap, and code diffs in the payload
     *     false-positive the SQLi/KnownBadInputs body inspections.
     *
     * The endpoint's HMAC signature is the authentication for these paths;
     * the IP-reputation rule set and the rate limit still apply.
     * @default [] no exemptions
     */
    readonly ipAllowlistExemptPaths?: readonly string[];

    /**
     * Relaxes the Common rule set's 8 KB `SizeRestrictions_BODY` cap for the
     * SaaS app's TanStack server-function calls (POST `/_serverFn/*`), whose
     * seroval-serialised payload (a pasted job description) routinely exceeds
     * 8 KB and is otherwise 403'd at the ALB before reaching the app.
     *
     * The calls are Cognito-authenticated and Zod-validated server-side, and
     * admin-api caps the job description at 100 KB, so relaxing ONLY the size
     * rule is safe — SQLi/KnownBadInputs body inspection still applies. When
     * set, `SizeRestrictions_BODY` is overridden to Count and a bespoke rule
     * re-applies the body cap to every request EXCEPT `<method> <pathPrefix>*`
     * on `hosts`.
     * @default undefined — no oversize exemption
     */
    readonly oversizeBodyExempt?: OversizeBodyExemptConfig;
}

export class EksPublicWafConstruct extends Construct {
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly webAclArn: string;
    /**
     * Always set when `allowlistedHosts` is non-empty. Content is managed by
     * IpSyncFn Lambda, not CloudFormation — addresses may be empty at synth.
     */
    public readonly ipv4Set?: wafv2.CfnIPSet;
    /** Always set when `allowlistedHosts` is non-empty. Same ownership as ipv4Set. */
    public readonly ipv6Set?: wafv2.CfnIPSet;

    constructor(scope: Construct, id: string, props: EksPublicWafProps) {
        super(scope, id);

        const { envName, namePrefix } = props;
        const rateLimitPerIp = props.rateLimitPerIp ?? 2000;
        const allowlistedIpv6 = props.allowlistedIpv6 ?? [];
        // IP sets are created whenever allowlisted hosts are configured —
        // independent of whether initial CIDRs are provided. IpSyncFn Lambda
        // populates content from SSM at deploy time; CloudFormation only owns
        // the resource, not the addresses.
        const hasAllowlist = props.allowlistedHosts.length > 0;
        const hasRateLimit = props.rateLimitedHosts.length > 0;

        // ---------- IP sets (created whenever hosts are allowlisted) ----------
        const ipSetRefs: wafv2.CfnWebACL.StatementProperty[] = [];
        if (hasAllowlist) {
            this.ipv4Set = new wafv2.CfnIPSet(this, 'AllowIpv4', {
                name: `${namePrefix}-allow-ipv4-${envName}`,
                scope: 'REGIONAL',
                ipAddressVersion: 'IPV4',
                addresses: [...props.allowlistedIpv4],
            });
            ipSetRefs.push({ ipSetReferenceStatement: { arn: this.ipv4Set.attrArn } });

            this.ipv6Set = new wafv2.CfnIPSet(this, 'AllowIpv6', {
                name: `${namePrefix}-allow-ipv6-${envName}`,
                scope: 'REGIONAL',
                ipAddressVersion: 'IPV6',
                addresses: [...allowlistedIpv6],
            });
            ipSetRefs.push({ ipSetReferenceStatement: { arn: this.ipv6Set.attrArn } });
        }

        const rules: wafv2.CfnWebACL.RuleProperty[] = [];

        // ---------- Self-authenticated path exemptions (e.g. HMAC webhooks) ----------
        // One NOT(uri == path) leg per exempt path; ANDed into the allowlist
        // rule and reused as the scope-down on body-inspecting managed groups.
        const exemptPathNots: wafv2.CfnWebACL.StatementProperty[] =
            (props.ipAllowlistExemptPaths ?? []).map((path) => ({
                notStatement: {
                    statement: {
                        byteMatchStatement: {
                            searchString: path,
                            positionalConstraint: 'EXACTLY',
                            fieldToMatch: { uriPath: {} },
                            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                        },
                    },
                },
            }));
        let exemptScopeDown: wafv2.CfnWebACL.StatementProperty | undefined;
        if (exemptPathNots.length === 1) exemptScopeDown = exemptPathNots[0];
        if (exemptPathNots.length > 1) exemptScopeDown = { andStatement: { statements: exemptPathNots } };

        // ---------- Rule: BLOCK allowlisted-host traffic from non-allowlisted IPs ----------
        if (hasAllowlist) {
            const ipSetStatement: wafv2.CfnWebACL.StatementProperty =
                ipSetRefs.length === 1 ? ipSetRefs[0] : { orStatement: { statements: ipSetRefs } };

            const hostMatchStatements: wafv2.CfnWebACL.StatementProperty[] = props.allowlistedHosts.map(
                (host) => ({
                    byteMatchStatement: {
                        searchString: host,
                        positionalConstraint: 'EXACTLY',
                        fieldToMatch: { singleHeader: { name: 'host' } },
                        textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                    },
                }),
            );
            const hostMatchAny: wafv2.CfnWebACL.StatementProperty =
                hostMatchStatements.length === 1
                    ? hostMatchStatements[0]
                    : { orStatement: { statements: hostMatchStatements } };

            rules.push({
                name: 'BlockNonAllowlistedAdminTraffic',
                priority: 1,
                action: { block: {} },
                statement: {
                    andStatement: {
                        statements: [
                            hostMatchAny,
                            { notStatement: { statement: ipSetStatement } },
                            // Self-authenticated paths (HMAC webhooks) stay
                            // reachable from non-allowlisted IPs.
                            ...exemptPathNots,
                        ],
                    },
                },
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: `${envName}-${namePrefix}-admin-allowlist`,
                    sampledRequestsEnabled: true,
                },
            });
        }

        // ---------- Rule: rate limit on rate-limited hosts ----------
        if (hasRateLimit) {
            const hostMatchStatements: wafv2.CfnWebACL.StatementProperty[] = props.rateLimitedHosts.map(
                (host) => ({
                    byteMatchStatement: {
                        searchString: host,
                        positionalConstraint: 'EXACTLY',
                        fieldToMatch: { singleHeader: { name: 'host' } },
                        textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                    },
                }),
            );
            const hostScope: wafv2.CfnWebACL.StatementProperty =
                hostMatchStatements.length === 1
                    ? hostMatchStatements[0]
                    : { orStatement: { statements: hostMatchStatements } };

            rules.push({
                name: 'ApiRateLimit',
                priority: 2,
                action: { block: {} },
                statement: {
                    rateBasedStatement: {
                        limit: rateLimitPerIp,
                        aggregateKeyType: 'IP',
                        scopeDownStatement: hostScope,
                    },
                },
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: `${envName}-${namePrefix}-api-rate-limit`,
                    sampledRequestsEnabled: true,
                },
            });
        }

        // ---------- Rule: relax the 8 KB body cap for the app's server functions ----------
        // The SaaS app posts TanStack server-function calls (POST /_serverFn/*)
        // whose serialised body — a pasted job description — routinely exceeds
        // the Common rule set's 8 KB SizeRestrictions_BODY cap, so a full JD is
        // 403'd at the ALB before reaching the app. Those calls are
        // Cognito-authenticated + Zod-validated and admin-api caps the JD at
        // 100 KB, so we override SizeRestrictions_BODY to Count (in the managed
        // loop below) and re-apply an 8 KB body cap to every request EXCEPT that
        // surface here. SQLi/KnownBadInputs body inspection still covers it.
        const oversize = props.oversizeBodyExempt;
        const hasOversizeExempt = oversize !== undefined && oversize.hosts.length > 0;
        if (oversize && hasOversizeExempt) {
            const method = (oversize.method ?? 'POST').toUpperCase();
            const maxBodyBytes = oversize.maxBodyBytes ?? 8192;
            const pathPrefix = oversize.pathPrefix.toLowerCase();

            // Build one exempt surface: <method> <pathPrefix>* [on one of hosts].
            // Hosts omitted → the path is exempt on any host (e.g. /faro/collect,
            // which the ALB routes host-agnostically).
            const buildExemptSurface = (
                surfaceMethod: string,
                surfacePathPrefix: string,
                surfaceHosts?: readonly string[],
            ): wafv2.CfnWebACL.StatementProperty => {
                const legs: wafv2.CfnWebACL.StatementProperty[] = [
                    {
                        byteMatchStatement: {
                            searchString: surfaceMethod,
                            positionalConstraint: 'EXACTLY',
                            fieldToMatch: { method: {} },
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                        },
                    },
                    {
                        byteMatchStatement: {
                            searchString: surfacePathPrefix,
                            positionalConstraint: 'STARTS_WITH',
                            fieldToMatch: { uriPath: {} },
                            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                        },
                    },
                ];
                if (surfaceHosts && surfaceHosts.length > 0) {
                    const hostMatches: wafv2.CfnWebACL.StatementProperty[] = surfaceHosts.map((host) => ({
                        byteMatchStatement: {
                            searchString: host,
                            positionalConstraint: 'EXACTLY',
                            fieldToMatch: { singleHeader: { name: 'host' } },
                            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                        },
                    }));
                    legs.push(hostMatches.length === 1 ? hostMatches[0] : { orStatement: { statements: hostMatches } });
                }
                return { andStatement: { statements: legs } };
            };

            const exemptSurfaces: wafv2.CfnWebACL.StatementProperty[] = [
                buildExemptSurface(method, pathPrefix, oversize.hosts),
                ...(oversize.extraExemptPaths ?? []).map((extra) =>
                    buildExemptSurface(
                        (extra.method ?? 'POST').toUpperCase(),
                        extra.pathPrefix.toLowerCase(),
                        extra.hosts,
                    ),
                ),
            ];
            const serverFnRequest: wafv2.CfnWebACL.StatementProperty =
                exemptSurfaces.length === 1
                    ? exemptSurfaces[0]
                    : { orStatement: { statements: exemptSurfaces } };

            // Re-applies the 8 KB body cap everywhere EXCEPT the server-function
            // surface (SizeRestrictions_BODY is Count'd below). oversizeHandling
            // MATCH treats a body larger than the inspection window as a match,
            // mirroring the managed rule it replaces.
            rules.push({
                name: 'BlockOversizeBodyExceptServerFn',
                priority: 3,
                action: { block: {} },
                statement: {
                    andStatement: {
                        statements: [
                            {
                                sizeConstraintStatement: {
                                    fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
                                    comparisonOperator: 'GT',
                                    size: maxBodyBytes,
                                    textTransformations: [{ priority: 0, type: 'NONE' }],
                                },
                            },
                            { notStatement: { statement: serverFnRequest } },
                        ],
                    },
                },
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: `${envName}-${namePrefix}-oversize-body`,
                    sampledRequestsEnabled: true,
                },
            });
        }

        // ---------- AWS Managed Rule Sets (apply to every host) ----------
        // Body-inspecting groups scope down past the exempt paths: webhook
        // payloads exceed SizeRestrictions_BODY (8 KB) and their code diffs
        // false-positive the SQLi/bad-input body rules. IP reputation only
        // inspects the source address, so it keeps covering every path.
        const managedRules: { name: string; priority: number; metric: string; inspectsBody: boolean }[] = [
            { name: 'AWSManagedRulesCommonRuleSet', priority: 10, metric: 'common-rules', inspectsBody: true },
            { name: 'AWSManagedRulesKnownBadInputsRuleSet', priority: 11, metric: 'known-bad-inputs', inspectsBody: true },
            { name: 'AWSManagedRulesAmazonIpReputationList', priority: 12, metric: 'ip-reputation', inspectsBody: false },
            { name: 'AWSManagedRulesSQLiRuleSet', priority: 13, metric: 'sqli', inspectsBody: true },
        ];
        for (const rule of managedRules) {
            const scopeDownStatement = rule.inspectsBody ? exemptScopeDown : undefined;
            // When the app's server functions are exempted from the 8 KB body
            // cap, override the managed SizeRestrictions_BODY sub-rule to Count —
            // the bespoke BlockOversizeBodyExceptServerFn rule above re-applies
            // the cap to every other request.
            const ruleActionOverrides =
                hasOversizeExempt && rule.name === 'AWSManagedRulesCommonRuleSet'
                    ? [{ name: 'SizeRestrictions_BODY', actionToUse: { count: {} } }]
                    : undefined;
            rules.push({
                name: rule.name,
                priority: rule.priority,
                overrideAction: { none: {} },
                statement: {
                    managedRuleGroupStatement: {
                        vendorName: 'AWS',
                        name: rule.name,
                        ...(scopeDownStatement ? { scopeDownStatement } : {}),
                        ...(ruleActionOverrides ? { ruleActionOverrides } : {}),
                    },
                },
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: `${envName}-${namePrefix}-${rule.metric}`,
                    sampledRequestsEnabled: true,
                },
            });
        }

        this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
            name: `${namePrefix}-${envName}`,
            // WAFv2 description allows only [\w+=:#@/\-,\.\s] — parens
            // (and most punctuation) are rejected.
            description: `Public WAF for the shared EKS ALB - ${envName}`,
            scope: 'REGIONAL',
            defaultAction: { allow: {} },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-webacl`,
                sampledRequestsEnabled: true,
            },
            rules,
        });
        this.webAclArn = this.webAcl.attrArn;
    }
}
