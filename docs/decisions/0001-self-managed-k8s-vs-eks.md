# ADR-001: Self-Managed Kubernetes over Amazon EKS

**Date:** 2026-03-21
**Status:** Superseded (2026-05) — the platform migrated to Amazon EKS
**Deciders:** Nelson Lamounier (solo developer)

---

## Status update — superseded by the EKS migration (2026-05)

This decision was **reversed**. The platform now runs on **Amazon EKS** (verified
live: cluster `k8s-eks-development`, Kubernetes 1.34), not a self-managed kubeadm
cluster. Node capacity is provisioned by Karpenter on top of a managed system node
group, and workload IAM uses EKS Pod Identity rather than the kubeadm-era patterns
described below.

The original record is retained as decision history. For the current architecture
and the rationale for migrating, see:

- [ADR-002: Tucaken Architecture Migration](0002-tucaken-architecture-migration.md)
- [EKS platform architecture](../concepts/eks-platform-architecture.md)
- [Karpenter and Pod Identity provisioning](../concepts/karpenter-pod-identity-provisioning.md)
- [EKS migration design spec](../superpowers/specs/2026-05-05-eks-migration-design.md)

Scope note: this repository is the **infrastructure** layer. The Next.js
application referenced in the original context below is hosted as a workload, not
owned by this repo — application code lives in the sibling `tucaken-app` and
`ai-applications` repositories.

---

## Context

This project requires a Kubernetes cluster on AWS to host a Next.js application, a full observability stack (Prometheus, Grafana, Loki, Tempo), and platform tooling (ArgoCD, Crossplane, cert-manager). Two options were evaluated:

1. **Amazon EKS** — AWS-managed Kubernetes control plane
2. **Self-managed Kubernetes** — kubeadm-based cluster on EC2 instances

The decision affects cost, operational complexity, learning outcomes, and portfolio differentiation.

---

## Decision

I chose **self-managed Kubernetes on EC2 using kubeadm** over Amazon EKS.

This was a deliberate learning decision, not a production recommendation. For a company workload, EKS would be the correct choice in most cases. For a solo-developer portfolio project designed to demonstrate deep infrastructure understanding, self-managed provides significantly more value.

---

## Evaluation — Weighted Decision Matrix

| Criterion | Weight | EKS Score (1-5) | Self-Managed Score (1-5) |
|:----------|:------:|:---------------:|:------------------------:|
| **Cost at single-node scale** | 0.25 | 2 | 5 |
| **Learning depth** | 0.25 | 2 | 5 |
| **Portfolio differentiation** | 0.20 | 2 | 5 |
| **Operational overhead** | 0.15 | 5 | 2 |
| **Production readiness** | 0.10 | 5 | 3 |
| **Community support** | 0.05 | 5 | 3 |
| **Weighted Total** | | **2.85** | **4.25** |

---

## Evidence

> Files that demonstrated this decision at the time. **Most have since moved or
> been deprecated by the EKS migration** — `control-plane-stack.ts` and
> `edge-stack.ts` now live under `infra/lib/stacks/kubernetes/deprecated/`, and
> the `kubernetes-app/` bootstrap tree moved to the sibling `kubernetes-bootstrap`
> repository. Paths are kept here as a historical pointer.

### Infrastructure as Code
- [`base-stack.ts`](../../infra/lib/stacks/kubernetes/base-stack.ts) — VPC, security groups, IAM roles (still present; carries kubeadm-era vestiges)
- `infra/lib/stacks/kubernetes/deprecated/control-plane-stack.ts` — EC2 instance, EBS, SSM Automation (deprecated)
- `infra/lib/stacks/kubernetes/deprecated/edge-stack.ts` — NLB, Traefik, TLS termination (deprecated)

