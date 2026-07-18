/** @format */
import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { EksPublicWafConstruct, OversizeBodyExemptConfig } from '../../../../lib/constructs/security/eks-public-waf';

const WEBHOOK_PATH = '/api/github/webhook';

const synth = (exemptPaths?: readonly string[], oversizeBodyExempt?: OversizeBodyExemptConfig): Template => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Test', { env: { account: '123456789012', region: 'eu-west-1' } });
    new EksPublicWafConstruct(stack, 'Waf', {
        envName: 'development',
        namePrefix: 'eks-public',
        allowlistedIpv4: [],
        allowlistedIpv6: [],
        allowlistedHosts: ['admin.example.com', 'ops.example.com'],
        rateLimitedHosts: ['api.example.com'],
        ipAllowlistExemptPaths: exemptPaths,
        oversizeBodyExempt,
    });
    return Template.fromStack(stack);
};

type Rule = {
    Name: string;
    Statement: {
        AndStatement?: { Statements: unknown[] };
        ManagedRuleGroupStatement?: { ScopeDownStatement?: unknown; RuleActionOverrides?: unknown[] };
    };
};

const rulesOf = (template: Template): Rule[] => {
    const acl = Object.values(template.findResources('AWS::WAFv2::WebACL'))[0];
    return (acl.Properties as { Rules: Rule[] }).Rules;
};

describe('EksPublicWafConstruct — ipAllowlistExemptPaths', () => {
    it('should add a NOT(uri == path) leg to the allowlist rule so HMAC webhooks bypass the IP gate', () => {
        const rules = rulesOf(synth([WEBHOOK_PATH]));
        const allowlist = rules.find((r) => r.Name === 'BlockNonAllowlistedAdminTraffic');
        const legs = allowlist!.Statement.AndStatement!.Statements;
        // host-match OR, NOT(ip sets), NOT(webhook path)
        expect(legs).toHaveLength(3);
        expect(JSON.stringify(legs[2])).toContain(WEBHOOK_PATH);
        expect(JSON.stringify(legs[2])).toContain('UriPath');
    });

    it('should scope body-inspecting managed groups past the exempt path; IP reputation keeps full coverage', () => {
        const rules = rulesOf(synth([WEBHOOK_PATH]));
        for (const name of ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesSQLiRuleSet']) {
            const scopeDown = rules.find((r) => r.Name === name)?.Statement.ManagedRuleGroupStatement?.ScopeDownStatement;
            expect(scopeDown).toBeDefined();
            expect(JSON.stringify(scopeDown)).toContain(WEBHOOK_PATH);
        }
        const ipRep = rules.find((r) => r.Name === 'AWSManagedRulesAmazonIpReputationList');
        expect(ipRep?.Statement.ManagedRuleGroupStatement?.ScopeDownStatement).toBeUndefined();
    });

    it('should emit no exemption legs or scope-downs when the prop is omitted (back-compat)', () => {
        const rules = rulesOf(synth());
        const allowlist = rules.find((r) => r.Name === 'BlockNonAllowlistedAdminTraffic');
        expect(allowlist?.Statement.AndStatement?.Statements).toHaveLength(2);
        for (const r of rules) {
            expect(r.Statement.ManagedRuleGroupStatement?.ScopeDownStatement).toBeUndefined();
        }
    });
});

describe('EksPublicWafConstruct — oversizeBodyExempt', () => {
    const OVERSIZE: OversizeBodyExemptConfig = { hosts: ['tucaken.io', 'www.tucaken.io'], pathPrefix: '/_serverfn/' };

    const commonOverrides = (t: Template): unknown[] | undefined =>
        rulesOf(t).find((r) => r.Name === 'AWSManagedRulesCommonRuleSet')!
            .Statement.ManagedRuleGroupStatement?.RuleActionOverrides;

    it('should override SizeRestrictions_BODY to Count on the Common rule set', () => {
        const overrides = commonOverrides(synth(undefined, OVERSIZE));
        expect(JSON.stringify(overrides)).toContain('SizeRestrictions_BODY');
        expect(JSON.stringify(overrides)).toContain('Count');
    });

    it('should re-apply the body cap to every request except the server-function surface', () => {
        const guard = rulesOf(synth(undefined, OVERSIZE)).find((r) => r.Name === 'BlockOversizeBodyExceptServerFn');
        expect(guard).toBeDefined();
        const s = JSON.stringify(guard);
        expect(s).toContain('SizeConstraintStatement');
        expect(s).toContain('NotStatement');
        expect(s).toContain('/_serverfn/');
        expect(s).toContain('tucaken.io');
    });

    it('should emit no oversize rule or override when the prop is omitted (back-compat)', () => {
        expect(rulesOf(synth()).find((r) => r.Name === 'BlockOversizeBodyExceptServerFn')).toBeUndefined();
        expect(commonOverrides(synth())).toBeUndefined();
    });

    it('should exempt extra surfaces from the re-applied cap: any-host telemetry + host-scoped webhook', () => {
        // Codifies the 2026-07-18 live fix: Faro RUM batches (/faro/collect,
        // any host) and large GitHub push deliveries (/api/github/webhook on
        // the admin host) were being 403'd by the re-applied 8 KB cap.
        const cfg: OversizeBodyExemptConfig = {
            ...OVERSIZE,
            extraExemptPaths: [
                { pathPrefix: '/faro/collect' },
                { pathPrefix: '/api/github/webhook', hosts: ['admin.example.com'] },
            ],
        };
        const guard = rulesOf(synth(undefined, cfg)).find((r) => r.Name === 'BlockOversizeBodyExceptServerFn');
        expect(guard).toBeDefined();
        const s = JSON.stringify(guard);
        // All three surfaces present, OR'd inside the NOT
        expect(s).toContain('/_serverfn/');
        expect(s).toContain('/faro/collect');
        expect(s).toContain('/api/github/webhook');
        expect(s).toContain('admin.example.com');
        expect(s).toContain('OrStatement');
    });

    it('should not host-scope an extra surface that omits hosts', () => {
        const cfg: OversizeBodyExemptConfig = {
            hosts: ['tucaken.io'],
            pathPrefix: '/_serverfn/',
            extraExemptPaths: [{ pathPrefix: '/faro/collect' }],
        };
        const guard = rulesOf(synth(undefined, cfg)).find((r) => r.Name === 'BlockOversizeBodyExceptServerFn');
        const not = JSON.stringify(guard!.Statement.AndStatement!.Statements[1]);
        // The faro leg carries method + path only — exactly one Host header
        // matcher may appear in the whole NOT (the server-fn surface's).
        const hostMatches = (not.match(/"SingleHeader":\{"Name":"host"\}/gi) ?? not.match(/host/gi) ?? []).length;
        expect(not).toContain('/faro/collect');
        expect((not.match(/singleheader/gi) ?? []).length).toBe(1);
    });
});
