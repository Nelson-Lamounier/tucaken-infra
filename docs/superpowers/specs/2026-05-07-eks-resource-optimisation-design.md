# EKS Resource Optimisation Design

- **Status:** Approved (brainstorm complete) — pending implementation plan
- **Date:** 2026-05-07
- **Owner:** Nelson Lamounier
- **Scope:** Eliminate idle EKS nodes, move monitoring onto system nodes, add dev scheduled start/stop with manual override.
- **Environments affected:** All (bin-packing + monitoring placement), Development only (scheduled shutdown).

---

## 1. Problem Statement

8 nodes run 24/7 in the development cluster:
- 3 system MNG nodes — expected, by design.
- 5 Karpenter workload nodes — unexpected. Root causes:
  1. `consolidationPolicy: WhenEmpty` — Karpenter only reclaims nodes with zero pods. Monitoring stack (Prometheus, Loki, Tempo, Pyroscope, Grafana) spreads across 5 nodes; none ever empties.
  2. System node taint (`dedicated=system:NoSchedule`) forces all monitoring pods onto Karpenter workload nodes. Even with zero app pods, monitoring keeps 5 nodes alive.
  3. No scheduled scaling — no off-hours shutdown.

---

## 2. Goals

1. Zero idle Karpenter workload nodes when no app pods are scheduled.
2. Monitoring runs on system nodes (not workload nodes).
3. Dev cluster auto-starts at 4am Dublin time, auto-stops at 11pm Dublin time (DST-safe).
4. Manual `just dev-shutdown` and `just dev-start` override available at any time.
5. Prod system nodes sized to handle monitoring at production metrics volume.

---

## 3. Architecture Changes

### 3.1 Monitoring on System Nodes

**Repo:** `kubernetes-bootstrap`

Add tolerations and node affinity to every monitoring chart (Prometheus, Grafana, Loki, Tempo, Pyroscope):

```yaml
tolerations:
  - key: dedicated
    operator: Equal
    value: system
    effect: NoSchedule

affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
            - key: node-role
              operator: In
              values: [system]
```

`preferred` (not `required`) — if system nodes are saturated during a surge, monitoring pods can still land on Karpenter workload nodes rather than pending indefinitely.

**Effect:** Karpenter provisions zero workload nodes at rest. Nodes only appear when application pods are explicitly scheduled.

### 3.2 System Node Sizing

**Repo:** `cdk-monitoring` — `infra/lib/config/eks/configurations.ts`

Resource budget for 3x t3.medium (4.5 vCPU / 9.6GB schedulable after k8s overhead):

| Component | CPU | RAM |
|---|---|---|
| System daemons (karpenter, coreDNS, vpc-cni, kube-proxy, alb-controller, ext-dns, ext-secrets, ebs-csi) | ~1.75 vCPU | ~2.15 GB |
| Monitoring stack (Prometheus, Grafana, Loki, Tempo, Pyroscope) | ~1.2 vCPU | ~3.75 GB |
| **Total** | **~2.95 vCPU** | **~5.9 GB** |
| **Buffer** | ~35% | ~38% |

- **Development / Staging:** keep `t3.medium` — fits with burst credit headroom.
- **Production:** upsize to `t3.large` (2 vCPU, 8GB each → 6 vCPU schedulable, 24GB total) — prod Prometheus ingests higher cardinality series; Loki handles greater log volume; margin is required.

### 3.3 Karpenter Bin-packing (all environments)

**Repo:** `cdk-monitoring` — `infra/lib/stacks/kubernetes/eks-karpenter-stack.ts`

```typescript
// Before
disruption: { consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s' }

// After
disruption: { consolidationPolicy: 'WhenUnderutilized', consolidateAfter: '1m' }
```

`WhenUnderutilized` — Karpenter actively bin-packs: if all pods on Node A fit on Node B, it evicts Node A pods (rescheduled to Node B) and deletes Node A. `consolidateAfter` bumped to `1m` to allow pod stabilisation before eviction, reducing churn in prod.

`WhenUnderutilized` respects `PodDisruptionBudgets`. All monitoring charts must set a PDB if not already present.

### 3.4 Dev Scheduled Start/Stop — `EksSchedulerStack`

**Repo:** `cdk-monitoring` — new file `infra/lib/stacks/kubernetes/eks-scheduler-stack.ts`

Only instantiated when `environment === Environment.DEVELOPMENT`.

#### Schedules

| Event | Cron | Timezone |
|---|---|---|
| Auto-start | `cron(0 4 * * ? *)` | `Europe/Dublin` |
| Auto-stop (backstop) | `cron(0 23 * * ? *)` | `Europe/Dublin` |

`Europe/Dublin` IANA timezone on `CfnSchedule.scheduleExpressionTimezone` — EventBridge Scheduler handles DST transitions automatically. No UTC offset adjustment needed.

#### Scale-up Lambda

- Runtime: Python 3.14 (AwsSolutions-L1 compliant)
- Action: `eks:UpdateNodegroupConfig` → `minSize=3, desiredSize=3`
- Inputs: cluster name + node group name from environment variables (set at CDK deploy time)

#### Scale-down Lambda

