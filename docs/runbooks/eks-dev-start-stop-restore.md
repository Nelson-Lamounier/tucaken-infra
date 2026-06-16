---
title: EKS dev start/stop and restore order
type: runbook
tags: [kubernetes, eks, karpenter, argocd, finops, eventbridge-scheduler, lambda, operations]
sources:
  - infra/lib/stacks/kubernetes/eks-scheduler-stack.ts
  - infra/lib/stacks/kubernetes/eks-public-waf-stack.ts
created: 2026-06-16
updated: 2026-06-16
---

## When to run

The dev cluster scales itself down overnight and back up each morning to save
cost. This runbook is for understanding that automation and for **manually**
starting or stopping the cluster off-schedule, or recovering when an automatic
cycle leaves the cluster in a bad state. It applies to `Environment.DEVELOPMENT`
only — `EksSchedulerStack` is gated to dev in the project factory
([eks-scheduler-stack.ts](../../infra/lib/stacks/kubernetes/eks-scheduler-stack.ts)).

## What the schedule does

Two EventBridge Scheduler schedules invoke two Lambdas on Europe/Dublin cron
(lines 436-447):

| Schedule | Cron | Action |
|:---------|:-----|:-------|
| Scale-up | `cron(0 4 * * ? *)` (04:00) | MNG `minSize=1, desiredSize=1` (landing zone); Karpenter → 1; ArgoCD ×7 → 1; WAF IP sync (async) |
| Scale-down | `cron(0 23 * * ? *)` (23:00) | Karpenter → 0; ArgoCD ×7 → 0; terminate ALL Karpenter EC2s (tag `eks-cluster-pool`, every pool); MNG `minSize=0, desiredSize=0` |

## Restore order (why sequence matters)

The order is not arbitrary — it prevents orphaned nodes and reconciliation loops
([eks-scheduler-stack.ts](../../infra/lib/stacks/kubernetes/eks-scheduler-stack.ts) header, lines 1-25):

- **Scale-down pre-zeros Karpenter and ArgoCD via the Kubernetes API before
  draining the MNG.** If the MNG drained first, ArgoCD would keep reconciling and
  Karpenter would keep provisioning replacement nodes against a shrinking cluster.
- **Scale-up restores only Karpenter and ArgoCD explicitly.** Everything else —
  ESO and all other workloads — recovers through ArgoCD reconciliation once ArgoCD
  is back. ESO is intentionally not patched (out of the Lambda's RBAC scope); it
  dies with its node and is reconciled by ArgoCD.

So the manual restore sequence is: **MNG landing zone → Karpenter → ArgoCD → (WAF
IP sync) → let ArgoCD reconcile the rest.**

## Manual procedure

Prefer invoking the existing Lambdas over hand-running each step, so the ordering
and IAM scoping are preserved.

```bash
# Start the cluster (equivalent to the 04:00 schedule)
aws lambda invoke --region eu-west-1 \
  --function-name <ScaleUpFn name> /dev/stdout

# Stop the cluster (equivalent to the 23:00 schedule)
aws lambda invoke --region eu-west-1 \
  --function-name <ScaleDownFn name> /dev/stdout
```

The scale-up Lambda also invokes the WAF `IpSyncFn` (when
`wafIpSyncFunctionName` is wired) so the WAF IP allowlist is refreshed from SSM on
every start ([eks-public-waf-stack.ts](../../infra/lib/stacks/kubernetes/eks-public-waf-stack.ts)).

## What the Lambdas are allowed to do

The shared Lambda role is least-privilege (lines 52-115):

- `eks:UpdateNodegroupConfig` / `DescribeNodegroup` scoped to
  `nodegroup/<cluster>/*/*` (nodegroups are a separate ARN namespace, not under
  the cluster ARN).
- `ec2:TerminateInstances` scoped by condition to instances tagged
  `eks-cluster-pool` (any value) — i.e. Karpenter nodes of any pool, never the MNG
  or unrelated EC2.
- `lambda:InvokeFunction` on the WAF IP-sync function only.

## Verification

After a start, confirm the landing zone and Karpenter are back:

```bash
kubectl get nodes -o wide                      # MNG node Ready
kubectl get nodepools                          # workloads-default present
kubectl get applications -n argocd             # ArgoCD apps Synced/Healthy
aws ssm get-parameter --region eu-west-1 \
  --name /k8s/development/eks/waf-acl-arn       # WAF ARN present
```

## Recovery if a cycle leaves things broken

If ArgoCD or Karpenter did not come back after scale-up (a known pain point —
see commits `a40696e7` "restore Karpenter and ArgoCD after dev-shutdown" and
`c30f159d`):

1. Re-run the scale-up Lambda — it is idempotent (sets explicit desired counts).
2. If the MNG node is Ready but Karpenter is still at 0 replicas, scale the
   Karpenter Deployment back up and let it re-provision; do not manually create
   nodes (the `eks-cluster-pool` tag scoping and finalizers assume Karpenter owns
   node lifecycle).
3. Once ArgoCD is Healthy, let it reconcile ESO and the remaining workloads rather
   than patching them by hand.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/eks-scheduler-stack.ts (read 2026-06-16, lines 1-120, 436-447)
- Source: infra/lib/stacks/kubernetes/eks-public-waf-stack.ts (read 2026-06-16) — IpSyncFn wiring
- Git: a40696e7, c30f159d (referenced 2026-06-16) — restore-after-shutdown fixes
-->
