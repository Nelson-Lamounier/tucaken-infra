---
title: admin-api
type: project
tags: [bff, hono, typescript, kubernetes, cognito, postgresql, pgbouncer, k8s-jobs, finops, cloudwatch, cost-explorer, argo-rollouts, argocd, ecr]
sources:
  - api/admin-api/src/index.ts
  - api/admin-api/src/middleware/auth.ts
  - api/admin-api/src/lib/config.ts
  - api/admin-api/src/lib/pg.ts
  - api/admin-api/src/lib/k8s-job-builder.ts
  - api/admin-api/src/routes/finops.ts
  - api/admin-api/src/routes/ingestion.ts
  - api/admin-api/src/routes/pipelines.ts
  - api/admin-api/src/routes/health.ts
  - api/admin-api/package.json
  - api/admin-api/Dockerfile
  - .github/workflows/deploy-api.yml
created: 2026-04-28
updated: 2026-04-28
---

# admin-api

## What it does

admin-api is the BFF (Backend for Frontend) for the **start-admin** TanStack application ([api/admin-api/src/index.ts](../api/admin-api/src/index.ts#L5)). It provides write-heavy REST endpoints for content management, asset uploads, pipeline triggers, and FinOps metrics, all protected by Cognito JWT bearer authentication ([api/admin-api/package.json](../api/admin-api/package.json#L4)).

After the BFF migration, all API calls originate from start-admin's server functions (pod-to-pod). The browser never sends cross-origin requests directly to admin-api ([api/admin-api/src/index.ts](../api/admin-api/src/index.ts#L56)).

Key responsibilities:

- Authenticate every `/api/admin/*` request against a Cognito User Pool using JWKS validation.
- Serve content-management endpoints (articles, applications, assets, resumes).
- Trigger Kubernetes Jobs for data ingestion, article pipeline, and strategist pipeline workloads.
- Expose FinOps read routes backed by CloudWatch and AWS Cost Explorer.
- Surface `/healthz` unauthenticated for Kubernetes liveness and readiness probes.

## Architecture

```mermaid
graph TD
    SA[start-admin TanStack\nserver functions] -->|HTTP :3002| ADMIN[admin-api\nHono / Node 22]

    subgraph admin-api internals
        ADMIN --> MW[cognitoJwtAuth\nmiddleware]
        MW --> ROUTES[Protected routes\n/api/admin/*]
        ADMIN --> HEALTH[/healthz\nunauthenticated]
    end

    ROUTES --> PG[(PostgreSQL\nvia PgBouncer\nmax 5 connections)]
    ROUTES --> K8S[Kubernetes Batch API\ncreateNamespacedJob]
    ROUTES --> CW[CloudWatch\nGetMetricData]
    ROUTES --> CE[Cost Explorer\nGetCostAndUsage\nus-east-1]
    ROUTES --> S3[S3\nasset presign / upload]

    K8S -->|ingestion ns| JOB1[ingestion Job]
    K8S -->|article-pipeline ns| JOB2[article-pipeline Job]
    K8S -->|job-strategist ns| JOB3[strategist-pipeline Job]

    ADMIN -.->|IMDS| IAM[EC2 Instance Profile\nAWS SDK credentials]
```

The server listens on port 3002 ([api/admin-api/src/index.ts](../api/admin-api/src/index.ts#L11)). AWS SDK credentials are never stored in pod environment variables — they come from the EC2 Instance Profile via IMDS ([api/admin-api/src/index.ts](../api/admin-api/src/index.ts#L16)).

## Runtime contract

### Required environment variables

All of the following are validated at startup via `loadConfig()`, which throws immediately on any missing value, producing a CrashLoopBackOff visible in ArgoCD ([api/admin-api/src/lib/config.ts](../api/admin-api/src/lib/config.ts#L172)).

| Variable | Source K8s resource | Purpose |
|---|---|---|
| `ASSETS_BUCKET_NAME` | ConfigMap `admin-api-config` | S3 bucket for media uploads |
| `COGNITO_USER_POOL_ID` | Secret `admin-api-secrets` | JWKS URL construction |
| `COGNITO_CLIENT_ID` | Secret `admin-api-secrets` | JWT `aud` claim validation |
| `COGNITO_ISSUER_URL` | Secret `admin-api-secrets` | JWT `iss` claim validation |
| `AWS_DEFAULT_REGION` | ConfigMap `admin-api-config` | AWS SDK region |
| `PG_HOST` | Secret `platform-rds-credentials` | PgBouncer cluster-internal DNS |
| `PG_PORT` | Secret `platform-rds-credentials` | PgBouncer port |
| `PG_DATABASE` | Secret `platform-rds-credentials` | Database name |
| `PG_USER` | Secret `platform-rds-credentials` | Database user |
| `PG_PASSWORD` | Secret `platform-rds-credentials` | Database password |

### Optional variables with defaults

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | HTTP bind port |
| `INGESTION_NAMESPACE` | `ingestion` | K8s namespace for ingestion Jobs |
| `INGESTION_SERVICE_ACCOUNT` | `ingestion-sa` | ServiceAccount for ingestion Job pods |
| `ARTICLE_PIPELINE_NAMESPACE` | `article-pipeline` | K8s namespace for article-pipeline Jobs |
| `ARTICLE_PIPELINE_SERVICE_ACCOUNT` | `article-pipeline-sa` | ServiceAccount for article-pipeline Job pods |
| `STRATEGIST_PIPELINE_NAMESPACE` | `job-strategist` | K8s namespace for strategist Jobs |
| `STRATEGIST_PIPELINE_SERVICE_ACCOUNT` | `job-strategist-sa` | ServiceAccount for strategist Job pods |
| `JOB_IMAGES_DIR` | `/etc/admin-api/images` | Mount root for ESO-synced Job image URIs |

### Dynamic Job image URIs

The three K8s Job image URIs (`ingestion`, `article-pipeline`, `job-strategist`) are **not** loaded at startup. `getJobImage(name)` reads them from files under `JOB_IMAGES_DIR` on each Job-creation request, with a 30-second in-process TTL cache. The Kubernetes kubelet automatically updates the mounted files when ESO rotates the upstream Secret, so a new image tag is picked up without an admin-api Rollout ([api/admin-api/src/lib/config.ts](../api/admin-api/src/lib/config.ts#L78)).

### External services

| Service | How credentials are obtained |
|---|---|
| PostgreSQL (via PgBouncer) | `platform-rds-credentials` Secret, max 5 pool connections ([api/admin-api/src/lib/pg.ts](../api/admin-api/src/lib/pg.ts#L14)) |
| Kubernetes Batch API | In-cluster ServiceAccount token |
| CloudWatch, Cost Explorer, S3 | EC2 Instance Profile (IMDS) — no secrets in pod |
| Cognito JWKS endpoint | Public HTTPS; `jose` fetches and caches keys in-memory |

## Repository layout

```
api/admin-api/
├── Dockerfile                   # Multi-stage; builder on node:22-alpine, runtime non-root
├── package.json                 # @repo/admin-api v0.1.0
├── jest.config.js               # Extends repo-root esmConfig
├── src/
│   ├── index.ts                 # App entry: port 3002, middleware, route registration
│   ├── middleware/
│   │   └── auth.ts              # cognitoJwtAuth — JWKS validation via jose
│   ├── lib/
│   │   ├── config.ts            # loadConfig() + getJobImage() + isImageConfigured()
│   │   ├── pg.ts                # Lazy PgBouncer Pool singleton (max 5 connections)
│   │   ├── k8s.ts               # getBatchApi() lazy singleton
│   │   ├── k8s-job-builder.ts   # buildPipelineJob() shared by pipeline routes
│   │   └── repositories/        # pg query helpers (pipeline-runs, etc.)
│   └── routes/
│       ├── health.ts            # GET /healthz — unauthenticated
│       ├── articles.ts          # CRUD for article records
│       ├── applications.ts      # CRUD for job application records
│       ├── assets.ts            # S3 presigned URL generation
│       ├── finops.ts            # CloudWatch + Cost Explorer metrics
│       ├── ingestion.ts         # POST /ingestion/trigger — ingestion K8s Job
│       ├── pipelines.ts         # POST /pipelines/article-job/:slug, /strategist-job
│       └── resumes.ts           # Resume management
└── __tests__/
    └── routes/                  # Jest test suites per route
```

## How to run locally

```ts
# From repo root — requires all env vars set in shell or .env
cd api/admin-api
yarn dev         # tsx watch src/index.ts — hot reload
```

For K8s Job dispatch locally, set the env-var fallbacks instead of a file mount ([api/admin-api/src/lib/config.ts](../api/admin-api/src/lib/config.ts#L50)):

```bash
export INGESTION_IMAGE=<repo>:<tag>
export ARTICLE_PIPELINE_IMAGE=<repo>:<tag>
export STRATEGIST_PIPELINE_IMAGE=<repo>:<tag>
```

Run tests:

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn test
```

The Docker image runs as a non-root user (`adminapi`, uid 1001) and exposes port 3002 ([api/admin-api/Dockerfile](../api/admin-api/Dockerfile#L48)).

## Deploy

The CI pipeline is defined in [.github/workflows/deploy-api.yml](../.github/workflows/deploy-api.yml). It triggers on pushes to `develop` affecting `api/admin-api/**` and on `workflow_dispatch`.

The workflow has two jobs ([.github/workflows/deploy-api.yml](../.github/workflows/deploy-api.yml#L65)):

1. **build-admin-api** — builds the Docker image using `api/admin-api/Dockerfile` and saves it as a tar artifact in GHA cache.
2. **push-admin-api** — restores the tar, authenticates to AWS via OIDC, and pushes to the `admin-api` ECR repository (URI stored in SSM at `/shared/ecr-admin-api/{env}/repository-uri`).

After the ECR push there are no further GHA steps. The GitOps delivery path is ([.github/workflows/deploy-api.yml](../.github/workflows/deploy-api.yml#L10)):

```
ECR push
  → ArgoCD Image Updater polls ECR
  → writes new tag to .argocd-source-admin-api.yaml in kubernetes-bootstrap
  → ArgoCD reconciles Application
  → Helm renders Rollout with new image
  → Argo Rollouts drives Blue/Green promotion
  → Manual promotion: kubectl argo rollouts promote admin-api -n admin-api
```

The image tag format is `{git-sha}-r{run_attempt}` ([.github/workflows/deploy-api.yml](../.github/workflows/deploy-api.yml#L59)).

## Related projects

- [cdk-monitoring Platform](cdk-monitoring-platform.md) — canonical platform entry point: ECR repos, Platform RDS, Cognito, and Kubernetes worker nodes that admin-api depends on
- **start-admin** — the TanStack frontend that calls this BFF via server functions.
- **kubernetes-bootstrap** — holds the ArgoCD ApplicationSet and Argo Rollouts configuration for admin-api; owned by the GitOps delivery path.
- **ingestion**, **article-pipeline**, **job-strategist** — the K8s Job workloads that admin-api dispatches; their image URIs are tracked in SSM under `/k8s/{env}/job-images/`.
- [docs/tools/cognito-jwks-middleware.md](../tools/cognito-jwks-middleware.md) — deep-dive on the JWT auth middleware used by this service.

<!--
Evidence trail (auto-generated):
- Source: api/admin-api/src/index.ts (read on 2026-04-28)
- Source: api/admin-api/src/middleware/auth.ts (read on 2026-04-28)
- Source: api/admin-api/src/lib/config.ts (read on 2026-04-28)
- Source: api/admin-api/src/lib/pg.ts (read on 2026-04-28)
- Source: api/admin-api/src/lib/k8s-job-builder.ts (read on 2026-04-28)
- Source: api/admin-api/src/routes/finops.ts (read on 2026-04-28)
- Source: api/admin-api/src/routes/ingestion.ts (read on 2026-04-28)
- Source: api/admin-api/src/routes/pipelines.ts (read on 2026-04-28)
- Source: api/admin-api/src/routes/health.ts (read on 2026-04-28)
- Source: api/admin-api/package.json (read on 2026-04-28)
- Source: api/admin-api/Dockerfile (read on 2026-04-28)
- Source: .github/workflows/deploy-api.yml (read on 2026-04-28)
-->
