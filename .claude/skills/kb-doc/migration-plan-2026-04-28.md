# KB Doc Internal Migration Plan — 2026-04-28 (post-external-cleanup)

> **Status:** Awaiting user approval. No files will be changed until approval is given.
> **Scope:** Internal restructure only. External migration (kubernetes/, bedrock/, AI-review
> files) was executed in a prior session. This plan covers the 37 files that remain.

---

## Summary

| Action | Count |
|:-------|------:|
| KEEP   | 29    |
| MOVE   | 3     |
| MERGE  | 1     |
| DELETE | 5     |

---

## KEEP — no action needed (29 files)

All files already in the correct subfolder per the kb-doc decision tree:

- `docs/README.md` — index
- `docs/adrs/` (5 files) — `0001` through `0005`
- `docs/concepts/` (9 files) — all correctly placed
- `docs/patterns/` (2 files)
- `docs/projects/` (1 file)
- `docs/runbooks/` (3 files)
- `docs/decisions/0002-tucaken-architecture-migration.md` — intentionally separate from `adrs/`; covers larger migration strategy, not a narrow ADR
- `docs/plans/` (3 files) — active execution plans with agentic worker directives; intentionally separate
- `docs/articles/` (1 file) + `docs/articles-draft/` (2 files) — blog content, not KB docs; intentionally separate

---

## MOVE — 3 files

### 1. `docs/gh-workflow-dispatch.md` → `docs/runbooks/gh-workflow-dispatch.md`

**Classification:** Runbook.
Operational procedure reference: `gh` CLI syntax + project-specific workflow
commands (`deploy-kubernetes.yml`, `gitops-k8s.yml`, `deploy-ssm-automation.yml`).
Matches `runbooks/` type exactly. Currently stranded at root instead of subfolder.

**Action:** `git mv docs/gh-workflow-dispatch.md docs/runbooks/gh-workflow-dispatch.md`

Add frontmatter (currently absent):
```yaml
---
title: GitHub Workflow Dispatch Reference
type: runbook
tags: [github-actions, ci-cd, workflow-dispatch, gh-cli]
sources: []
created: 2026-04-28
updated: 2026-04-28
---
```

**README.md:** Move row from "Infrastructure Reference" → "Runbooks" table.

---

### 2. `docs/networking-observability.md` → `docs/concepts/networking-observability.md`

**Classification:** Concept.
Explains the observability strategy across the full traffic path: VPC flow logs,
NLB access logs, CloudWatch metrics. Conceptual + reference content. No overlap
with `concepts/monitoring-strategy.md` (which covers Prometheus/Grafana/Loki
in-cluster stack) or `concepts/cloudwatch-logs-strategy.md` (which covers log
group inventory and retention tiers). This file covers the *networking traffic
path* observability layer specifically.

**Action:** `git mv docs/networking-observability.md docs/concepts/networking-observability.md`

Add frontmatter (currently absent):
```yaml
---
title: Networking Observability
type: concept
tags: [vpc-flow-logs, nlb, cloudwatch, observability, networking]
sources:
  - infra/lib/stacks/kubernetes/base-stack.ts
created: 2026-04-28
updated: 2026-04-28
---
```

**README.md:** Move row from "Networking & Edge" → "Concepts" table.

---

### 3. `docs/cloudwatch-steampipe-data-paths.md` → `docs/concepts/cloudwatch-steampipe-data-paths.md`

**Classification:** Concept (with embedded troubleshooting content to extract).
Covers the end-to-end data path from AWS → CloudWatch Logs Insights → Grafana
and the parallel Steampipe SQL path. Genuine persistent reference content.
Currently stranded at root. File title ("Detailed Review Report") is noise — the
content is not a review but a data-path reference.

**Caveat:** Section 7 ("Steampipe AWS Plugin — Troubleshooting Record") is a
troubleshooting log, not a concept. Options on move:
  - **Option A (preferred):** Extract section 7 to `docs/troubleshooting/steampipe-aws-plugin.md`, then move remainder to `concepts/`.
  - **Option B (simpler):** Move as-is; accept the mixed content for now.

User to decide between options before executing.

**Action:** `git mv docs/cloudwatch-steampipe-data-paths.md docs/concepts/cloudwatch-steampipe-data-paths.md`
  (update title in H1 to remove "— Detailed Review Report")

**README.md:** Move row from "Networking & Edge" → "Concepts" table.

---

## MERGE — 1 file

