---
title: Karpenter and Pod Identity provisioning
type: concept
tags: [kubernetes, eks, karpenter, pod-identity, nodepool, ec2nodeclass, iam, aws-cdk]
sources:
  - infra/lib/stacks/kubernetes/eks-karpenter-stack.ts
  - infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts
  - infra/lib/config/eks/configurations.ts
created: 2026-06-16
updated: 2026-06-16
---

## What this covers

The node-provisioning and workload-IAM internals of the EKS platform: how
Karpenter's `EC2NodeClass`/`NodePool` CRDs are defined, how the SQS interruption
path works, and how Pod Identity binds IAM roles to Kubernetes service accounts.
This is the implementation companion to
[EKS platform architecture](eks-platform-architecture.md).

## Karpenter data plane: queue + CRDs

The Karpenter Helm chart is installed by `EksAddonsStack`; `EksKarpenterStack`
supplies the runtime data plane — the interruption queue and the CRDs
([eks-karpenter-stack.ts](../../infra/lib/stacks/kubernetes/eks-karpenter-stack.ts)).

An SQS **interruption queue** (`<cluster>-karpenter`) receives termination signals
with a deliberately short 5-minute retention; it has no DLQ because the messages
are ephemeral and stale by the time a DLQ would help (lines 46-69). Four
EventBridge rules feed it: EC2 Spot Interruption Warning, AWS Health events, EC2
Instance State-change, and Rebalance Recommendation (lines 71-82).

## EC2NodeClass: how nodes are launched

The `workloads-default-class` `EC2NodeClass` (karpenter.k8s.aws/v1) defines the
launch shape (lines 93-137):

- **AMI**: `AL2023` family, `al2023@latest` alias — resolves to the EKS-optimised
  AL2023 AMI for the cluster's Kubernetes version automatically.
- **Subnets/SGs by tag**, never hard-coded: subnets matched on the shared subnet
  tag; security groups matched on `kubernetes.io/cluster/<name>: owned`, the tag
  EKS auto-applies to the cluster SG (which already carries node-to-node and
  control-plane↔kubelet rules). No pre-provisioned CDK SG.
- **IMDSv2 with `httpPutResponseHopLimit: 2`** — pods sit behind a veth bridge
  (one extra hop); the default limit of 1 would drop pod IMDS requests and break
  SDK credential resolution.

## NodePool: what Karpenter is allowed to provision

The `workloads-default` `NodePool` (karpenter.sh/v1) constrains capacity by
instance category, family, capacity type, architecture, and a CPU range, and
labels nodes `node-role=workload` to match the kube-state-metrics / Grafana
convention (lines 247-316). Nodes carry `expireAfter: 720h`; disruption uses
`consolidationPolicy: WhenEmptyOrUnderutilized` with `consolidateAfter: 1m`, which
actively bin-packs (evicts pods off underutilised nodes so they can be removed),
unlike the prior `WhenEmpty`. A `limits.cpu` of 100 caps the pool.

An optional **system pool** mirrors the MNG: weight 10 so the scheduler prefers
it for pods that tolerate the `dedicated=system:NoSchedule` taint, labelled
`node-role=system` so ESO/cert-manager land on either the MNG or this pool
(lines 139-245).

## Why the CRDs use prune: false

All `KubernetesManifest` CRDs set `prune: false` so CDK only ever applies, never
`kubectl delete` (lines 84-95). Karpenter sets a
`karpenter.k8s.aws/termination` finalizer that only the running controller can
clear; because `EksAddonsStack` (the Helm install) is destroyed after this stack,
the controller would already be gone, leaving the object stuck `Terminating` on
the next deploy. With `prune: false`, Karpenter owns the delete lifecycle.

## Pod Identity: IAM role per service account

`EksPodIdentityStack` creates one least-privilege IAM role per binding, each
linked to a `namespace`/`serviceAccount` via `CfnPodIdentityAssociation` —
replacing IRSA
([eks-pod-identity-stack.ts](../../infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts),
lines 85-110). Each role trusts the `pods.eks.amazonaws.com` principal and must
additionally grant **`sts:TagSession`** on top of `sts:AssumeRole`; without it the
association create call rejects the role with "Trust policy of the role provided
is invalid" (lines 90-100).

The stack also installs the `eks-pod-identity-agent` addon and a CoreDNS managed
addon carrying the `dedicated=system:NoSchedule` toleration — without that
toleration CoreDNS stays Pending on a single-pool cluster, which starves every
Helm chart that resolves an AWS endpoint at boot (lines 54-80).

## Deeper detail

- [EKS platform architecture](eks-platform-architecture.md)
  — where these stacks sit in the dependency order and the cluster they target
- [EKS dev start/stop and restore order](../runbooks/eks-dev-start-stop-restore.md)
  — the scheduler that scales Karpenter and terminates its nodes by tag

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/eks-karpenter-stack.ts (read 2026-06-16, lines 46-316)
- Source: infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts (read 2026-06-16, lines 1-110)
- Live: aws eks describe-cluster --name k8s-eks-development (run 2026-06-16) — Kubernetes 1.34
-->
