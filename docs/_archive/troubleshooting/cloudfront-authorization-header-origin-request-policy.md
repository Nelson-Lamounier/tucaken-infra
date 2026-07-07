---
title: CloudFront OriginRequestPolicy Blocks Authorization Header
type: troubleshooting
tags: [cloudfront, aws-cdk, authentication, authorization, cache-policy]
sources:
  - infra/lib/constructs/networking/cloudfront.ts
  - infra/lib/stacks/kubernetes/edge-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the pre-EKS public edge (CloudFront / NLB / Traefik), retired in the kubeadm to Amazon EKS migration. The edge is now a single internet-facing ALB with a regional WAFv2 WebACL ([ADR-0010](../../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md)); see [EKS platform architecture](../../concepts/eks-platform-architecture.md). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

A CDK stack deploy fails with:

```
UnscopedValidationError: The parameter Authorization is not allowed in
OriginRequestPolicy headerBehavior.
```

This error occurs at CloudFormation deploy time (not at CDK synth time)
when an `OriginRequestPolicy` includes `Authorization` in its
`headerBehavior.allowList`. The stack rolls back.

Alternatively (if deployed without the explicit allowList): requests with
`Authorization: Bearer <token>` headers reach CloudFront but the token is
not forwarded to the origin. The admin-api returns 401 for requests from
server functions calling `/api/admin/*` via the public CloudFront URL.

## Root cause

AWS explicitly blocks `Authorization` from being included in an
`OriginRequestPolicy`. This constraint is enforced at the AWS API level
and documented in the CloudFront API reference, but the AWS CDK
documentation for `OriginRequestHeaderBehavior.allowList()` does not
surface this restriction clearly.

The `OriginRequestPolicy` is the natural place to forward auth headers
(it controls what is forwarded to the origin), so engineers add
`Authorization` there first. AWS rejects it with `UnscopedValidationError`.

The correct approach is to include `Authorization` in the `CachePolicy`'s
`headerBehavior` instead. CloudFront adds the header to the cache key AND
forwards it to the origin. With `TTL=0`, the cache key is never used for
actual caching, so there is no risk of caching responses keyed on the
token.

The fix is in `edge-stack.ts` at the `authNoCachePolicy` definition
([`edge-stack.ts:513-523`](../../../infra/lib/stacks/kubernetes/edge-stack.ts)):

```typescript
const authNoCachePolicy = new cloudfront.CachePolicy(this, 'AuthNoCachePolicy', {
  comment: 'No caching — passes Set-Cookie headers for Auth.js CSRF/session flow',
  defaultTtl: cdk.Duration.seconds(0),
  maxTtl: cdk.Duration.seconds(1),
  minTtl: cdk.Duration.seconds(0),
  cookieBehavior: cloudfront.CacheCookieBehavior.all(),
  queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
  headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'), // here, not ORP
  enableAcceptEncodingGzip: false,
  enableAcceptEncodingBrotli: false,
});
```

## How to diagnose

```bash
# Check OriginRequestPolicy headers for the affected distribution
aws cloudfront list-origin-request-policies \
  --type custom \
  --query 'OriginRequestPolicyList.Items[*].OriginRequestPolicy.OriginRequestPolicyConfig.HeadersConfig' \
  --profile dev-account

# Check if Authorization appears in any ORP
aws cloudfront get-origin-request-policy \
  --id <policy-id> \
  --query 'OriginRequestPolicy.OriginRequestPolicyConfig.HeadersConfig.Headers.Items' \
  --profile dev-account
```

In CDK source, grep for `Authorization` in OriginRequestPolicy contexts:

```bash
grep -rn "originRequestHeaders\|OriginRequestHeaderBehavior\|Authorization" \
  infra/lib/config/ infra/lib/constructs/networking/
```

If `Authorization` appears in `originRequestHeaders` (used as input to
`OriginRequestHeaderBehavior.allowList()`), that is the bug.

## How to fix

1. Remove `Authorization` from `originRequestHeaders` in the CloudFront
   config (`infra/lib/config/nextjs.ts`).

2. Add `Authorization` to the `headerBehavior` of the `CachePolicy` used
   for the affected behaviour, with `TTL=0`:

```typescript
headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
```

3. Ensure the behaviour that serves `/api/admin/*` uses this `CachePolicy`
   (not `CACHING_DISABLED`). `CACHING_DISABLED` does not forward headers
   in the same way.

4. The `OriginRequestPolicy` for this behaviour should NOT include
   `Authorization` — leave it for the CachePolicy.

## How to prevent

- **Never put `Authorization` in an `OriginRequestPolicy`.** AWS blocks
  this at the API level. The CachePolicy is the correct location for
  forwarding auth headers with TTL=0.

- **TTL=0 with `headerBehavior` does not mean the header is cached.** The
  header is included in the cache key (preventing cross-user cache hits)
  but CloudFormation never stores a response with TTL=0. This is the
  intended pattern for forwarding sensitive headers through CloudFront.

- **Add a comment in the CachePolicy definition** explaining this
  constraint so future engineers do not move `Authorization` back to the
  OriginRequestPolicy.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/edge-stack.ts:513-523 (read on 2026-04-29)
- Source: infra/lib/constructs/networking/cloudfront.ts (referenced via commit 2094a8c3)
- Commit: 2094a8c3 — "fix(cloudfront): forward Authorization header via CachePolicy for admin-api auth" (read on 2026-04-29)
-->
