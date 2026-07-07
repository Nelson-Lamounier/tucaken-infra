---
title: CloudFront Cache Behaviour First-Match Semantics — Auth Callback Failure
type: troubleshooting
tags: [cloudfront, aws-cdk, authentication, session-cookies, next-js]
sources:
  - infra/lib/stacks/kubernetes/edge-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the pre-EKS public edge (CloudFront / NLB / Traefik), retired in the kubeadm to Amazon EKS migration. The edge is now a single internet-facing ALB with a regional WAFv2 WebACL ([ADR-0010](../../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md)); see [EKS platform architecture](../../concepts/eks-platform-architecture.md). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

`signIn()` silently fails on auth callback routes (`/api/auth/*`) even
though the same auth flow works on other routes. No CloudFront 4xx/5xx
error is returned — the request reaches the origin correctly, but session
cookies are absent from the origin request, causing the auth library to
reject the session.

The failure appears after adding a new cache behaviour for `/api/auth/*`
or after reordering the `additionalBehaviors` list in the CloudFront
distribution CDK code (commit `3dc412d0`).

## Root cause

CloudFront evaluates cache behaviours by **list order** — the first path
pattern in the `additionalBehaviors` array that matches the request URL
wins. CloudFront does NOT evaluate by path specificity (most specific
pattern first).

`/api/auth/*` was listed after `/api/*` in `edge-stack.ts`. Because
`/api/*` appears first in the list, requests to `/api/auth/callback` match
the `/api/*` behaviour before reaching `/api/auth/*`. The `/api/*` behaviour
used the public EIP origin request policy (`eipOriginRequestPolicy`) which
forwards no cookies. The session cookies required for the Auth.js CSRF
double-submit flow were stripped from the origin request, causing `signIn()`
to fail without any observable error response.

This class of bug produces no 4xx/5xx — the request reaches the origin,
but is missing authentication state. Diagnosing it requires reading the
behaviour list order in CDK code, not inspecting request/response logs.

## How to diagnose

```bash
# Check the current behaviour order on the live distribution
aws cloudfront get-distribution-config --id <distribution-id> \
  --query 'DistributionConfig.CacheBehaviors.Items[*].PathPattern' \
  --output text \
  --profile dev-account
```

In CDK, inspect `additionalBehaviors` ordering in `edge-stack.ts`. The
correct precedence order (most specific first):

1. `/api/auth/*` — admin policy (cookies forwarded)
2. `/admin/*` — admin policy (cookies forwarded)
3. `/api/admin/*` — auth no-cache policy (Authorization forwarded)
4. `/api/*` — public policy (no cookies)
5. `/_next/static/*` — static cache
6. `/_next/data/*` — dynamic cache

If `/api/*` appears before `/api/auth/*`, auth callbacks will use the
wrong policy.

The fix in commit `3dc412d0` moved `/api/auth/*` and `/admin/*` before
the catch-all `/api/*` behaviour in the `additionalBehaviors` array at
[`edge-stack.ts:514`](../../../infra/lib/stacks/kubernetes/edge-stack.ts).

## How to fix

Reorder `additionalBehaviors` so more specific patterns appear before
less specific catch-alls. In CDK:

```typescript
additionalBehaviors: [
  // 1. Auth callbacks first — must precede /api/*
  {
    pathPattern: '/api/auth/*',
    cachePolicy: authNoCachePolicy,
    originRequestPolicy: adminOriginRequestPolicy,
    // ...
  },
  // 2. Admin pages
  {
    pathPattern: '/admin/*',
    cachePolicy: authNoCachePolicy,
    originRequestPolicy: adminOriginRequestPolicy,
    // ...
  },
  // 3. Admin API
  {
    pathPattern: '/api/admin/*',
    cachePolicy: authNoCachePolicy,
    // ...
  },
  // 4. Catch-all API — after all specific /api/* patterns
  {
    pathPattern: '/api/*',
    originRequestPolicy: eipOriginRequestPolicy,
    // ...
  },
],
```

After redeploying, invalidate the CloudFront cache for the affected paths:

```bash
aws cloudfront create-invalidation \
  --distribution-id <id> \
  --paths '/api/auth/*' '/admin/*' \
  --profile dev-account
```

## How to prevent

- **Treat `additionalBehaviors` as an ordered list, not a set.** Add a
  comment before the array explaining that order matters and more specific
  patterns must appear first.

- **Test auth flows after every CloudFront behaviour change.** The failure
  is silent — no error response — so automated HTTP status tests will not
  catch it. Manual auth flow verification is required.

- **Use integration tests that inspect which origin request policy applies.**
  A test that confirms cookies arrive at the origin for `/api/auth/callback`
  would have caught this regression.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/edge-stack.ts:514 (read on 2026-04-29)
- Commit: 3dc412d0 — "fix(cloudfront): reorder behaviours — /api/auth/* must precede /api/*" (read on 2026-04-29)
-->
