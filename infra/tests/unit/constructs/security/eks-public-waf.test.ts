/** @format */
import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { EksPublicWafConstruct } from '../../../../lib/constructs/security/eks-public-waf';

const WEBHOOK_PATH = '/api/github/webhook';

const synth = (exemptPaths?: readonly string[]): Template => {
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
    });
    return Template.fromStack(stack);
};

type Rule = {
    Name: string;
    Statement: {
        AndStatement?: { Statements: unknown[] };
        ManagedRuleGroupStatement?: { ScopeDownStatement?: unknown };
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
