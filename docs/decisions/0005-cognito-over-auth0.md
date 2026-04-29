---
title: "ADR-004: Amazon Cognito over Auth0 (and Auth.js v5 Credentials)"
type: decision
tags: [aws-cdk, cognito, auth0, authentication, oauth2, nextjs, edge-runtime, security]
sources:
  - infra/lib/stacks/shared/cognito-auth-stack.ts
  - infra/lib/projects/shared/factory.ts
created: 2026-04-28
updated: 2026-04-28
---

# ADR-004: Amazon Cognito over Auth0 (and Auth.js v5 Credentials)

**Date:** 2026-04-28
**Status:** Accepted
**Deciders:** Nelson Lamounier (solo developer)

---

## Context

The Tucaken admin dashboard (`/admin/*`) requires authentication to protect operational pages. Three authentication mechanisms were evaluated:

1. **Auth.js v5 Credentials provider** — custom email/password handler within the Next.js app
2. **Auth0** — third-party managed identity platform
3. **Amazon Cognito** — AWS-managed User Pool with OAuth 2.0 Hosted UI

The admin dashboard is a Next.js 15 application deployed behind CloudFront. The application is the only consumer of this authentication system, and the user base is a single administrator.

---

## Decision

Use Amazon Cognito with OAuth 2.0 Authorization Code flow + next-auth's Cognito provider.

The CDK implementation is `CognitoAuthStack` in `infra/lib/stacks/shared/cognito-auth-stack.ts`. It creates a User Pool (self-sign-up disabled, PLUS feature plan, TOTP MFA optional), a UserPoolClient configured for Authorization Code grant, a Cognito Hosted UI domain, and a pre-seeded admin user. All four outputs (User Pool ID, Client ID, Issuer URL, Domain) are written to SSM.

The authentication flow documented in the stack source:
```
Browser → /admin/login → signIn('cognito') → Cognito Hosted UI
        → OAuth callback → /api/auth/callback/cognito → next-auth session
```

---

## Alternatives considered

### Alternative 1: Auth.js v5 Credentials provider (prior implementation)

This was the original implementation. A custom Credentials provider in next-auth handled email/password validation against a stored hash.

**Problem — Edge Runtime incompatibilities:**
Auth.js v5's Credentials provider depends on `jose` (JWT library) and `CompressionStream`. Both APIs are unavailable in Next.js Edge Runtime, which handles middleware-level route protection. This caused runtime crashes when the middleware tried to decode session tokens.

**Problem — CSRF issues behind CloudFront:**
CloudFront modifies request headers (adds `X-Forwarded-For`, may strip or rewrite `Origin`). The Credentials provider's CSRF token validation failed intermittently when CloudFront's request rewriting caused the `Origin` header to differ from what next-auth expected.

**Problem — self-managed credential storage:**
Credentials providers require storing password hashes. For a single-admin system, this adds operational complexity (hash algorithm choice, salt storage, rotation) with no corresponding benefit over delegating to a managed provider.

The source code documents the migration rationale at `infra/lib/stacks/shared/cognito-auth-stack.ts` lines 6–9:
```
Replaces the previous Auth.js v5 Credentials provider that suffered from
Edge Runtime incompatibilities (jose/CompressionStream) and CSRF issues
behind CloudFront.
```

### Alternative 2: Auth0

Auth0 is a managed identity platform with a generous free tier, strong next-auth integration, and well-tested CloudFront compatibility.

**Problem — external dependency:**
The platform is AWS-native. Adding an external identity provider introduces a third-party service dependency. A Cognito outage (AWS us-east-1) already affects CloudFront ACM — auth being down simultaneously is acceptable because the cause is the same. A separate Auth0 outage would be an independent failure mode with no AWS-side remediation.

**Problem — cost at scale:**
Auth0 free tier supports 7,500 MAU. For a portfolio project, this is irrelevant now, but Auth0's pricing escalates steeply for production SaaS use. Cognito charges $0.0055/MAU after the first 50,000 — the cost difference is meaningful at production scale.

**Problem — SSM integration mismatch:**
The platform distributes all cross-stack configuration via SSM Parameter Store. Auth0 credentials (domain, client ID, secret) would be stored as external secrets and injected via a different mechanism. Cognito outputs are written to SSM by the CDK stack itself (`${ssmPrefix}/auth/cognito-*`), consistent with every other cross-stack output in the platform.

---

## Consequences

**Positive:**
- Eliminates Auth.js Edge Runtime crashes — next-auth's OAuth provider (used for Cognito) operates fully in Node.js runtime, not Edge Runtime
- CSRF is handled by Cognito's Hosted UI, which issues PKCE-verifiable authorization codes — no CloudFront header rewriting affects this flow
- Cognito SSM outputs (`cognito-user-pool-id`, `cognito-client-id`, `cognito-issuer-url`, `cognito-domain`) follow the same SSM pattern as all other platform values
- No third-party external dependency — auth is colocated with the AWS account that runs everything else
- PLUS feature plan with `FULL_FUNCTION` threat protection provides adaptive authentication and compromised-credentials detection at ~$0.05/MAU

**Negative:**
- Cognito Hosted UI cannot be fully customised (CSS-only, no React components). Admin login page appearance is limited to Cognito's hosted UI template.
- User management (password reset, new admin onboarding) requires AWS Console or CLI — no self-service admin UI is built into this stack
- Cognito User Pool ID is region-specific. The stack deploys in `eu-west-1`; any future cross-region expansion requires a separate User Pool or a federation layer.

---

## Implementation reference

- `infra/lib/stacks/shared/cognito-auth-stack.ts` — User Pool, Client, Domain, CfnUserPoolUser, SSM outputs
- `infra/lib/projects/shared/factory.ts` — `CognitoAuthStack` instantiation with environment-specific callback URLs
- SSM paths: `${ssmPrefix}/auth/cognito-user-pool-id`, `.../cognito-client-id`, `.../cognito-issuer-url`, `.../cognito-domain`
- next-auth Cognito provider configuration: `frontend-portfolio` (outside this repo)

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/shared/cognito-auth-stack.ts (read on 2026-04-28)
- Source: infra/lib/projects/shared/factory.ts (read on 2026-04-28)
-->
