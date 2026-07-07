---
title: WAF HMAC-Webhook Path Exemption
type: pattern
tags: [aws-cdk, wafv2, alb, eks, security, ip-allowlist, hmac, webhooks, ingress]
sources:
  - infra/lib/constructs/security/eks-public-waf.ts
  - infra/lib/stacks/kubernetes/eks-public-waf-stack.ts
  - infra/lib/projects/kubernetes/factory.ts
created: 2026-07-06
updated: 2026-07-06
---

# WAF HMAC-Webhook Path Exemption

## Problem

One shared ALB fronts three kinds of traffic at once:

- **Operator hosts** (`admin.nelsonlamounier.com`, `ops.nelsonlamounier.com`) — must be reachable only from the operator's IPs (`factory.ts:433-441`).
- **Public product domains** (`tucaken.io`, `tucaken.com`, `api.nelsonlamounier.com`, ...) — open to the world, protected by managed rule sets and a per-IP rate limit (`factory.ts:447-454`).
- **Webhook endpoints** (`/api/github/webhook`) — self-authenticated by HMAC signature, delivered from source IPs that can never be enumerated in advance.

A single default-**ALLOW** REGIONAL WebACL with per-host rules covers the first two cleanly: a host is either IP-gated or rate-limited, and everything else falls through to ALLOW. Webhooks break that model. Their **source IPs are unknowable** (GitHub delivers from its own address ranges, never the operator allowlist), yet the model's only tools for a locked-down host are "is the caller's IP on the list" and "does the body look malicious" — and a webhook payload passes neither test even though it is legitimately authenticated. The authentication lives in the request's HMAC signature, a signal the WebACL rules never consult.

This surfaced as a production outage: GitHub App webhook deliveries to `admin-api` at `/api/github/webhook` never reached the cluster (commit `e6378b50`, 2026-07-02). They were blocked **twice over** — once by the operator IP allowlist (`BlockNonAllowlistedAdminTraffic` 403'd GitHub's IPs) and, once that was lifted, by the Common rule set's `SizeRestrictions_BODY` cap (push payloads exceed 8 KB and code diffs false-positive the SQLi / Known-Bad-Inputs body inspections).

## The pattern

`EksPublicWafConstruct` builds a REGIONAL WebACL with `defaultAction: allow` (`eks-public-waf.ts:250-251`) and layers rules on top by priority:

| Priority | Rule | Action | Scope |
|---|---|---|---|
| 1 | `BlockNonAllowlistedAdminTraffic` | BLOCK | allowlisted hosts from non-allowlisted IPs (`eks-public-waf.ts:154-174`) |
| 2 | `ApiRateLimit` | BLOCK | per-IP rate limit on rate-limited hosts (`eks-public-waf.ts:194-210`) |
| 10 | `AWSManagedRulesCommonRuleSet` | managed (body-inspecting) | every host (`eks-public-waf.ts:219`) |
| 11 | `AWSManagedRulesKnownBadInputsRuleSet` | managed (body-inspecting) | every host (`eks-public-waf.ts:220`) |
| 12 | `AWSManagedRulesAmazonIpReputationList` | managed (source-IP only) | every host (`eks-public-waf.ts:221`) |
| 13 | `AWSManagedRulesSQLiRuleSet` | managed (body-inspecting) | every host (`eks-public-waf.ts:222`) |

The exemption is not a new priority-0 ALLOW rule. It is a **negative scope-down woven into the rules that would otherwise catch the webhook**, so the request simply is never matched by them and falls through to the WebACL's default ALLOW.

Each exempt path becomes a `NOT(uriPath EXACTLY == path)` leg, lowercased (`eks-public-waf.ts:114-132`):

```typescript
const exemptPathNots = (props.ipAllowlistExemptPaths ?? []).map((path) => ({
    notStatement: { statement: { byteMatchStatement: {
        searchString: path,
        positionalConstraint: 'EXACTLY',
        fieldToMatch: { uriPath: {} },
        textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
    } } },
}));
```

Those `NOT` legs are used in two places:

1. **ANDed into the priority-1 allowlist block** (`eks-public-waf.ts:159-167`). The block only fires when the host matches AND the source IP is not allowlisted AND the URI is not an exempt path. So a webhook to an operator host from a GitHub IP does not match — it is never blocked.

2. **Reused as the `scopeDownStatement` on the body-inspecting managed groups** (`eks-public-waf.ts:130-132`, `eks-public-waf.ts:224-234`). The exempt paths are excluded from Common, Known-Bad-Inputs and SQLi.

