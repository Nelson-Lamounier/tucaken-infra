# KB Discovery Report — cdk-monitoring

**Generated:** 2026-04-28
**Repository:** cdk-monitoring
**Passes completed:** 1, 2, 3, 4, 5
**Total candidates identified:** 17
**Total files scanned (deep):** 18 (index.ts files, package.json, workflow files, route files, jest configs)
**Commits inspected:** 20

---

## Executive summary

| Category | Count | Already documented | To document |
|:---------|------:|------------------:|------------:|
| Tools | 4 | 0 | 4 |
| Concepts | 4 | 0 | 4 |
| Patterns | 1 | 1 | 0 |
| Decisions | 3 | 0 | 3 |
| Troubleshooting | 2 | 0 | 2 |
| Runbooks | 0 | 0 | 0 |
| Projects | 3 | 0 | 3 |
| **Total** | **17** | **1** | **16** |

---

## Top 10 priority candidates

| Rank | Candidate | Category | Score | Reference path |
|-----:|:----------|:---------|------:|:---------------|
| 1 | admin-api BFF | project | 25 | `api/admin-api/src/index.ts` |
| 2 | CI/CD pipeline architecture | concept | 25 | `.github/workflows/ci.yml` |
| 3 | GitOps deployment flow (ADR) | decision | 25 | `.github/workflows/deploy-api.yml` |
| 4 | cdk-governance-aspects package | project | 20 | `packages/cdk-governance-aspects/src/` |
| 5 | AMI refresh IAM troubleshooting | troubleshooting | 20 | `infra/lib/constructs/events/ami-refresh/` |
| 6 | ADR: GitOps over direct K8s deploy | decision | 20 | `.github/workflows/deploy-api.yml` |
| 7 | K8s Job dispatch pattern | pattern | 16 | `api/admin-api/src/lib/k8s-job-builder.ts` |
| 8 | Cognito JWKS middleware | concept | 16 | `api/admin-api/src/middleware/auth.ts` |
| 9 | Platform RDS + PgBouncer | concept | 16 | `infra/lib/stacks/kubernetes/platform-rds-stack.ts` |
| 10 | Checkov + cdk-nag dual security | concept | 12 | `.checkov/config.yaml`, `.github/workflows/ci.yml` |

---

## Existing documentation status

### Already documented — no action needed

- `docs/concepts/nlb-architecture.md` — NLB design, EIP SubnetMapping, health checks, live state
- `docs/concepts/cloudfront-distribution.md` — dual-origin, WAF, cache policies, AUTH_COOKIES
- `docs/concepts/asg-configuration.md` — three-pool ASG, Spot, Cluster Autoscaler
- `docs/concepts/launch-template-configuration.md` — LT blueprint, IMDSv2, AMI refresh workflow
- `docs/concepts/security-group-configuration.md` — all six SGs, port rationale
- `docs/concepts/self-healing-ssm-integration.md` — Bedrock agent, ConverseCommand loop
- `docs/concepts/cloudwatch-logs-strategy.md` — log groups, retention tiers, KMS
- `docs/concepts/monitoring-strategy.md` — Prometheus, Grafana, Loki, Alloy
- `docs/concepts/networking-observability.md` — VPC flow logs, NLB access logs
- `docs/adrs/0001` through `docs/adrs/0005` — all five ADRs documented
- `docs/patterns/project-factory-pattern.md` — Abstract Factory pattern
- `docs/patterns/ssm-cross-stack-pattern.md` — SSM over CloudFormation exports
- `docs/projects/cdk-platform-stacks.md` — stack inventory reference

### Documented but stale — needs update

- `docs/projects/cdk-platform-stacks.md` — references "16 stacks" but Platform RDS stack was recently added (phase 1 plan is implemented); count and stack list likely stale.

### Orphaned candidates — reference paths point outside this repo

