# CLAUDE.md — cdk-monitoring

AI assistant preferences for this CDK TypeScript + EKS monorepo.
Read this before generating any code, stack, or Kubernetes manifest.

---

## Project identity

- **Repo**: cdk-monitoring (AWS CDK TypeScript)
- **Bootstrap repo**: kubernetes-bootstrap (ArgoCD + Helm charts)
- **AWS account (dev)**: 771826808455 | **Region**: eu-west-1
- **Cluster**: EKS (migrating from kubeadm self-hosted)
- **VPC CIDR**: 10.0.0.0/16 (shared, reused from kubeadm era)

---

## CDK conventions

### Stack naming
- Active stacks: `PascalCase` e.g. `EksClusterStack`, `EdgeStack`
- Deprecated stacks: `Deprecated_` prefix e.g. `Deprecated_ControlPlaneStack`
- Deprecated files: live in `infra/lib/projects/kubernetes/deprecated/`
- Factory registry skips any stack whose class name starts with `Deprecated_`

### Stack decomposition (EKS dependency order)
EksClusterStack
→ EksSystemNodeGroupStack
→ EksPodIdentityStack
→ EksAddonsStack
→ EksKarpenterStack
EksAccessStack  (depends on EksClusterStack only)
Never merge these. Each stack = one failure domain.

### Construct patterns
- Always use `RemovalPolicy.RETAIN` on stateful resources (EBS volumes,
  DynamoDB tables, RDS) unless explicitly asked to destroy
- Tag every resource with: `Project`, `Environment`, `ManagedBy: cdk`
- Use `Stack.of(this).account` and `.region` — never hardcode account IDs
- IAM: Pod Identity over IRSA. No inline policies; use managed policies
  or `addToPolicy` with least-privilege statements
- No `*` in IAM actions unless you explain why and scope by resource ARN

### Subnet tagging (EKS shared VPC)
- Private subnets: `kubernetes.io/role/internal-elb: "1"`
- Public subnets: `kubernetes.io/role/elb: "1"`
- All subnets: `kubernetes.io/cluster/<clusterName>: "shared"` (NOT "owned")
- Never use "owned" — this VPC outlives any single cluster

### Deprecation JSDoc header (required on every deprecated file)
```typescript
/**
 * @deprecated Replaced by <NewStack> on YYYY-MM-DD.
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md
 *
 * Original purpose: <one line>
 * Why deprecated: <bullet reasons>
 * Why kept: Reference implementation. Do not delete.
 *
 * @destroyOrder
 *   1. <prerequisite>
 *   2. cdk destroy <StackName>
 *
 * Do not import or instantiate.
 */
export class Deprecated_XStack { ... }
```

---

## EKS-specific patterns

### Node provisioning
- System node group: 2× t3.medium MNG (Karpenter + CoreDNS landing zone)
- Workload nodes: Karpenter-managed, single NodePool V1
- NodePool topology: on-demand only V1, spot introduced V2
- Never use cluster-autoscaler — Karpenter only

### Pod Identity (preferred over IRSA)
- One `CfnPodIdentityAssociation` per service account, per namespace
- Defined in `EksPodIdentityStack`, not in addon stacks
- Always verify OIDC provider is NOT deleted until all IRSA→PodIdentity
  migrations are confirmed working

### Karpenter
- Install via Helm from `oci://public.ecr.aws/karpenter/karpenter`
- SQS interruption queue: required, provisioned in `EksKarpenterStack`
- EC2NodeClass: use same subnets/SGs as system node group V1
- NodePool consolidation: disabled V1, enabled V2

### Ingress (phased)
- **V1**: Traefik as Deployment (not DaemonSet) behind NLB, IP target mode
  - NLB annotation: `aws-load-balancer-nlb-target-type: ip`
  - IngressRoute CRDs unchanged from kubeadm
  - cert-manager + Let's Encrypt retained
- **V2**: ALB Ingress via AWS LB Controller, ACM certs, external-secrets
  replaces PostSync patchers for CloudFront origin secret
- Never suggest DaemonSet+hostNetwork for Traefik on EKS

### DNS ownership boundary
| Resource | Owner |
|---|---|
| CloudFront aliases, NLB hostname, RDS endpoints | CDK (EdgeStack / BaseStack) |
| Service/Ingress hostnames for workloads | external-dns operator |
- external-dns: scoped to `nelsonlamounier.com` zone, txt-owner-id prefix set
- CDK Route53 records and external-dns records must never overlap

### Observability
- Prometheus/Loki/Tempo/Pyroscope PVCs: ephemeral, fresh on each cluster
- Grafana dashboards + alert rules + datasource config: git-only (Helm values
  + ConfigMaps) — never store state in Grafana's SQLite
- Do not suggest EBS volume reattach across clusters (AZ pinning fights Karpenter)

---

## Kubernetes manifest conventions (kubernetes-bootstrap repo)

### Folder structure
argocd-apps/
eks/          ← ArgoCD root app points here (active)
_deprecated_kubeadm/  ← frozen reference, not ArgoCD-tracked

### Deprecated YAML header
```yaml
# @deprecated: Replaced by <chart> on YYYY-MM-DD
# @reason: <one line>
# @see: docs/superpowers/specs/2026-05-05-eks-migration-design.md
# Do not apply. Kept as reference implementation.
```

### ArgoCD sync waves (EKS order)
Wave 0: namespaces, CRDs
Wave 1: external-secrets, cert-manager (V1 only)
Wave 2: karpenter, aws-load-balancer-controller, external-dns
Wave 3: traefik (V1) / ingress resources (V2)
Wave 4: monitoring stack
Wave 5: workload charts

### Helm values hygiene
- Never hardcode account IDs or ARNs in chart values
- Use external-secrets to inject SSM/Secrets Manager values
- Resource limits required on every workload container
- `podDisruptionBudget` required on any Deployment with >1 replica

---

## GitHub Actions CI/CD

- Auth: OIDC only — no long-lived AWS credentials
- CDK deploy: always `--require-approval never` in CI
- Synth check runs on every PR (no deploy)
- Deploy runs on merge to main, per environment
- Never suggest `aws configure` or access key setup in pipeline steps

---

## Cost guardrails

- Default to `t3.medium` / `t3.large` for dev — no oversized instances
  without explicit ask
- NAT Gateway: one per VPC, not per AZ in dev
- ALB/NLB: consolidated via `group.name` or single entrypoint where possible
- Flag any resource that adds >$10/mo to dev cluster

---

## What not to suggest

- `DaemonSet+hostNetwork` for any new addon on EKS
- IRSA for new service accounts (Pod Identity only)
- `cluster-autoscaler` (Karpenter owns node scaling)
- `aws-node-termination-handler` on EKS nodes
- Hardcoded AWS account IDs or region strings
- `RemovalPolicy.DESTROY` on databases or volumes without explicit ask
- EBS volume reattach across clusters
- Manual `kubectl apply` steps that should be ArgoCD-managed
- `eks.KubernetesManifest` for anything that belongs in kubernetes-bootstrap