The construct decides per managed rule whether to attach the scope-down using an `inspectsBody` flag (`eks-public-waf.ts:218-225`): the three body-inspecting sets get it; `AWSManagedRulesAmazonIpReputationList` does not, because it only reads the source address and must keep covering every path.

Concrete wiring for the dev cluster (`factory.ts:455-461`):

```typescript
ipAllowlistExemptPaths: ['/api/github/webhook'],
```

## Why bypass the managed rule sets too, not just the allowlist

Lifting only the IP allowlist is not enough. The body-inspecting managed rules false-positive on legitimate webhook payloads:

- GitHub **push payloads routinely exceed the Common rule set's 8 KB `SizeRestrictions_BODY` cap** (`eks-public-waf.ts:56-59`).
- **Code diffs inside the payload trip the SQLi and Known-Bad-Inputs body inspections** — the diff text looks like an injection attempt to a signature-based scanner.

Because the HMAC signature is the real authentication for these paths, the safe move is a **targeted** bypass on exactly the exempt URIs, not a blanket relaxation. Everything the managed rules add for a webhook is noise; everything they add for the rest of the ALB is retained. Note the IP-reputation set and the rate limit still apply to the exempt paths — the exemption is precisely the IP allowlist plus the three body-inspecting groups, and nothing more (`eks-public-waf.ts:61-62`, `eks-public-waf.ts:213-217`).

## Failure modes

- **Exemption path too broad.** An exempt path is an unauthenticated hole in the operator allowlist and a blind spot for the body rules. If the path matched more than the webhook route (or used a prefix instead of the `EXACTLY` constraint at `eks-public-waf.ts:123`), attacker traffic could reach the origin unfiltered. Keep exempt paths exact and minimal.
- **Exemption missing or typo'd.** The `NOT(uri == path)` leg is an exact, lowercased match. A mistyped path means GitHub webhooks are **silently 403'd** by `BlockNonAllowlistedAdminTraffic` — the exact symptom that motivated commit `e6378b50`. There is no error at deploy time; the only signal is failed webhook deliveries.
- **Allowlist empty at deploy.** The IP sets are created with no addresses at synth (see below). If `EksPublicWafStack` deploys but the `IpSyncFn` Lambda has not run yet, the allowlist is empty and the block rule matches every non-exempt request to an operator host until the sync fires.

## Runtime IP ownership

CDK bakes **no CIDRs** into the CloudFormation template. The IP sets are created whenever `allowlistedHosts` is non-empty, seeded with the empty arrays the stack passes (`eks-public-waf.ts:85-110`; the stack passes `allowlistedIpv4: []` / `allowlistedIpv6: []` at `eks-public-waf-stack.ts:83-92`). Content is owned by the `IpSyncFn` Lambda, which reads the comma-separated CIDRs from SSM and calls `wafv2:UpdateIPSet` (`eks-public-waf-stack.ts:108-156`). An EventBridge rule fires the Lambda on any `Parameter Store Change` to the allowlist SSM parameters (`eks-public-waf-stack.ts:181-193`), so **operator IP changes need no CDK redeploy** — update the SSM parameter and the WAF is refreshed within seconds.

The WebACL ARN is published to SSM at `${ssmPrefix}/eks/waf-acl-arn` (`eks-public-waf-stack.ts:96-100`). Workload Ingresses attach the WebACL to the shared ALB via the `alb.ingress.kubernetes.io/wafv2-acl-arn` annotation, sourced from that SSM value by the `waf-annotator` PostSync Job so the ARN is never hardcoded in git (`eks-public-waf-stack.ts:6-8`, `eks-public-waf-stack.ts:196-240`).

This runtime-owned IP model is the same one covered by [ADR-0010 ALB + WAFv2 edge](../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md); the SSM decoupling it relies on is the [SSM Cross-Stack Discovery Pattern](ssm-cross-stack-pattern.md). For where this WAF sits in the wider platform, see the [EKS platform architecture](../concepts/eks-platform-architecture.md).

<!--
Evidence trail (auto-generated):
- Source: infra/lib/constructs/security/eks-public-waf.ts (read on 2026-07-06)
- Source: infra/lib/stacks/kubernetes/eks-public-waf-stack.ts (read on 2026-07-06)
- Source: infra/lib/projects/kubernetes/factory.ts (read on 2026-07-06)
- Git: commit e6378b50 feat(waf): exempt HMAC webhook path from IP allowlist and body rules (2026-07-02, read on 2026-07-06)
- Git: commit 46980aa1 feat(waf): open Tucaken product domains to the public (2026-07-02, read on 2026-07-06)
-->
</content>
</invoke>