- `cdk.out/Bedrock-*.template.json` (8 templates) — Bedrock stacks existed in CDK but `infra/lib/stacks/bedrock/` is absent. These templates are from a prior monorepo era. Any Bedrock documentation in this repo would be orphaned.
- `infra/lib/config/kubernetes/configurations.ts:212,358,363` — `@deprecated` single-node worker config kept during migration window. If the K8s-native worker migration is complete, these are orphaned config entries, not documentation candidates.
- `lambda/eip-failover/` — deprecated Lambda source (covered by ADR-005). No documentation needed; the dist/ declaration file can be deleted once the migration window closes.

---

## Tools

### High priority (score ≥ 16)

#### Cognito JWKS Middleware (jose)

- **Category:** tool + concept
- **Reference paths:**
  - `api/admin-api/src/middleware/auth.ts`
  - `api/admin-api/__tests__/routes/health.test.ts`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Implements stateless JWT validation using `jose`'s `createRemoteJWKSet`. Per-pool JWKS cache avoids redundant HTTP fetches. Handles `kid` rotation automatically when a new JWT references an unknown key. The `/healthz` route is explicitly exempted from auth so Kubernetes liveness probes work without tokens. Demonstrates production-grade Cognito integration beyond the typical "add Cognito to API Gateway" pattern.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the Cognito JWKS JWT middleware in admin-api.
   Reference paths: api/admin-api/src/middleware/auth.ts"
  ```

#### Hono BFF Framework

- **Category:** tool
- **Reference paths:**
  - `api/admin-api/src/index.ts`
  - `api/admin-api/package.json`
- **Skill-evidence score:** 3
- **Recruiter-relevance score:** 3
- **Priority:** 9
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Hono is a lightweight web framework chosen over Express/Fastify. The `index.ts` comments explain the CORS model (server-function pod-to-pod means browser never sends cross-origin requests; CORS is defence-in-depth). Documents the port split (public-api 3001, admin-api 3002) and credential model (IMDS for AWS SDK, Secret for Cognito IDs, ConfigMap for resource names).

### Medium priority (score 9–15)

#### Checkov IaC Security Scanner

- **Category:** tool
- **Reference paths:**
  - `.checkov/config.yaml`
  - `.github/workflows/ci.yml` (iac-security-scan job)
  - `.checkov/custom_checks/`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 3
- **Priority:** 12
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Checkov runs against synthesised CDK CloudFormation templates. SARIF output uploaded to GitHub Security tab for inline PR annotations (`github/codeql-action/upload-sarif`). Blocks on CRITICAL/HIGH; soft-fails on LOW/MEDIUM. `skip-check` list is documented with rationale (e.g., CDK custom resource Lambdas cannot be given VPC/DLQ). Separate from cdk-nag (real-time synth feedback) — the two tools are complementary, not redundant.

#### Dependency-Cruiser

- **Category:** tool
- **Reference paths:**
  - `.dependency-cruiser.cjs`
  - `infra/package.json` (deps-check-ci script)
- **Skill-evidence score:** 3
- **Recruiter-relevance score:** 3
- **Priority:** 9
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Enforces architectural layer boundaries (no circular imports, no cross-layer violations). Runs in CI via `just deps-check-ci`. Demonstrates awareness of dependency management beyond linting.

---

## Concepts

### High priority (score ≥ 16)

#### CI/CD Pipeline Architecture

- **Category:** concept
- **Reference paths:**
  - `.github/workflows/ci.yml`
  - `.github/workflows/deploy-kubernetes.yml`
  - `.github/workflows/deploy-api.yml`
  - `.github/workflows/_deploy-stack.yml`
  - `.github/actions/setup-node-yarn/`
  - `.github/actions/configure-aws/`
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 5
- **Priority:** 25
- **Existing documentation:** `docs/runbooks/gh-workflow-dispatch.md` (trigger reference only — does not explain architecture)
- **Reference paths exist:** yes
- **Notes:** The CI pipeline has 11 jobs with change detection (`dorny/paths-filter`) that gates expensive jobs when only unrelated files changed. Custom CI image on GHCR avoids dependency installation overhead. Checkov SARIF → GitHub Security integration. actionlint validates workflow files in CI (with shellcheck disabled — rationale documented inline). CDK synth validation with `--no-lookups` using `cdk.context.json` cache. Snapshot tests explicitly kept local-only. Reusable `_deploy-stack.yml` workflow parameterised per stack. The deploy-api workflow dropped kubectl entirely in favour of ArgoCD Image Updater + Argo Rollouts Blue/Green. This entire architecture is undocumented.

#### Platform RDS + PgBouncer

- **Category:** concept
- **Reference paths:**
  - `infra/lib/stacks/kubernetes/platform-rds-stack.ts`
  - `api/admin-api/src/lib/pg.ts`
  - `docs/plans/2026-04-24-phase1-platform-rds.md`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** `docs/plans/2026-04-24-phase1-platform-rds.md` (implementation plan, not a concept doc)
- **Reference paths exist:** yes
- **Notes:** PostgreSQL 16 (with `allowMajorVersionUpgrade` for 16→18 path) in SharedVpc. `pg.ts` uses a lazy Pool singleton through PgBouncer in transaction mode: max 5 client connections multiplexed to ≤20 server connections. The BFF pool-size decision is intentional (low memory footprint in K8s pod). Phase 1 plan exists as a planning doc but there is no concept document explaining the live architecture.

#### Checkov + cdk-nag Dual-Layer IaC Security

- **Category:** concept
- **Reference paths:**
  - `.checkov/config.yaml`
  - `infra/lib/constructs/` (cdk-nag NagSuppressions)
  - `.github/workflows/ci.yml`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 3
- **Priority:** 12
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Two complementary security layers: cdk-nag runs at `cdk synth` time providing inline IDE feedback; Checkov runs in CI against synthesised templates providing blocking gates on CRITICAL/HIGH. The two tools catch different classes of issues (cdk-nag: CDK-level rule violations; Checkov: CloudFormation template security posture). Custom Checkov checks in `.checkov/custom_checks/` extend the ruleset.

#### FinOps Observability Route

- **Category:** concept
- **Reference paths:**
  - `api/admin-api/src/routes/finops.ts`
  - `infra/lib/stacks/shared/finops-stack.ts`
- **Skill-evidence score:** 3
- **Recruiter-relevance score:** 3
- **Priority:** 9
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Admin API exposes a `/realtime` endpoint that reads Bedrock multi-agent CloudWatch custom metrics (token usage, latency) and a billing endpoint hitting AWS Cost Explorer. Direct CloudWatch + Cost Explorer access from BFF rather than a dedicated Lambda. Demonstrates FinOps awareness in platform engineering.

---

## Patterns

### High priority (score ≥ 16)

#### K8s Job Dispatch Pattern

- **Category:** pattern
- **Reference paths:**
  - `api/admin-api/src/lib/k8s-job-builder.ts`
  - `api/admin-api/src/lib/k8s.ts`
  - `api/admin-api/src/routes/applications.ts`
  - `api/admin-api/src/routes/ingestion.ts`
  - `api/admin-api/src/routes/pipelines.ts`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Three routes (article-pipeline, strategist-pipeline, coach-pipeline) dispatch Kubernetes Jobs from the BFF using in-cluster ServiceAccount credentials. `k8s-job-builder.ts` centralises conventions: 63-char DNS-label limit, SHA-1-derived deterministic suffix to deduplicate concurrent requests, sanitised label values, sensible resource requests/limits (768Mi/300m req, 2Gi/1000m limit), `restartPolicy: Never`. Image URIs read from `/etc/admin-api/images/*` ConfigMap files — not env vars — enabling per-job image updates without pod restarts. Lazy singleton `getBatchApi()` loads in-cluster config once.

---

## Decisions

### High priority (score ≥ 16)

#### ADR: GitOps over Direct Kubernetes Deploy

- **Category:** decision
- **Reference paths:**
  - `.github/workflows/deploy-api.yml` (lines 1-45, rationale comment block)
  - `.github/workflows/deploy-api.yml` (previous k8s-runner deploy job removed)
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 5
- **Priority:** 25
- **Existing documentation:** none — this is an **implicit ADR** with explicit rationale written as workflow comments but never recorded as `docs/adrs/0006-*.md`
- **Reference paths exist:** yes
- **Notes:** The `deploy-api.yml` workflow comment block explicitly documents the decision: dropped the k8s-runner ARC job that wrote SSM + ran `deploy.py` in favour of ArgoCD Image Updater + Argo Rollouts Blue/Green. Reasons stated: Image Updater polls ECR independently; deploy.py decommissioned post-Phase-2; K8s-level operations now owned by `kubernetes-bootstrap`. The decision to use Blue/Green with Prometheus error-rate + P95 latency analysis for pre-promotion gates is not recorded anywhere outside this comment. This deserves `docs/adrs/0006-gitops-over-direct-k8s-deploy.md`.

#### ADR: K8s Job Images from ConfigMap Files vs Env Vars

- **Category:** decision
- **Reference paths:**
  - `api/admin-api/src/lib/config.ts`
  - `api/admin-api/__tests__/lib/config.test.ts`
  - Commit: `78f6e724 feat(admin-api): resolve K8s Job image URIs from /etc/admin-api/images/* files`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** K8s Job image URIs are read from `/etc/admin-api/images/<app>` filesystem paths (ConfigMap volume mount) rather than env vars. The commit message and `config.ts` comments explain why: image updates via ConfigMap don't require pod restart; each job image is independently versioned; `isImageConfigured()` returns a 502 guard rather than launching a misconfigured Job. This is a non-obvious architectural choice warranting an ADR or pattern doc.

#### ADR: Argo Rollouts Blue/Green with Prometheus Analysis

- **Category:** decision
- **Reference paths:**
  - `.github/workflows/deploy-api.yml` (lines 1-45)
  - Kubernetes-bootstrap (ApplicationSet, Rollout config — cross-repo reference)
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** none
- **Reference paths exist:** YES for the rationale; NO for the Rollout spec (lives in `kubernetes-bootstrap`)
- **Notes:** Argo Rollouts drives Blue/Green for admin-api. Pre-promotion analysis uses Prometheus error-rate + P95 latency metrics from Traefik. Manual promotion command noted in workflow comment. This is a significant progressive delivery pattern. The Rollout spec lives in `kubernetes-bootstrap` but the decision rationale is in `cdk-monitoring` workflow comments.

---

## Troubleshooting

### High priority (score ≥ 16)

#### AMI Refresh IAM Permission Series

- **Category:** troubleshooting
- **Reference paths:**
  - `infra/lib/constructs/events/ami-refresh/` (Lambda handlers)
  - Git commits: `55c524bd`, `97a9ec41`, `cb50ca54`, `41412376`, `01998902`, `e411137d`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 5
- **Priority:** 20
- **Existing documentation:** none (concept doc covers the architecture but not the fix series)
- **Reference paths exist:** yes
- **Notes:** Six sequential `fix(ami-refresh)` commits document a real IAM debugging session: `ec2:RunInstances` missing → add it → `aws:CalledVia` condition rejected by ASG context → drop CalledVia → `iam:PassRole` required → `ec2:Describe*` required on `*` → `ec2:CreateTags` required. Each commit has a clear symptom in the message. The root causes demonstrate the subtlety of IAM policies for ASG-initiated EC2 launches vs direct SDK calls. This is high-value troubleshooting documentation that shows systematic IAM debugging.

#### JWT userId Source — Ingestion Route Security Fix

- **Category:** troubleshooting
- **Reference paths:**
  - `api/admin-api/src/routes/applications.ts`
  - `api/admin-api/src/routes/ingestion.ts`
  - Commit: `5c16de5d fix(admin-api): take ingestion userId from JWT + sanitize K8s name/labels`
- **Skill-evidence score:** 3
- **Recruiter-relevance score:** 3
- **Priority:** 9
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Bug: `userId` was taken from the request body, allowing a caller to impersonate any user. Fix: always extract `userId` from the validated JWT payload (`ctx.get('jwtPayload')`). Demonstrates understanding of JWT-as-source-of-truth for identity in BFF security.

---

## Projects

### High priority (score ≥ 16)

#### admin-api — BFF for start-admin TanStack App

- **Category:** project
- **Reference paths:**
  - `api/admin-api/src/index.ts`
  - `api/admin-api/src/middleware/auth.ts`
  - `api/admin-api/src/lib/k8s-job-builder.ts`
  - `api/admin-api/src/lib/pg.ts`
  - `api/admin-api/src/routes/`
  - `api/admin-api/__tests__/`
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 5
- **Priority:** 25
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Hono BFF serving 8 route groups (articles, applications, assets, finops, ingestion, pipelines, resumes, health). Protected entirely by Cognito JWKS JWT middleware except `/healthz` (K8s probe exemption). Credential model: IMDS for AWS SDK (no secrets in pod), Cognito IDs via K8s Secret, resource names via ConfigMap. Dispatches K8s Jobs for 3 ML pipelines. Connects to PostgreSQL via PgBouncer. Includes FinOps route reading CloudWatch + Cost Explorer. Full Jest test coverage at route + repository level. Runs on port 3002 in-cluster. Deployed via GitOps (no kubectl in CI).

#### cdk-governance-aspects — Published npm Package

- **Category:** project
- **Reference paths:**
  - `packages/cdk-governance-aspects/src/enforce-readonly-dynamodb-aspect.ts`
  - `packages/cdk-governance-aspects/src/tagging-aspect.ts`
  - `packages/cdk-governance-aspects/test/`
  - `packages/cdk-governance-aspects/package.json`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 5
- **Priority:** 20
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Published as `@nelsonlamounier/cdk-governance-aspects` on npm. Two CDK Aspects: (1) `EnforceReadOnlyDynamoDbAspect` — validates ECS task roles never contain DynamoDB write actions (`PutItem`, `DeleteItem`, `UpdateItem`, `BatchWriteItem`), enforcing the dual-path architecture boundary where SSR reads direct and writes go through API Gateway; (2) `TaggingAspect` — automated resource tagging across all constructs. Both have unit tests. Demonstrates understanding of CDK Aspect pattern for cross-cutting governance, and ability to publish reusable infrastructure packages.

#### admin-api Jest Test Suite

- **Category:** project (test architecture)
- **Reference paths:**
  - `api/admin-api/__tests__/routes/`
  - `api/admin-api/__tests__/lib/repositories/`
  - `api/admin-api/jest.config.js`
- **Skill-evidence score:** 3
- **Recruiter-relevance score:** 4
- **Priority:** 12
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Full Jest coverage across 7 route files + 3 repository files + config. Tests mock the K8s BatchV1Api, PostgreSQL pool, and AWS SDK clients. The `_resetBatchApi()` export on `k8s.ts` is an explicit test seam. Config tests verify sentinel-value handling for missing image URIs (502 guard). Worth documenting as a testing-patterns entry rather than a standalone project doc.

---

## Skip list

| Path | Reason |
|:-----|:-------|
| `lambda/eip-failover/` | Deprecated — covered by ADR-005; dist/ declaration file is the only remaining artifact |
| `lambda/ecr-deploy/` | CDK bootstrap utility, no skill-evidence value |
| `scripts/cluster-health.sh` | Operational script — runbook candidate only if it documents non-obvious K8s health checks; low priority |
| `scripts/sync-static-to-s3.ts` | Simple S3 sync utility, boilerplate |
| `scripts/push-to-ecr.ts` | ECR push helper, boilerplate |
| `infra/lib/stacks/kubernetes/api-stack.ts` | Subscription Lambda + API Gateway — the interesting parts (DLQ, WAF, SES) overlap with existing docs; remaining content is standard boilerplate |
| `infra/lib/stacks/shared/finops-stack.ts` | CloudWatch dashboard provisioning; interesting only as part of a broader monitoring concept doc which already exists |
| `.github/workflows/day-1-orchestration.yml` | Day-1 bootstrap orchestration — unique but highly specific to initial cluster setup; low re-use value as a doc |
| `cdk.out/Bedrock-*.template.json` | Stale artifacts from prior monorepo era; code no longer in this repo |
| `justfile` | Task runner recipes — already referenced in runbooks and CI docs; no standalone doc needed |

---

## Recommended next actions

Top 5 items to address with kb-doc, in priority order:

1. **admin-api BFF** (`api/admin-api/src/index.ts`) — Highest skill-evidence project in the repo with zero documentation. Covers Hono, Cognito JWKS, K8s Job dispatch, PgBouncer, and full test architecture in one doc.
   ```
   "Use kb-doc to document the admin-api BFF. Reference paths: api/admin-api/src/index.ts, api/admin-api/src/middleware/auth.ts, api/admin-api/src/lib/k8s-job-builder.ts, api/admin-api/src/lib/pg.ts"
   ```

2. **ADR-006: GitOps over direct K8s deploy** (`.github/workflows/deploy-api.yml`) — The rationale is already written in the workflow file comments; kb-doc just needs to formalise it as `docs/adrs/0006-gitops-over-direct-k8s-deploy.md`. High resume impact.
   ```
   "Use kb-doc to write ADR-006 for the GitOps over direct K8s deploy decision. Reference: .github/workflows/deploy-api.yml lines 1-45"
   ```

3. **CI/CD pipeline architecture** (`.github/workflows/ci.yml`) — 11-job pipeline with change detection, Checkov SARIF, actionlint, CDK synth validation. Nothing documented. Core DevOps portfolio piece.
   ```
   "Use kb-doc to document the CI/CD pipeline architecture. Reference paths: .github/workflows/ci.yml, .github/workflows/deploy-kubernetes.yml, .github/actions/"
   ```

4. **cdk-governance-aspects npm package** (`packages/cdk-governance-aspects/`) — Published package demonstrating CDK Aspect pattern + DynamoDB access governance. Strong differentiator.
   ```
   "Use kb-doc to document the cdk-governance-aspects npm package. Reference paths: packages/cdk-governance-aspects/src/, packages/cdk-governance-aspects/test/"
   ```

5. **AMI refresh IAM troubleshooting** (`infra/lib/constructs/events/ami-refresh/`) — Six sequential fix commits with clear root causes. High-value troubleshooting doc.
   ```
   "Use kb-doc to document the AMI refresh IAM permission troubleshooting. Reference: infra/lib/constructs/events/ami-refresh/ and git log fix(ami-refresh) commits"
   ```

---

## Coverage gaps

- **Argo Rollouts Blue/Green** — The promotion policy, Prometheus analysis queries, and rollback behaviour live in `kubernetes-bootstrap`, not here. The decision rationale is in `cdk-monitoring`. A concept doc here would need cross-repo references. Flag when running kb-discovery on `kubernetes-bootstrap`.
- `infra/tests/unit/constructs/` — Sampled at depth-1 only. Construct-level test patterns (esbuild mock, jest-worker-setup) may warrant a testing-patterns doc.
- `infra/lambda/dns/` + `infra/lambda/subscriptions/` — Lambda handlers not scanned deeply. May contain troubleshooting candidates.

---

## Delta from previous scan

No prior report found in `.claude/skills/kb-discovery/reports/`. This is the initial scan.
