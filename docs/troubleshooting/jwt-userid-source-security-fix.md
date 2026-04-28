---
title: JWT userId Source Security Fix
type: troubleshooting
tags: [security, jwt, userid, impersonation, admin-api, ingestion, cognito, hono]
sources:
  - api/admin-api/src/routes/ingestion.ts
  - api/admin-api/src/routes/applications.ts
  - api/admin-api/src/routes/pipelines.ts
  - api/admin-api/src/middleware/auth.ts
created: 2026-04-28
updated: 2026-04-28
---

## Symptom

Any caller with a valid Cognito JWT could supply an arbitrary `userId` field in the
HTTP request body and have that value embedded in the K8s Job metadata (labels, env vars)
and written to the `pipeline_runs` table. A legitimate authenticated user could therefore
trigger a Job or pipeline run that appears to belong to a different user — effectively
impersonating that user for audit and access-control purposes.

The vulnerability existed specifically in the ingestion trigger route. The route
accepted `body.userId` directly from the JSON request body without any validation that it
matched the authenticated principal.

Fix commit: `5c16de5d` — `fix(admin-api): take ingestion userId from JWT + sanitize K8s name/labels`

## Root Cause

Before commit `5c16de5d`, `routes/ingestion.ts` defined `userId` as a field of
`TriggerBody` and extracted it from the parsed request body:

```ts
// VULNERABLE — before 5c16de5d
interface TriggerBody {
    readonly userId?:        string;  // client-supplied, unvalidated
    readonly repoFullName?:  string;
    readonly forceReindex?:  boolean;
}

// Inside the route handler:
const userId = body.userId?.trim();
if (!userId) return ctx.json({ error: '"userId" is required' }, 400);
```

The Cognito JWT middleware (`src/middleware/auth.ts`) had already validated the token and
stored the verified payload at `ctx.get('jwtPayload')`, but the ingestion handler ignored
it. This gave the JWT's `sub` claim no authority over the identity used within the system.
[`api/admin-api/src/routes/ingestion.ts` before commit `5c16de5d`]

The same risk was already absent from the pipelines and applications routes, which had
always read `userId` from `jwtPayload.sub`. Only the ingestion route was affected.

## How to Diagnose

Look for routes that pass `userId` through to downstream systems (K8s labels, PG rows,
env vars) but derive it from `ctx.req.json()` instead of `ctx.get('jwtPayload')`:

```ts
// SAFE — take from verified JWT payload
const jwtPayload = ctx.get('jwtPayload');
const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);

// UNSAFE — take from request body
const body = await ctx.req.json<{ userId?: string }>();
const userId = body.userId?.trim();
```

Confirmed safe pattern in the fixed ingestion route:
[`api/admin-api/src/routes/ingestion.ts`, lines 102–104]

```ts
const jwtPayload = ctx.get('jwtPayload');
const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);
```

The same pattern is used consistently in pipelines:
[`api/admin-api/src/routes/pipelines.ts`, lines 103–105 and 172–174]

And in applications:
[`api/admin-api/src/routes/applications.ts`, lines 190–192]

## How to Fix

1. Remove `userId` from `TriggerBody` (or any equivalent request-body interface).
2. Extract `userId` exclusively from the validated JWT payload stored in Hono context:

```ts
const jwtPayload = ctx.get('jwtPayload');
const userId = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : '';
if (!userId) return ctx.json({ error: 'Authenticated subject missing' }, 401);
```

3. Ensure the middleware that populates `jwtPayload` runs before the route handler.
   In this codebase, `cognitoJwtAuth(...)` is mounted at the parent router level in
   `src/index.ts`, so all sub-routes already inherit it.
   [`api/admin-api/src/middleware/auth.ts`, lines 60–96]

4. The fix in commit `5c16de5d` also introduced `sanitizeLabel()` to the ingestion route
   so that the `userId` value (now sourced from Cognito's sub claim, which may contain
   uppercase letters, dots, or other characters) is safe for use as a Kubernetes DNS
   label before being embedded in `jobName` and the `labels` map.
   [`api/admin-api/src/routes/ingestion.ts`, lines 29–31]

## How to Prevent

- **Never accept identity fields from request bodies in authenticated routes.** The
  JWT `sub` claim is the only trusted source of the caller's identity once the token is
  verified.
- When adding a new route that dispatches a K8s Job or writes to an audit table, copy
  the `ctx.get('jwtPayload').sub` extraction pattern verbatim before any body parsing.
- Route tests must include a case that asserts the `userId` embedded in the Job spec
  matches the JWT sub, not any value supplied in the request body. The ingestion test
  suite now covers this:
  [`api/admin-api/__tests__/routes/ingestion.test.ts`, lines 133–136]

  ```ts
  expect(body.userId).toBe('test-user');          // comes from jwtPayload mock
  expect(envMap['USER_ID']).toBe('test-user');    // propagated to Job env
  ```

<!--
Evidence trail (auto-generated):
- Source: api/admin-api/src/routes/ingestion.ts (read on 2026-04-28)
- Source: api/admin-api/src/routes/applications.ts (read on 2026-04-28)
- Source: api/admin-api/src/routes/pipelines.ts (read on 2026-04-28)
- Source: api/admin-api/src/middleware/auth.ts (read on 2026-04-28)
- Source: api/admin-api/__tests__/routes/ingestion.test.ts (read on 2026-04-28)
- Git commit: 5c16de5d (inspected on 2026-04-28)
-->
