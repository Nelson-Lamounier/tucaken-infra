---
title: Karpenter system pool starves at the ENI pod cap despite free CPU
type: troubleshooting
tags: [karpenter, eks, kubernetes, scheduling, eni, pod-density, capacity, node-provisioning]
sources:
  - infra/lib/config/eks/configurations.ts
  - infra/lib/stacks/kubernetes/eks-karpenter-stack.ts
created: 2026-07-05
updated: 2026-07-05
---

# Karpenter system pool starves at the ENI pod cap despite free CPU

## Symptom

A small system pod (cert-manager, External Secrets Operator, the ALB
controller, …) sits `Pending` and Karpenter does not provision a node for it,
even though the existing system nodes show plenty of unused CPU and memory. This
happened on 2026-05-26 when the ESO main controller could not schedule: every
system node was full and Karpenter provisioned nothing new
([infra/lib/config/eks/configurations.ts](../../infra/lib/config/eks/configurations.ts)).

## Root cause: Karpenter ranks by CPU/memory, not by the per-node pod cap

On EKS the number of pods a node can run is capped by its ENI/IP allocation, and
that cap scales with instance size: a `t3.medium` tops out at **17** pods, a
`t3.large` at **35**, a `t3.xlarge` at **58**. Karpenter, when choosing which
instance type to launch for a set of pending pods, ranks candidates by the pods'
**CPU and memory requests** and is blind to the ENI pod cap. System pods are
tiny on CPU/memory but numerous, so Karpenter happily packs them onto the
cheapest node that fits by resources — a `t3.medium` — which then saturates at
its 17-pod ENI ceiling with most of its CPU still idle. Once every node is at the
pod cap, a new pending pod cannot schedule, and Karpenter will not add a node
because, by its CPU/memory math, the existing nodes still "fit."

The `cpuLimit` on the pool made it worse: with `cpuLimit: 2`, Karpenter could not
provision a second node once the first medium was full, so the tier deadlocked.

## Diagnosis

```bash
# Pending system pod that will not schedule
kubectl -n external-secrets get pods
kubectl -n external-secrets describe pod <pod>   # FailedScheduling, no node

# Per-node pod count vs the ENI cap for its instance size
kubectl get nodes -L node.kubernetes.io/instance-type,karpenter.sh/nodepool
kubectl get pods -A -o wide | awk '{print $8}' | sort | uniq -c   # pods per node
```

A node at or near its instance-size pod cap (17 for a medium, 35 for a large)
with idle CPU is the signature. Karpenter's controller logs show it evaluating
the pending pod as schedulable-by-resources onto existing nodes.

## Fix: size the system pool by pod density, not CPU

Constrain the system NodePool's instance sizes so Karpenter cannot pick a node
whose ENI pod cap is too low, and raise the CPU limit so it can scale out
([infra/lib/config/eks/configurations.ts](../../infra/lib/config/eks/configurations.ts)):

```ts
const DEV_KARPENTER_SYSTEM: EksKarpenterSystemPoolConfig = {
    instanceFamily: ['t3'],
    instanceSizes: ['large', 'xlarge'], // floor at 35 pods/node; drop small/medium
    capacityType: ['spot'],
    architectures: ['amd64'],
    cpuLimit: 8,                          // allow ~4× large or ~2× xlarge
};
```

`t3.small`, `medium`, and `large` all have 2 vCPU, so Karpenter — picking the
smallest node that fits by memory — will choose a `large` once `small`/`medium`
are removed from the allowed sizes, guaranteeing ≥35 pods per node. The
`t3.large` managed node group (`desiredSize: 1`) provides the on-demand landing
zone for the Karpenter controller and CoreDNS so those never ride spot.

## Verification

After the change the system tier runs on `t3.large`/`t3.xlarge` nodes. Verified
live on 2026-07-05: the `system` Karpenter NodePool and the MNG both back
`t3.large` nodes, and the system pods (argocd, ESO, cert-manager, monitoring)
are all scheduled — 4 nodes total, 2 in the `workloads-default` pool and 2 in
the `system` tier.

## Prevention

- When a NodePool hosts many small pods, always constrain instance **size** (or
  set a minimum), not just CPU/memory — Karpenter will not do it for you.
- Keep the pool's `cpuLimit` high enough to provision a second node under pod
  pressure, or the tier can deadlock at the first node's pod cap.

## Related

- [Karpenter and Pod Identity provisioning](../concepts/karpenter-pod-identity-provisioning.md)
  — NodePool/EC2NodeClass topology and consolidation policy

<!--
Evidence trail (auto-generated):
- Source: infra/lib/config/eks/configurations.ts (DEV_KARPENTER_SYSTEM + dev MNG comments, read 2026-07-05)
- Source: infra/lib/stacks/kubernetes/eks-karpenter-stack.ts (system NodePool spec, read 2026-07-05)
- Live: kubectl get nodes -L karpenter.sh/nodepool (2026-07-05: workloads-default + system, t3.large)
- Incident: 2026-05-26 ESO main controller unschedulable (per config comment)
-->
