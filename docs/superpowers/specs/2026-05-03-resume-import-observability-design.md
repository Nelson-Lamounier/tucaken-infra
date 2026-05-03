# Resume Import — Failure Recovery & Full Observability

**Date:** 2026-05-03
**Repos affected:** `ai-applications`, `cdk-monitoring`, `tucaken-app`, `kubernetes-bootstrap`
**Status:** Approved

---

## Problem

The resume import pipeline has three gaps:

1. **Silent failures** — if the K8s Job crashes before writing to the DB (e.g. DB connection failure, OOMKill), the `resume_imports` record stays in a non-terminal state indefinitely. The frontend polls forever with no resolution.
2. **No retry** — users must re-upload the file to retry a failed import, even though the S3 object is already present.
3. **No observability** — no centralised view of job success/failure rates, step durations, Bedrock agent activity, or pipeline I/O.

---

## Architecture Overview

Four components across three repos:

```
ai-applications/
  applications/platform-job-watcher/   NEW — watches K8s Jobs, writes DB

cdk-monitoring/
  api/admin-api/                        ADD POST /:id/retry endpoint
                                        CHANGE add import-id label to Job spec

tucaken-app/
  src/server/resume-imports.ts          ADD retryFn server function
  src/features/onboarding/.../ImportCareerStep.tsx  CHANGE retry button

kubernetes-bootstrap/
  charts/admin-api/                     ADD watcher Deployment, SA, RBAC, ConfigMap
  charts/monitoring/chart/dashboards/   ADD resume-import-processor.json
```

---

## Component 1: `platform-job-watcher`

### Location
`ai-applications/applications/platform-job-watcher/`

### Runtime
TypeScript / Node.js. Single entrypoint `src/run-watcher.ts`. Deployed as a `Deployment` (1 replica) in the `platform` namespace.

### Two concurrent loops

**Loop 1 — K8s Watch stream (real-time)**
Uses `@kubernetes/client-node` `Watch` API. Streams Job events per configured namespace. On any event where `job.status.failed > 0`:
- Reads `job.metadata.labels['import-id']`
- Writes to the DB:
  ```sql
  UPDATE resume_imports
     SET status = 'failed',
         error_code = 'JOB_FAILED',
         completed_at = NOW()
   WHERE id = $1 AND status NOT IN ('completed', 'failed')
  ```
- Reconnects automatically on stream timeout (Watch streams close after ~5 min by design).

**Loop 2 — Reconciliation sweep (safety net)**
`setInterval` every 5 minutes. One query per configured watcher entry:
```sql
UPDATE resume_imports
   SET status = 'failed',
       error_code = 'WATCHER_TIMEOUT',
       completed_at = NOW()
 WHERE status NOT IN ('completed', 'failed', 'awaiting_upload')
   AND started_at < NOW() - INTERVAL '15 minutes'
```
Catches anything the watch stream missed (pod restart, network blip).

### ConfigMap (`/etc/watcher/config.yaml`)
```yaml
watchers:
  - namespace: resume-import
    dbTable: resume_imports
    staleAfterMinutes: 15
```
Adding a new processor = one new entry, zero code changes.

### K8s resources (in `kubernetes-bootstrap/charts/admin-api/`)
- `Deployment` — 1 replica, `platform` namespace
- `ServiceAccount` + `ClusterRole` — `get/list/watch` on `batch/v1/jobs` cluster-wide
- `ConfigMap` — watcher config
- Uses existing `platform-rds-credentials` Secret

### CI
New `deploy-platform-job-watcher.yml` workflow in `ai-applications`. Same pattern as `deploy-resume-import-processor.yml`. Writes image URI to SSM `/k8s/development/job-images/platform-job-watcher`. ESO syncs to `admin-api-job-images` Secret (new key).

---

## Component 2: Retry Flow

### admin-api — `buildJobSpec` change
Add `import-id` label so the watcher can map Job → DB row without reading pod env vars:
```ts
labels: {
  app: 'resume-import-processor',
  userId: safeUserId,
  'import-id': importId,          // NEW
},
```
Applied to both `metadata.labels` and `template.metadata.labels`.

### admin-api — `POST /api/admin/resume-imports/:id/retry`

Guards:
- Import must exist and belong to the authenticated user
- `status` must be `'failed'` — rejects any other state with 409 Conflict

On success:
```sql
UPDATE resume_imports
   SET status        = 'queued',
       error_code    = NULL,
       error_details = NULL,
       started_at    = NOW(),
       completed_at  = NULL,
       retry_count   = retry_count + 1
 WHERE id = $1 AND user_id = $2 AND status = 'failed'
```
Then re-dispatches a new K8s Job using the existing `s3Key`, `contentType`, and current image URI. No re-upload needed.

### tucaken-app — `retryImportFn`
New server function in `src/server/resume-imports.ts`:
- Calls `POST /api/admin/resume-imports/:id/retry`
- Same `apiFetch` pattern as `completeUploadFn`

