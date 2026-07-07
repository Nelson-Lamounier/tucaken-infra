---
title: Public EKS API endpoint in CDK, blocked from private by the public-subnet-only VPC
type: decision
tags: [aws, eks, vpc, networking, endpoint, cdk-nag, cost, drift, security]
sources:
  - infra/lib/stacks/kubernetes/eks-cluster-stack.ts
  - docs/decisions/0001-self-managed-k8s-vs-eks.md
  - docs/concepts/eks-platform-architecture.md
created: 2026-07-06
updated: 2026-07-06
---

## Context

The EKS control plane runs in the shared dev VPC, which is **public-subnet-only**:
V1 dev deliberately runs without a NAT Gateway as a documented cost guardrail. The
cluster stack encodes that shape — it looks up the shared VPC and places the
cluster in public subnets only, with no managed node capacity of its own
([eks-cluster-stack.ts:62-63](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)):

```typescript
vpcSubnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
defaultCapacity: 0,
```

The file header states the reason directly: "Subnets: PUBLIC only (V1 dev runs
without NAT GW per cost guardrail)."
([eks-cluster-stack.ts:10](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)).

There is a known **drift** between the live account and the code. The live EKS
cluster endpoint is private (applied out-of-band via the CLI). An earlier commit
tried to codify that — `cc07488e` "feat(eks): private API endpoint + public-api
Pod Identity (codify drift)" set `endpointAccess = PRIVATE` (previously the default
public+private, i.e. `0.0.0.0/0`) so that `cdk deploy` would stop reverting the
live state. That endpoint change was then **reverted** in `31057e69` because it
could not synth in this VPC (see below). The Pod Identity half of `cc07488e`
survived; only the endpoint line was dropped.

## Decision

Keep the EKS API endpoint **public in the CDK definition** for now, and document
why with an `AwsSolutions-EKS1` cdk-nag suppression rather than leaving the
finding to fail silently. Do **not** set `EndpointAccess.PRIVATE` in CDK until the
shared VPC gains private subnets.

The suppression records the operational reason
([eks-cluster-stack.ts:111-115](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)):

```typescript
{
    id: 'AwsSolutions-EKS1',
    reason: 'Public API endpoint required for OIDC-based CI access without VPC connectivity; V1 dev runs without NAT GW per cost guardrail.',
}
```

The inline comment above it spells out the same trade-off: the API server is
public because V1 dev runs without a NAT Gateway (cost guardrail) and GitHub
Actions OIDC runners need API reachability for `kubectl wait` during deploy,
mitigated by AWS Access Entries and short-lived OIDC credentials
([eks-cluster-stack.ts:107-110](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)).

## Why codifying private failed

The `eks.Cluster` L2 construct requires private subnets to be available when the
endpoint is set to `EndpointAccess.PRIVATE` — a fully private endpoint has no
route out of public-only subnets, so the CDK-managed kubectl handler cannot reach
the API. With a public-subnet-only VPC that line does not synthesise: it fails the
`Validate CDK Stacks` synth step in CI. Commit `31057e69`
"refactor(eks): drop endpoint change — blocked by public-subnet-only VPC" records
the exact failure and removed the line:

> eks.Cluster L2 requires private subnets for EndpointAccess.PRIVATE, but the
> shared dev VPC is public-subnet-only (no NAT / cost guardrail), so that line
> fails 'Validate CDK Stacks' synth. [...] Live endpoint stays private.

This is a concrete case of an **L2 abstraction constraint colliding with a
cost-guardrail VPC shape**: the construct's private-endpoint path assumes a subnet
topology the cost guardrail deliberately omits, so the clean, high-level API is
unusable until the VPC changes.

## Options to close the drift

Both options are tracked in issue **#199**.

- **(a) Add private subnets + interface VPC endpoints, then set
  `EndpointAccess.PRIVATE`.** Give the shared VPC isolated (or private-with-egress)
  subnets and the interface VPC endpoints the CDK kubectl handler needs, then the
  L2 private-endpoint path synthesises cleanly. This is the "correct" fix — the
  code and the live account converge on a genuinely private endpoint — but it adds
  ongoing cost (NAT Gateway and/or the set of interface VPC endpoints) that the V1
  cost guardrail was written to avoid.
- **(b) An L1 / escape-hatch override, validated against the CDK kubectl handler.**
  Reach past the L2 to set the private endpoint on the underlying CloudFormation
  resource, keeping the public-subnet VPC. This avoids the NAT/endpoint spend but
  bypasses the L2's own reachability checks, so it must be verified against the
  kubectl handler (which needs to reach the API to run manifests) before it is
  trusted.

The trade-off is a clean, self-consistent private endpoint at added
NAT/endpoint cost (a) versus keeping the cheap public-subnet VPC at the price of an
escape hatch that has to be hand-validated (b). No dollar figure is asserted here
beyond the cost-guardrail direction the code already documents.

## Consequences

- The public CDK endpoint is **mitigated, not unguarded**: authentication runs
  through AWS Access Entries (`authenticationMode: API_AND_CONFIG_MAP`, so there is
  no legacy `aws-auth` ConfigMap to drift)
  ([eks-cluster-stack.ts:67](../../infra/lib/stacks/kubernetes/eks-cluster-stack.ts)),
  and CI reaches the API with short-lived OIDC credentials rather than long-lived
  keys.
- The gap between live (private endpoint) and code (public endpoint) is **tracked,
  not silent** — the drift is named in `cc07488e`, its reversion is explained in
  `31057e69`, and the close-out work sits under #199. cdk-nag would otherwise flag
  the public endpoint on every synth; the `AwsSolutions-EKS1` suppression carries
  the justification in-repo so the finding is a decision, not noise.
- Until #199 lands, `cdk deploy` must not be allowed to overwrite the live private
  endpoint back to public; the endpoint is managed out-of-band and the CDK value is
  knowingly left at the public default.

## Deeper detail

- [EKS platform architecture](../concepts/eks-platform-architecture.md)
  — the cluster stack, Access Entries, Pod Identity, and where the API endpoint sits
- [ADR-0001 self-managed K8s vs EKS](0001-self-managed-k8s-vs-eks.md)
  — why the managed control plane (and its endpoint model) replaced kubeadm

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/eks-cluster-stack.ts (read 2026-07-06) — vpcSubnets PUBLIC only (l.62), defaultCapacity 0 (l.63), header note (l.10), AwsSolutions-EKS1 suppression (l.111-115), public-endpoint comment (l.107-110), authenticationMode API_AND_CONFIG_MAP (l.67)
- Source: docs/decisions/0001-self-managed-k8s-vs-eks.md (referenced 2026-07-06)
- Source: docs/concepts/eks-platform-architecture.md (referenced 2026-07-06)
- Git: 31057e69 "refactor(eks): drop endpoint change — blocked by public-subnet-only VPC" (read 2026-07-06)
- Git: cc07488e "feat(eks): private API endpoint + public-api Pod Identity (codify drift)" (read 2026-07-06)
- Issue: tucaken-infra#199 tracks the VPC/private-endpoint close-out
-->