### 4. `docs/self-healing-sequence-diagram.md` → merge into `docs/concepts/self-healing-ssm-integration.md`

**Why:** 65-line file containing a single Mermaid `sequenceDiagram` for the
Bedrock self-healing agent pipeline. The concept doc already has an
"Agent Workflow Sequence" section (confirmed: 2 mermaid blocks in both files).

**Action:**
1. Read both diagrams side-by-side to confirm whether the standalone adds any
   content the concept doc lacks.
2. If diagrams are identical (or standalone is a subset): delete standalone.
3. If standalone has additional steps: paste the delta into the concept doc, then
   delete standalone.

**README.md:** Remove "Self-Healing Sequence Diagram" row from "Infrastructure
Reference" table. The concept doc link already covers this content.

---

## DELETE — 5 files

### 5. `docs/nlb-security-group-configuration.md`

**Reason:** Explicitly superseded. `docs/README.md` already marks it with
strikethrough and redirects to `concepts/nlb-architecture.md` + ADR-005. All
content absorbed. Keeping a superseded file pollutes the KB.

**Content summary:** NLB overview, why NLB replaced Lambda failover, SG port
rules — all covered more accurately and in more depth in the current concept doc
and ADR.

**README.md:** Remove the struck-through row from "Networking & Edge" table
entirely.

---

### 6. `docs/typescript/array-methods.md`

**Reason:** General TypeScript programming tutorial (map/filter/reduce). Zero
AWS, CDK, or platform-specific content. Fails the anti-hallucination protocol:
no claims grounded in platform source code. The `typescript/` directory has no
other files.

**README.md:** No entry exists — no update needed.
**Directory:** Remove `docs/typescript/` after deletion (will be empty).

---

### 7. `docs/superpowers/plans/2026-04-25-ami-refresh.md`

**Reason:** Agentic task execution plan (1,246 lines). Contains
`> REQUIRED SUB-SKILL:` directives — ephemeral task orchestration, not persistent
knowledge. The AMI refresh feature is implemented and documented in
`docs/concepts/launch-template-configuration.md`. Execution plans for completed
features are noise.

---

### 8. `docs/superpowers/specs/2026-04-25-ami-refresh-design.md`

**Reason:** Design spec from 2026-04-25 for a now-implemented feature (259 lines).
Superseded by `docs/concepts/launch-template-configuration.md` which documents the
live implementation with live-verified evidence.

**Directory:** Remove `docs/superpowers/` after both deletions (will be empty).

---

### 9. `docs/launch-template-ami-deployment.md`

**Reason:** 680-line reference document written before
`docs/concepts/launch-template-configuration.md` existed. The CDK-side content
(sections 3, 4, 5) is fully superseded. The cross-repo content (sections 2, 6–10 —
Golden AMI pipeline in `kubernetes-bootstrap`, integration tests, AMI tag design,
cleanup utility) describes code that lives in `kubernetes-bootstrap`, not here.
That content belongs in `kubernetes-bootstrap/docs` and should be documented there
via a separate `kb-doc create` invocation.

**README.md:** Remove "Launch Template & AMI Deployment" row from "Infrastructure
Reference" table.

---

## README.md net changes after execution

| Table | Change |
|:------|:-------|
| Concepts | + `networking-observability.md`, + `cloudwatch-steampipe-data-paths.md` |
| Runbooks | + `gh-workflow-dispatch.md` |
| Networking & Edge | Remove `nlb-security-group-configuration.md` row; remove `networking-observability.md` and `cloudwatch-steampipe-data-paths.md` rows (moved to Concepts) |
| Infrastructure Reference | Remove `launch-template-ami-deployment.md`, remove `self-healing-sequence-diagram.md` (absorbed into concept doc) |

---

## Execution order (when approved)

1. MOVE: `git mv` the 3 files + add frontmatter
2. MERGE: verify self-healing diagrams, merge or delete standalone
3. DELETE: `git rm` the 5 files
4. Update `docs/README.md`
5. Remove empty directories (`typescript/`, `superpowers/`)

<!--
Plan produced on 2026-04-28.
Survey: find docs/ -name "*.md" | sort → 37 files
Line counts: wc -l on all flat-root and anomalous files
H2 headings: grep "^## " on all candidates
Overlap check: H2 headings of monitoring-strategy.md, cloudwatch-logs-strategy.md,
  self-healing-ssm-integration.md compared against flat-root docs
-->