### tucaken-app — `ImportCareerStep.tsx` error phase
Current "Try again" button always resets to `idle` (forces re-upload). New logic:

- `importId` is set AND `status === 'failed'` (job was dispatched and failed) → show **"Retry"** button: calls `retryImportFn`, sets phase to `'processing'`, resumes polling. No re-upload.
- `importId` is null (failed before job dispatch, e.g. S3 error) → keep existing **"Try again"** behaviour (resets to `idle`).

The `importId` state variable already distinguishes the two cases — no new state needed.

---

## Component 3: Grafana Dashboard

**Location:** `kubernetes-bootstrap/charts/monitoring/chart/dashboards/resume-import-processor.json`

Loaded automatically by the Grafana sidecar (same mechanism as existing dashboards).

**Dashboard variable:** `$processor` — defaults to `resume-import`. Drives all panel namespace filters. Extensible to other processors by adding variable values.

**Second variable:** `$import_id` — optional, defaults to empty (all). Filters the log stream to a specific import.

### Panels

**Row 1 — Overview**
| Panel | Type | Source |
|---|---|---|
| Job success rate (24h) | Stat | Prometheus `kube_job_status_succeeded / (succeeded + failed)` |
| Active jobs now | Stat | Prometheus `kube_job_status_active{namespace="$processor"}` |
| Total failed today | Stat | Prometheus |
| Median job duration | Stat | Prometheus `kube_job_completion_time - kube_job_start_time` |

**Row 2 — Step Breakdown**
| Panel | Type | Source |
|---|---|---|
| Step transition rate over time | Time-series | Loki — parse `[run-import] <step>` label |
| Step occurrence counts | Bar chart | Loki |

**Row 3 — Failures**
| Panel | Type | Source |
|---|---|---|
| Error rate over time | Time-series | Loki `rate({namespace="$processor"} \|= "fatal error"[5m])` |
| Error breakdown by `error_code` | Bar chart | Loki label extraction + Prometheus |

**Row 4 — Resource Usage**
| Panel | Type | Source |
|---|---|---|
| CPU usage per pod | Time-series | Prometheus `rate(container_cpu_usage_seconds_total{namespace="$processor"}[5m])` |
| Memory working set | Time-series | Prometheus `container_memory_working_set_bytes{namespace="$processor"}` |
| OOMKill events | Stat | Prometheus `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}` |

**Row 5 — Live Log Stream**
Loki log panel: `{namespace="$processor"}` — filterable by `$import_id`.

**Row 6 — Retry Activity**
| Panel | Type | Source |
|---|---|---|
| Retried imports over time | Time-series | Loki — admin-api logs for `/retry` endpoint |
| retry_count distribution | Histogram | Loki label extraction |

**Row 7 — Pipeline I/O**
| Panel | Type | Source |
|---|---|---|
| Upload completions over time | Time-series | Loki `{namespace="admin-api"} \|= "resume-imports" \|= "/complete"` |
| S3 fetch success rate | Time-series | Loki `[run-import] fetching from S3` |
| Average file size parsed (chars) | Stat | Loki `[run-import] parsed text { chars: N }` — label extraction |
| DB write rate per step | Time-series | Loki `[run-import]` step transitions |
| Successful DB writes (terminal) | Stat | Loki `[run-import] completed` count |

**Row 8 — AI Agent Activity**
Requires prerequisite: wire `extract-career.ts` and `enrich-role.ts` to use shared `agent-runner.ts` with `onInvocationComplete` callback (writes to `prompt_invocations`, emits structured log lines).

| Panel | Type | Source |
|---|---|---|
| Bedrock calls per import | Bar chart | `prompt_invocations WHERE pipeline='resume-import'` (PG datasource) |
| Token usage breakdown | Stacked bar | `prompt_invocations` — system/user/output/cache tokens |
| Cost per import | Stat | `SUM(total_cost_cents)` |
| Cache hit rate | Gauge | `cache_hit = true` ratio |
| Latency per agent call | Histogram | `latency_ms` — extract-career vs enrich-role |
| Enrichment search results | Time-series | Loki `[enrich-role] Tavily results { count: N }` |

---

## Component 4: `agent-runner` Wiring (Prerequisite for Row 8)

**Files to change:**
- `applications/resume-import-processor/src/bedrock/extract-career.ts`
- `applications/resume-import-processor/src/bedrock/enrich-role.ts`
- `applications/resume-import-processor/src/run-import.ts`

**Change:** Pass `onInvocationComplete` callback to `runAgent()` in both bedrock functions. The callback inserts a row into `prompt_invocations` with `pipeline = 'resume-import'`. Already implemented in `job-strategist` and `article-pipeline` — resume-import is missing the wiring only.

---

## Implementation Order

1. `buildJobSpec` label change — unlocks the watcher
2. `platform-job-watcher` app + K8s manifests + CI workflow
3. Retry endpoint in admin-api
4. Frontend retry button in tucaken-app
5. `agent-runner` wiring in resume-import-processor
6. Grafana dashboard JSON — Rows 1–7 first, Row 8 after step 5
