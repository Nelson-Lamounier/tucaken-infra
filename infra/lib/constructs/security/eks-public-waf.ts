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
     * IPv4 CIDRs allowed to reach `allowlistedHosts`. Empty list means the
     * allowlist rule is omitted (no host gets gated). Supply the operator's
     * home IP at minimum.
     */
    readonly allowlistedIpv4: readonly string[];
    /** IPv6 CIDRs allowed to reach `allowlistedHosts`. */
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
}

export class EksPublicWafConstruct extends Construct {
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly webAclArn: string;
    /** undefined when no IPv4 CIDRs were supplied */
    public readonly ipv4Set?: wafv2.CfnIPSet;
    /** undefined when no IPv6 CIDRs were supplied */
    public readonly ipv6Set?: wafv2.CfnIPSet;

    constructor(scope: Construct, id: string, props: EksPublicWafProps) {
        super(scope, id);

        const { envName, namePrefix } = props;
        const rateLimitPerIp = props.rateLimitPerIp ?? 2000;
        const allowlistedIpv6 = props.allowlistedIpv6 ?? [];
        const hasAllowlist =
            (props.allowlistedIpv4.length > 0 || allowlistedIpv6.length > 0)
            && props.allowlistedHosts.length > 0;
        const hasRateLimit = props.rateLimitedHosts.length > 0;

        // ---------- IP sets (only when allowlist is configured) ----------
        const ipSetRefs: wafv2.CfnWebACL.StatementProperty[] = [];
        if (hasAllowlist) {
            if (props.allowlistedIpv4.length > 0) {
                this.ipv4Set = new wafv2.CfnIPSet(this, 'AllowIpv4', {
                    name: `${namePrefix}-allow-ipv4-${envName}`,
                    scope: 'REGIONAL',
                    ipAddressVersion: 'IPV4',
                    addresses: [...props.allowlistedIpv4],
                });
                ipSetRefs.push({ ipSetReferenceStatement: { arn: this.ipv4Set.attrArn } });
            }
            if (allowlistedIpv6.length > 0) {
                this.ipv6Set = new wafv2.CfnIPSet(this, 'AllowIpv6', {
                    name: `${namePrefix}-allow-ipv6-${envName}`,
                    scope: 'REGIONAL',
                    ipAddressVersion: 'IPV6',
                    addresses: [...allowlistedIpv6],
                });
                ipSetRefs.push({ ipSetReferenceStatement: { arn: this.ipv6Set.attrArn } });
            }
        }

        const rules: wafv2.CfnWebACL.RuleProperty[] = [];

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
        const managedRules: { name: string; priority: number; metric: string }[] = [
            { name: 'AWSManagedRulesCommonRuleSet', priority: 10, metric: 'common-rules' },
            { name: 'AWSManagedRulesKnownBadInputsRuleSet', priority: 11, metric: 'known-bad-inputs' },
            { name: 'AWSManagedRulesAmazonIpReputationList', priority: 12, metric: 'ip-reputation' },
            { name: 'AWSManagedRulesSQLiRuleSet', priority: 13, metric: 'sqli' },
        ];
        for (const rule of managedRules) {
            rules.push({
                name: rule.name,
                priority: rule.priority,
                overrideAction: { none: {} },
                statement: {
                    managedRuleGroupStatement: {
                        vendorName: 'AWS',
                        name: rule.name,
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
