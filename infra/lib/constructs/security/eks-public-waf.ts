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
            rules.push({
                name: rule.name,
                priority: rule.priority,
                overrideAction: { none: {} },
                statement: {
                    managedRuleGroupStatement: {
                        vendorName: 'AWS',
                        name: rule.name,
                        ...(scopeDownStatement ? { scopeDownStatement } : {}),
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
