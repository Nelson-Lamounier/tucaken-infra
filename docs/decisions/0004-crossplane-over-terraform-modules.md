---
title: "ADR-003: Crossplane over Terraform Modules for In-Cluster AWS Resource Management"
type: decision
tags: [aws-cdk, crossplane, terraform, kubernetes, iam, infrastructure-as-code, gitops]
sources:
  - infra/lib/stacks/shared/crossplane-stack.ts
  - infra/lib/constructs/iam/crossplane-iam-construct.ts
  - infra/lib/projects/shared/factory.ts
created: 2026-04-28
updated: 2026-04-28
---

# ADR-003: Crossplane over Terraform Modules for In-Cluster AWS Resource Management

**Date:** 2026-04-28
**Status:** Accepted
**Deciders:** Nelson Lamounier (solo developer)

---

## Context

The platform requires a mechanism for Kubernetes workloads to provision on-demand AWS resources (S3 buckets, SQS queues) as part of application lifecycle management. This is the "Day-2 provisioning" problem: platform engineers should be able to declare AWS resources via the same Kubernetes API they use for Deployments and Services, without context-switching to a separate IaC tool.

Two approaches were evaluated: Crossplane (K8s-native CRD-based provisioner) and Terraform modules called from CI pipelines.

The cluster is self-managed via kubeadm on EC2 — EKS is not in use. This constraint shapes the credentials approach significantly.

---

## Decision

Deploy Crossplane onto the cluster and provision its IAM identity via a dedicated CDK stack (`CrossplaneStack` in `infra/lib/stacks/shared/crossplane-stack.ts`). Crossplane receives a dedicated IAM user (not an instance profile) with tightly scoped S3/SQS/KMS permissions, stored in Secrets Manager.

The implementation uses `CrossplaneIamConstruct` (`infra/lib/constructs/iam/crossplane-iam-construct.ts`) to create the user and access key, with all permissions scoped to `crossplane-{namePrefix}-*` resource patterns — no wildcard ARNs.

---

## Alternatives considered

### Alternative 1: Terraform modules invoked from CI pipelines

Use Terraform HCL modules to provision application-tier AWS resources. Pipeline jobs call `terraform apply` from GitHub Actions when resources need to be created or updated.

**Problem — dual control plane:**
Platform infrastructure lives in CDK. Application-tier AWS resources would live in Terraform. This creates two separate IaC tools with no shared state, no shared tagging schema, and no unified deployment ordering. Developers would need to understand both CDK constructs and Terraform providers to work on the platform.

**Problem — GitOps boundary violation:**
The GitOps model in this platform treats `kubernetes-bootstrap` as the source of truth for K8s-layer resources, and `cdk-monitoring` as the source of truth for AWS-layer resources managed at deploy time. Terraform introduces a third system outside both of these boundaries.

**Problem — credential distribution:**
Terraform jobs in CI require AWS credentials injected as pipeline secrets. Crossplane, by contrast, reads credentials from a K8s Secret in the cluster — the credential lifecycle is managed by Secrets Manager rotation, not secret rotation in GitHub.

### Alternative 2: CDK custom resources (Lambda-backed)

Use `AwsCustomResource` Lambda-backed constructs to provision the on-demand AWS resources that application workloads need.

**Problem — lifecycle mismatch:**
CDK resources have a CloudFormation lifecycle: create on deploy, delete on stack teardown. Application-tier resources like SQS queues for job processing need to be created and deleted on application demand, not on infrastructure deploy cycles.

**Problem — operational footprint:**
Each resource type would need its own Lambda-backed custom resource. Crossplane provides a unified CRD-based interface across all supported AWS services.

### Alternative 3: EKS Pod Identity / IRSA

Use EKS IRSA (IAM Roles for Service Accounts) to grant Crossplane pods AWS access via OIDC federation — the standard approach on EKS.

**Problem — not available on self-managed kubeadm:**
IRSA requires the EKS OIDC provider endpoint, which only exists for EKS clusters. The platform uses self-managed kubeadm. There is no OIDC provider to federate with. This is the core constraint that makes a dedicated IAM user necessary.

The source code explicitly documents this at `infra/lib/constructs/iam/crossplane-iam-construct.ts` lines 8–12:
```
Why a dedicated IAM user (not instance profile)?
  - Self-hosted kubeadm clusters lack IRSA
  - Crossplane needs its own credential scope, separate from node role
  - Enables key rotation via Secrets Manager
  - Follows least-privilege: only S3, SQS, KMS — nothing else
```

---

## Consequences

**Positive:**
- Application teams declare AWS resources as Kubernetes CRDs — same tooling as the rest of the K8s ecosystem
- GitOps boundary is preserved: CDK provisions the Crossplane identity; ArgoCD manages the Crossplane CRDs
- Credentials have a clean rotation path via Secrets Manager (the bootstrap process reads the secret and creates a K8s Secret in `crossplane-system`)
- Permissions are scoped to `crossplane-{namePrefix}-*` prefixes — no broad account permissions
- `CrossplaneStack` deploys independently in the `shared` project alongside other Shared stacks

**Negative:**
- Dedicated IAM user is less secure than IRSA because credentials are long-lived (no automatic expiry). Mitigated by Secrets Manager storage and `crossplane-*` resource name scoping.
- Crossplane operator must be installed and maintained on the cluster (via ArgoCD Application in `kubernetes-bootstrap`). If the operator is not running, CDK-level Crossplane config has no effect.
- Access key rotation requires a bootstrap script re-run to inject the new credentials into the K8s Secret in `crossplane-system`

**Note on IRSA upgrade path:**
If the platform migrates to EKS in the future, the IAM user approach can be replaced with an OIDC-federated role. The `CrossplaneIamConstruct` is isolated to one CDK stack and has no consumers outside `CrossplaneStack` — the migration would be a single-construct replacement.

---

## Implementation reference

- `infra/lib/stacks/shared/crossplane-stack.ts` — stack definition, outputs: `CrossplaneUserArn`, `CrossplaneCredentialSecretArn`
- `infra/lib/constructs/iam/crossplane-iam-construct.ts` — IAM user, access key, Secrets Manager secret, per-service policy builders
- `infra/lib/projects/shared/factory.ts` — `CrossplaneStack` instantiation within the Shared project factory
- Crossplane operator deployment: `kubernetes-bootstrap` ArgoCD Application (outside this repo)

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/shared/crossplane-stack.ts (read on 2026-04-28)
- Source: infra/lib/constructs/iam/crossplane-iam-construct.ts (read on 2026-04-28)
- Source: infra/lib/projects/shared/factory.ts (read on 2026-04-28)
-->
