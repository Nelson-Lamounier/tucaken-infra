---
title: Drop EKS API and AUDIT control-plane logs to cut CloudWatch Logs cost
type: decision
tags: [aws, eks, cloudwatch-logs, cost, finops, cdk-nag, observability, control-plane]
sources:
  - infra/lib/stacks/kubernetes/eks-cluster-stack.ts
  - infra/tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts
  - docs/decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md
  - .claude/CLAUDE.md
created: 2026-07-06
updated: 2026-07-06
---

## Context

An EKS cluster can stream five control-plane log types — API, AUDIT,
AUTHENTICATOR, CONTROLLER_MANAGER and SCHEDULER — into a CloudWatch Log Group.
`EksClusterStack` provisions that group as `/aws/eks/<cluster>/cluster` with a
one-month retention and `RemovalPolicy.RETAIN`, so the log data survives a stack
destroy
([eks-cluster-stack.ts:85-89](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)).

Ingestion was not evenly spread across those streams. The code comment on the
`clusterLogging` array records that AUDIT alone dominated the bill: the author
notes AUDIT ingested `~102 GB/mo -> ~$34/mo` while the remaining streams are
small
([eks-cluster-stack.ts:70-75](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)).
The matching `AwsSolutions-EKS2` suppression reason states the same figures and
adds that AUDIT was `~93% of the CloudWatch Logs bill`
([eks-cluster-stack.ts:118](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)).

That is well past the project cost guardrail: the repo CLAUDE.md instructs the
team to flag any resource that adds more than `$10/mo` to the dev cluster
([.claude/CLAUDE.md](../../.claude/CLAUDE.md), "Cost guardrails"). A single log
stream at roughly `$34/mo` is a clear candidate to trim.

## Decision

The `clusterLogging` array keeps three streams and drops two
([eks-cluster-stack.ts:76-80](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)):

- **Kept** — AUTHENTICATOR (access debugging), CONTROLLER_MANAGER and SCHEDULER
  (control-loop health). These streams are small and remain useful for
  diagnosing who reached the API and whether the control loops are healthy.
- **Dropped** — API and AUDIT. AUDIT is the expensive one; API is dropped
  alongside it as the other high-volume control-plane stream.

The CDK `clusterLogging` list is the single source of truth for which streams are
enabled — there is no separate console or Terraform toggle. A unit test asserts
the exact set with a strict-equal comparison, so a future edit cannot silently
re-enable the expensive streams without failing CI: the guard checks
`types` equals `['authenticator', 'controllerManager', 'scheduler']` and that it
contains neither `audit` nor `api`
([eks-cluster-stack.test.ts:48-56](../../infra/tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts);
commit `232e6435` switched the assertion to `toStrictEqual`).

## The cdk-nag interplay

Removing AUDIT trips `AwsSolutions-EKS2`, the cdk-nag rule that wants all
control-plane log types enabled. Rather than silence the rule with a bare
suppression, the reason string carries the full rationale and the explicit
re-enable condition: API and AUDIT are deliberately excluded because AUDIT alone
ingested `~102 GB/mo (~$34/mo, ~93% of the CloudWatch Logs bill)`, and AUDIT
should be re-enabled "if a compliance/forensics requirement for a Kubernetes
audit trail arises"
([eks-cluster-stack.ts:117-119](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)).

This is the "suppress the nag AND test the suppressed set" discipline: the
suppression documents *why* the deviation is intentional, and the strict-equal
unit test locks the actual enabled set so the suppression and the code cannot
drift apart. See the [IaC security dual-layer](../concepts/iac-security-dual-layer.md)
concept for how cdk-nag suppressions are treated as reviewed, documented
exceptions rather than blanket mutes.

## Alternatives considered

- **Keep all five log types.** Rejected on cost. AUDIT alone runs at roughly
  `$34/mo`, and the remaining API stream is the other high-volume source; the
  guardrail flags anything over `$10/mo` in dev
  ([.claude/CLAUDE.md](../../.claude/CLAUDE.md)).
- **Ship AUDIT to cheaper storage or a shorter retention.** A possible future
  option — for example routing AUDIT to lower-cost storage or reducing the Log
  Group retention below one month — but it is not implemented today, so it is
  noted only as a direction, not a current decision.
- **Disable control-plane logging entirely.** Rejected: dropping every stream
  would lose AUTHENTICATOR (access debugging) and CONTROLLER_MANAGER / SCHEDULER
  (control-loop health) as well, which are cheap and diagnostically valuable.

## Consequences

- **Lower CloudWatch Logs bill.** Removing the stream that accounted for
  `~93%` of the Logs bill is the point of the change
  ([eks-cluster-stack.ts:118](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)).
- **No Kubernetes audit trail in CloudWatch until re-enabled.** With AUDIT off,
  there is no server-side record of API-object mutations in CloudWatch. If a
  compliance or forensics requirement lands, AUDIT must be added back — the
  suppression reason names exactly that trigger.
- **Reversible by editing one array.** The decision lives entirely in the
  `clusterLogging` list; re-adding `eks.ClusterLoggingTypes.AUDIT` (and updating
  the strict-equal guard test) restores the stream. No data was destroyed — the
  Log Group is `RETAIN` and keeps whatever it already ingested.

## Deeper detail

- [CloudWatch Logs strategy](../concepts/cloudwatch-logs-strategy.md)
  — retention, log-group ownership, and where control-plane logs sit in the
  wider Logs cost picture
- [IaC security dual-layer](../concepts/iac-security-dual-layer.md)
  — how cdk-nag suppressions are documented and tested rather than silently muted
- [EKS platform architecture](../concepts/eks-platform-architecture.md)
  — the cluster, node provisioning, and where `EksClusterStack` sits

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/eks-cluster-stack.ts (read 2026-07-06)
- Source: infra/tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts (read 2026-07-06)
- Source: docs/decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md (referenced 2026-07-06)
- Source: .claude/CLAUDE.md (cost guardrail, read 2026-07-06)
- Git: 252f2c3d "perf(eks): drop api + audit control-plane logs to cut cost" (2026-07-06)
- Git: 232e6435 "fix(eks): suppress EKS2 nag for dropped logs + strict-equal test" (2026-07-06)
-->
