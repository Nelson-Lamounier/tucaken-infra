---
title: "RDS Postgres / pgvector — Observability Review"
type: concept
tags: [rds, postgres, pgvector, observability, grafana, cloudwatch, prometheus, monitoring, performance-insights]
sources:
  - Grafana dashboard uid=database ("Database — RDS Postgres / pgvector")
  - AWS CloudWatch AWS/RDS (k8s-dev-platform-rds-iso)
  - Prometheus (pgbouncer + postgres exporters)
created: 2026-07-04
updated: 2026-07-04
---

# RDS Postgres / pgvector — Observability Review

Point-in-time audit of the Grafana `database` dashboard against what the live
instance actually emits. Recorded as the baseline before closing the gaps.

> **Update (2026-07-05) — partly superseded.** The CloudWatch-datasource
> remediation described below (hardcoded-id → wildcard) was an interim step. The
> RDS metric panels have since been migrated **off the Grafana CloudWatch
> datasource onto Prometheus via YACE** — the panels now query `aws_rds_*`
> series and the datasource's structural faults (no template-variable
> interpolation into dimensions; image-renderer cannot query it) no longer
> apply. RDS alerts now live in Prometheus too. See the current design:
> `kubernetes-bootstrap/docs/projects/rds-observability-yace-migration.md`.
> This document is retained as the point-in-time baseline.

- **Instance:** `k8s-dev-platform-rds-iso` — `db.t4g.small`, gp2, PostgreSQL 18.3, eu-west-1
- **Reviewed:** 2026-07-04
- **Verdict:** Strong on application, pgvector and product analytics; **blind on the
  box itself.** The dashboard *has* an "RDS instance health" row with 6 CloudWatch
  metric panels (CPU, DB connections, memory, storage, IOPS, latency) + 3 log
  panels — but **all 14 instance references were hardcoded to the pre-migration
  name `k8s-dev-platform-rds`, so every one was broken** (querying the deleted
  instance). Beyond that it was missing burst credits, throughput/network, disk
  queue, Performance Insights DB load, and all engine-health signals. The
  **postgres_exporter is down** (no `pg_stat_*`), and **Performance Insights is
  enabled but unused** in Grafana. On a burstable class whose credit exhaustion
  has already caused an outage, this was the priority gap.

> **Remediation (2026-07-04)** — closed in `kubernetes-bootstrap`
> (feat/rds-observability-close-gaps): introduced an `rds_instance` dashboard
> variable and repointed all panels at it (drift can no longer silently break
> them); added 6 rows / 22 panels — compute & burst credits, throughput &
> network, PI DB load, live-SQL engine health, PgBouncer traffic & wait, and
> connection failures; added Prometheus alerts (`PgBouncerDown`,
> `PgBouncerClientsWaiting`, `PgBouncerClientMaxWaitHigh`, `PostgresExporterDown`).
> **Follow-ups:** fix the postgres_exporter connection (P0), and add CloudWatch
> RDS alarms (CPU credits / memory / storage / disk-queue / connections) as CDK
> alarms with the RDS stack — Prometheus cannot see AWS/RDS metrics.

## Instance configuration (verified live)

| Setting | Value |
|---|---|
| Performance Insights | **Enabled**, 7-day retention (unused in Grafana) |
| Enhanced Monitoring | **Enabled**, 60s interval |
| CloudWatch log exports | `postgresql`, `upgrade` |
| Class / storage | `db.t4g.small` (burstable) / gp2 |
| CloudWatch AWS/RDS metrics emitted | **40** (0 shown on the dashboard) |

## 1. What the dashboard covers today (17 panels)

| Lane | Source | Panels | Status |
|---|---|---|---|
| Connection pooling | prometheus · pgbouncer | client active/waiting, server active/idle | Partial |
| App-side DB perf | prometheus · spanmetrics | DB calls/s by service, p95 latency by service | Client-side only |
| pgvector / KB | rds-postgres (SQL) | vectors by repo, total, table size, index health | Good |
| Postgres logs | cloudwatch · logs insights | recent errors, error rate/min, connection events/min | Partial |
| Product / business | rds-postgres (SQL) | users by plan, Bedrock spend, repos+KB quality, directory | Belongs on product dashboard |
| **Infrastructure / OS** | — | CPU, memory, burst credits, disk, IOPS, engine health | **Absent** |

## 2. Gap analysis (mapped to the review questions)

Sources marked **[collected]** already flow and only need panels; **[fix]** needs a
collection fix first.

### OS / system view & burst credits — CRITICAL
- **Today:** nothing. No CPU, memory, swap, or credit visibility.
- **Risk:** CPU-credit exhaustion on the old `t4g.micro` caused `ECONNREFUSED`/
  timeouts and forced the bump to `t4g.small`; it is currently invisible.
- **Add [collected — CloudWatch AWS/RDS]:** `CPUUtilization`, `CPUCreditBalance`,
  `CPUCreditUsage`, `FreeableMemory`, `SwapUsage`, `BurstBalance`, `EBSIOBalance%`,
  `EBSByteBalance%`; Enhanced Monitoring per-process / loadavg.