- Runtime: Python 3.14
- Actions:
  1. `eks:UpdateNodegroupConfig` → `minSize=0, desiredSize=0`
  2. `ec2:DescribeInstances` filter `tag:eks-cluster-pool=workloads-default` + `instance-state-name=running` → collect instance IDs
  3. `ec2:TerminateInstances` on collected IDs (handles any Karpenter stragglers)

#### IAM Role (Lambda execution role)

Scoped to dev cluster ARN only:

```
eks:UpdateNodegroupConfig
eks:DescribeNodegroup
eks:ListNodegroups
ec2:DescribeInstances
ec2:TerminateInstances  (scoped by tag condition: eks-cluster-pool=workloads-default)
```

#### Stack dependency

```
EksSchedulerStack → EksSystemNodeGroupStack (needs node group reference)
```

### 3.5 Justfile Commands

**Repo:** `cdk-monitoring` — `justfile`

```just
# Scale dev cluster up immediately (manual override of scheduled start)
dev-start env='development':
    #!/usr/bin/env bash
    set -euo pipefail
    CLUSTER="k8s-eks-{{env}}"
    PROFILE="{{env}}"
    NG=$(aws eks list-nodegroups --cluster-name "$CLUSTER" \
         --region eu-west-1 --profile "$PROFILE" \
         --query 'nodegroups[0]' --output text)
    aws eks update-nodegroup-config --cluster-name "$CLUSTER" \
         --nodegroup-name "$NG" \
         --scaling-config minSize=3,maxSize=4,desiredSize=3 \
         --region eu-west-1 --profile "$PROFILE"
    echo "Cluster starting — system nodes ready in ~3 min"

# Scale dev cluster down immediately (use before 11pm backstop)
dev-shutdown env='development':
    #!/usr/bin/env bash
    set -euo pipefail
    CLUSTER="k8s-eks-{{env}}"
    PROFILE="{{env}}"
    NG=$(aws eks list-nodegroups --cluster-name "$CLUSTER" \
         --region eu-west-1 --profile "$PROFILE" \
         --query 'nodegroups[0]' --output text)
    aws eks update-nodegroup-config --cluster-name "$CLUSTER" \
         --nodegroup-name "$NG" \
         --scaling-config minSize=0,maxSize=4,desiredSize=0 \
         --region eu-west-1 --profile "$PROFILE"
    INSTANCES=$(aws ec2 describe-instances \
         --filters "Name=tag:eks-cluster-pool,Values=workloads-default" \
                   "Name=instance-state-name,Values=running" \
         --query 'Reservations[].Instances[].InstanceId' \
         --output text --region eu-west-1 --profile "$PROFILE")
    if [ -n "$INSTANCES" ]; then
        aws ec2 terminate-instances --instance-ids $INSTANCES \
             --region eu-west-1 --profile "$PROFILE"
        echo "Workload nodes terminated: $INSTANCES"
    fi
    echo "Cluster shutting down"
```

---

## 4. Files Changed

| Repo | File | Change |
|---|---|---|
| `cdk-monitoring` | `infra/lib/config/eks/configurations.ts` | Prod system node instance type → `t3.large` |
| `cdk-monitoring` | `infra/lib/stacks/kubernetes/eks-karpenter-stack.ts` | `WhenUnderutilized`, `consolidateAfter: 1m` |
| `cdk-monitoring` | `infra/lib/stacks/kubernetes/eks-scheduler-stack.ts` | **NEW** — Lambda + EventBridge Scheduler (dev only) |
| `cdk-monitoring` | `infra/lib/projects/kubernetes/factory.ts` | Register `EksSchedulerStack` |
| `cdk-monitoring` | `justfile` | Add `dev-start`, `dev-shutdown` |
| `kubernetes-bootstrap` | monitoring Helm values (all 5 charts) | Tolerations + `preferredDuringScheduling` node affinity |

---

## 5. Expected Outcomes

| Metric | Before | After |
|---|---|---|
| Dev nodes at rest (no app pods) | 8 (3 system + 5 Karpenter) | 3 (system only) |
| Dev nodes off-hours | 8 | 0 |
| Prod nodes at rest | 3 system + N workload | 3 system + 0 workload idle |
| Dev estimated cost reduction | baseline | ~75% (bin-pack + off-hours) |
| Prod node efficiency | 5 nodes for monitoring | monitoring packed onto system nodes |

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| System nodes full during monitoring surge | `preferred` affinity falls back to Karpenter workload nodes — monitoring stays up |
| `WhenUnderutilized` evicts pods unexpectedly | PDBs on all monitoring charts prevent simultaneous eviction |
| Dev cluster cold-start latency | Auto-start at 4am — cluster ready before work begins; `just dev-start` for immediate manual start |
| Lambda loses node group name on MNG update | Node group name set as Lambda env var at CDK deploy time, not hardcoded |
| Prod t3.large cost increase | 3× t3.large ($0.0752/hr each) vs 3× t3.medium ($0.0376/hr) = +$0.113/hr (+~$82/mo). Offset by eliminating idle workload nodes. |

---

## 7. Out of Scope

- Spot instances for Karpenter workload nodes (V3).
- Cluster-level scheduled scaling for staging/production.
- Prometheus remote write to reduce local retention footprint.
