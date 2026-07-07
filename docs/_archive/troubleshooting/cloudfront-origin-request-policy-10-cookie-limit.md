---
title: CloudFront OriginRequestPolicy Hard Limit of 10 Cookies
type: troubleshooting
tags: [cloudfront, aws-cdk, cookies, authentication, next-js, auth-js]
sources:
  - infra/lib/config/nextjs.ts
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the pre-EKS public edge (CloudFront / NLB / Traefik), retired in the kubeadm to Amazon EKS migration. The edge is now a single internet-facing ALB with a regional WAFv2 WebACL ([ADR-0010](../../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md)); see [EKS platform architecture](../../concepts/eks-platform-architecture.md). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

Auth intermittently fails after adding a new session cookie or authentication
system. The failure is inconsistent — some auth flows succeed, others fail —
and there is no 4xx/5xx error from CloudFront or the origin. The symptom
appears to be an application-level auth bug.

Alternatively, a CDK stack deploy fails with:

```
InvalidArgument: The number of cookies in the allowList exceeds the
maximum allowed value of 10.
```

## Root cause

CloudFront `OriginRequestPolicy` enforces a hard limit of **10 forwarded
cookies** per policy. When the `allowList` exceeds 10 entries, either AWS
rejects the policy at deploy time (explicit error), or trailing cookie
entries in an oversized list are silently dropped at runtime (if the list
reached the limit gradually).

Auth.js v5 generates multiple per-session cookie names — both `__Secure-`
prefixed variants (used over HTTPS) and non-prefixed fallbacks (used when
the CloudFront-to-origin connection is HTTP). The initial cookie list for
the admin dashboard included 9 distinct Auth.js cookies, leaving only 1
slot. Adding Cognito PKCE cookies (`__session`, `oauth_state`,
`pkce_verifier`) — three additional cookies — pushed the total to 12,
exceeding the limit (commit `cafdf329`).

The `AUTH_COOKIES` constant in
[`infra/lib/config/nextjs.ts:76-89`](../../../infra/lib/config/nextjs.ts)
is the source of truth for the cookie allowList. The file includes
`MAX_CLOUDFRONT_COOKIES = 10` and a `validateAuthCookies()` function that
enforces this limit at synth time
([`nextjs.ts:97-146`](../../../infra/lib/config/nextjs.ts)).

## How to diagnose

```bash
# Count cookies currently in AUTH_COOKIES
grep -A30 "export const AUTH_COOKIES" infra/lib/config/nextjs.ts | grep -c "'[a-z_]"

# Check the live OriginRequestPolicy cookie count
aws cloudfront get-origin-request-policy \
  --id <admin-policy-id> \
  --query 'OriginRequestPolicy.OriginRequestPolicyConfig.CookiesConfig.Cookies.Quantity' \
  --profile dev-account
```

If `cdk synth` fails with `InvalidArgument`, the count in `AUTH_COOKIES`
exceeds 10. If auth is intermittently failing, count the cookies:

```typescript
// In nextjs.ts — this will throw at synth time if > 10
validateAuthCookies();
```

The validation guards against three failure modes
([`nextjs.ts:110-146`](../../../infra/lib/config/nextjs.ts)):
1. Wildcard characters (`*`, `?`) — treated as literal strings by CloudFront
2. Count exceeding `MAX_CLOUDFRONT_COOKIES` (10)
3. Duplicate entries

## How to fix

Reduce the cookie allowList to 10 or fewer entries. Two approaches:

**Remove stale entries.** Auth.js v5 PKCE cookies that are no longer used
by any application can be removed. The comment block in `AUTH_COOKIES`
documents which cookies are active vs. retained for future use.

**Consolidate active cookies.** The current `AUTH_COOKIES` list has 10
entries — exactly at the limit. Future additions require removing an equal
number. Review the comment for cookies marked as retained but no longer
actively used before adding new entries.

The fix in commit `cafdf329` removed the stale PKCE code verifier and
state cookies that were no longer used by any auth flow:

```typescript
// Removed (stale — no longer used by any app):
// - `__Secure-authjs.pkce.code_verifier` / `authjs.pkce.code_verifier`
// - `authjs.state`
```

After modifying `AUTH_COOKIES`, `cdk synth` will catch violations before
any deploy attempt.

## How to prevent

- **The `validateAuthCookies()` function runs at module load time during
  `cdk synth`.** Any violation throws an error before synthesis completes,
  preventing a bad deploy. This is the primary safeguard
  ([`nextjs.ts:148-150`](../../../infra/lib/config/nextjs.ts)).

- **Document cookie purpose in `AUTH_COOKIES` comments.** The current
  implementation includes inline comments marking cookies as active or
  retained. Keep these current to make future cleanup decisions clear.

- **Budget cookies.** With 10 slots and two auth systems (Cognito PKCE
  needs 3, Auth.js needs ~6), the margin is thin. Any new authentication
  system must account for the constraint before adding cookies.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/config/nextjs.ts:59-150 (read on 2026-04-29)
- Commit: cafdf329 — "fix(cloudfront): consolidate auth.js cookies into wildcard to bypass Origin Request Policy 10-cookie limits" (read on 2026-04-29)
-->