### Connections (number & state) — HIGH
- **Today:** only PgBouncer pool counts.
- **Add:** `DatabaseConnections` **[collected — CloudWatch]**; connections-by-state,
  `conns ÷ max_connections %`, longest running txn/query, blocked backends
  **[fix — pg_stat_activity]**.

### Data trafficking between systems — HIGH
- **Today:** only "DB calls/s by service" (traces).
- **Add [collected]:** `NetworkReceiveThroughput`, `NetworkTransmitThroughput`,
  `ReadThroughput`, `WriteThroughput`, `ReadIOPS`, `WriteIOPS` (CloudWatch);
  `rate(pgbouncer_stats_totals_received_bytes_total)` and `..._sent_bytes_total`
  (Prometheus — collected, not panelled).

### RDS latency (engine & disk) — HIGH
- **Today:** application-side span p95 only (client view; includes network + pool wait).
- **Add [collected]:** `ReadLatency`, `WriteLatency`, `DiskQueueDepth`, `DBLoad`,
  `DBLoadCPU`, `DBLoadNonCPU` (CloudWatch); `pgbouncer_pools_client_maxwait_seconds`
  (Prometheus). Performance Insights wait-events / top-SQL drill-down.

### Connection & log errors — MEDIUM
- **Today:** generic `ERROR|FATAL|WARNING` and raw connection-event log panels.
- **Add:** categorised failures — "too many clients"/"remaining connection slots",
  "password authentication failed", "no pg_hba.conf entry"; `IamDbAuthConnectionFailure*`
  **[collected — CloudWatch]**. **Verify the log group targets `-iso`.**

### Engine health missing entirely — MEDIUM
- **Add [fix — pg_stat_*]:** cache hit ratio, xact commit/rollback rate, deadlocks,
  temp files/bytes, locks/blocked queries, dead tuples / autovacuum lag,
  `pg_stat_statements` top queries. **[collected — CloudWatch]:**
  `MaximumUsedTransactionIDs` (wraparound), `FreeStorageSpace` trend.

## 3. Live snapshot — 2026-07-04

Latest CloudWatch datapoints (proves the series exist and flow):

| Metric | Value | Note |
|---|---:|---|
| DatabaseConnections | 11 | RDS-side; pool ≤20 |
| CPUUtilization | 8.7 % | headroom |
| CPUCreditBalance | 73 cr | t4g burst — the outage metric |
| FreeableMemory | 260 MB | **tight on ~2 GB — watch** |
| FreeStorageSpace | 17.6 GB | of 20 GB (autoscale → 100) |
| ReadLatency | 0.76 ms | fast |
| WriteLatency | 1.38 ms | fast |
| DiskQueueDepth | 0.04 | no IO contention |
| DBLoad (PI) | 0.0 AAS | idle at sample time |
| NetworkTransmit | 718 KB/s | out (recv 8.5 KB/s) |
| MaximumUsedTransactionIDs | ~550k | wraparound safe (~2B) |
| IAM auth failures | 0 | clean |

## 4. Findings to fix before adding panels

1. **postgres_exporter down (CRITICAL).** Prometheus has the exporter's own
   `postgres_exporter_config_last_reload_*` series but **zero** `pg_up`,
   `pg_stat_database_*`, `pg_stat_activity_*`, `pg_locks_*`. The exporter runs but
   cannot reach/authenticate to the DB — almost certainly the same host-rename /
   password-rotation drift that took PgBouncer and the chatbot down. Fixing it
   unlocks the entire engine-health lane.
2. **Log panels may point at the old instance (HIGH).** The instance was renamed
   `k8s-dev-platform-rds` → `-iso`; confirm the CloudWatch Logs Insights panels
   target `/aws/rds/instance/k8s-dev-platform-rds-iso/postgresql`.

## 5. Recommendations (priority order)

- **P0** — Fix the postgres_exporter connection (host + CDK secret; add `reloader`
  annotation so it survives rotations). Unblocks engine-health lane.
- **P0** — Add an OS / burst row from CloudWatch (zero collection effort).
- **P1** — Add RDS latency, IO & traffic rows (CloudWatch + PgBouncer bytes).
- **P1** — Add a connections row (`DatabaseConnections` vs `max_connections`,
  by-state, pool maxwait).
- **P1** — Surface Performance Insights DB load (`DBLoad*`) + link to PI.
- **P2** — Categorise connection failures; add engine-health panels.
- **P2** — Wire alert rules: `CPUCreditBalance < 30`, `FreeableMemory < 128 MB`,
  `FreeStorageSpace < 2 GB`, `DatabaseConnections > 80% max`, sustained
  `DiskQueueDepth > 5`, `deadlocks > 0`, `pg_up == 0`.

## Related

- [Platform RDS — Networking, Isolated-Subnet Migration & PgBouncer](platform-rds-networking.md)
- [Monitoring Strategy](monitoring-strategy.md)
- [FinOps Observability](finops-observability.md)