### Bootstrap Automation
- [`bootstrap_argocd.py`](../../kubernetes-app/k8s-bootstrap/system/argocd/bootstrap_argocd.py) — 1,400-line idempotent bootstrap (ArgoCD, cert-manager, app-of-apps)
- [`control_plane.py`](../../kubernetes-app/k8s-bootstrap/boot/steps/control_plane.py) — kubeadm init, etcd restore, CNI setup
- [`persist-tls-cert.py`](../../kubernetes-app/k8s-bootstrap/system/cert-manager/persist-tls-cert.py) — TLS cert backup/restore via SSM

### GitOps
- [`workload-generator.yaml`](../../kubernetes-app/platform/argocd-apps/workload-generator.yaml) — ApplicationSet for auto-discovery
- 15 ArgoCD Application manifests across platform and workloads

### Testing
- [`base-stack.integration.test.ts`](../../infra/tests/integration/kubernetes/base-stack.integration.test.ts) — 40 KB live infrastructure validation
- 8 integration test suites totalling 145+ KB

---

## Consequences

### Benefits

- **Deep understanding of Kubernetes internals** — I can explain etcd, the API server, kubelet, and CNI networking because I've configured, broken, and fixed each one.
- **Significant cost savings** — ~£30-40/month vs ~£85+/month with EKS (control plane + worker nodes). Over 12 months, this saves ~£500+.
- **Unique portfolio differentiator** — Nearly zero junior/mid-level candidates self-manage Kubernetes. This immediately sets me apart in interviews.
- **Operational maturity** — I've built disaster recovery (etcd backups, TLS persistence), self-healing (Bedrock agent), and automated bootstrap — skills typically associated with senior SRE roles.
- **Full control over cluster lifecycle** — Kubernetes version upgrades, CNI choice (Calico), and admission controllers are all under my control.

### Trade-offs

- **Higher operational burden** — I am responsible for control plane availability, etcd health, and Kubernetes version upgrades. EKS handles these automatically.
- **No managed node groups** — Worker node scaling and replacement is manual (currently single-node for cost). EKS Managed Node Groups automate this.
- **Single point of failure** — One control plane instance means cluster downtime during instance replacement. Mitigated by SSM Automation-based bootstrap (~10 min recovery).
- **Let's Encrypt rate limiting** — etcd wipe on instance replacement can trigger rate limits. Mitigated by TLS cert persistence via SSM Parameter Store.
- **Not recommended for production workloads** — For real business applications with SLA requirements, EKS is the correct choice. This decision is specific to a learning/portfolio context.

### Risks Accepted

| Risk | Likelihood | Impact | Mitigation |
|:-----|:----------|:-------|:-----------|
| Control plane failure | Medium | High | SSM Automation bootstrap (~10 min recovery), hourly etcd backups to S3 |
| etcd data loss | Low | High | Hourly S3 snapshots, TLS cert persistence via SSM |
| Let's Encrypt rate limit | Medium | Medium | `persist-tls-cert.py` backup/restore, staging fallback documented |
| K8s version drift | Low | Medium | Pinned versions in AMI build, planned upgrade runbook |

---

## Alternatives Considered

### Amazon EKS
- **Pros:** Managed control plane, automatic upgrades, native IAM integration, managed node groups
- **Cons:** £55/month control plane cost, abstracts away learning, does not differentiate portfolio
- **Rejected because:** Cost-prohibitive for a portfolio project, and the abstraction defeats the learning purpose

### k3s (Lightweight Kubernetes)
- **Pros:** Simpler setup, lower resource usage, built-in ingress controller
- **Cons:** Non-standard Kubernetes distribution, uses SQLite instead of etcd, less relevant to enterprise environments
- **Rejected because:** Enterprise jobs require standard Kubernetes knowledge; k3s diverges from kubeadm patterns used in production

### Kind / Minikube (Local Development)
- **Pros:** Zero cost, instant setup
- **Cons:** Not deployed to AWS, no real networking, no integration testing against live resources
- **Rejected because:** Cannot demonstrate AWS infrastructure skills or production-grade operational patterns

---

*Generated by mcp-portfolio-docs — all evidence files listed above are real paths in this repository.*