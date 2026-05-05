# Self-Hosted Kubernetes → EKS Migration Design

- **Status:** Approved (brainstorm complete) — pending implementation plan
- **Date:** 2026-05-05
- **Owner:** Nelson Lamounier
- **Scope:** Replace self-hosted kubeadm cluster with Amazon EKS across `development`, `staging`, `production`. All-at-once cutover per environment, controlled by GitHub Actions workflows.
- **Out of scope (deferred to V2 spec):** Migration from Traefik IngressRoute → AWS ALB Ingress Controller, ACM cert adoption, removal of cert-manager, retirement of PostSync patcher pattern.

---

## 1. Drivers & Goals

### 1.1 Why migrate

- **Ops burden:** kubeadm control-plane troubleshooting, etcd backup/restore, AMI bootstrap orchestration, EIP failover Lambda — all consume disproportionate time relative to application work.
- **Industry alignment:** Modern cloud architecture relies on managed control planes. EKS is what employers run; self-hosted kubeadm is increasingly a niche pattern.
- **Recruiter signal:** Demonstrating both *"I built this the hard way"* (deprecated files retained) **and** *"I migrated to managed services with documented rationale"* is a stronger narrative than either alone.

### 1.2 Goals

1. EKS cluster per environment, deployable independently from CDK + GitHub Actions.
2. Per-env spin-up / teardown supported (not all three running simultaneously).
3. Karpenter for workload compute (V1 scope: 1 NodePool, on-demand t3.large family).
4. EKS Pod Identity replaces IRSA for all workload IAM bindings.
5. Zero-downtime cutover via CloudFront origin failover.
6. All deprecated files retained with structured TSDoc/JSDoc explaining design history.
7. Account ID consolidated to a single source (GitHub Environment vars/secrets); CDK synth must not require the account ID at construct instantiation.

### 1.3 Non-goals

- Multi-cluster federation, cross-region replication.
- ALB Ingress migration (V2).
- Spot consolidation tuning, multi-NodePool topology, Karpenter consolidation strategies.
- Migration of Prometheus/Loki/Tempo historical data.
- EKS Auto Mode (rejected: hides the patterns that demonstrate EKS expertise).

---

## 2. Architecture Overview

```
                                ┌─────────────────────────────┐
                                │  CloudFront Distribution    │
                                │  (origin group)             │
                                │   primary  → kubeadm NLB    │  ← flip on cutover day
                                │   secondary → EKS NLB        │
                                └──────────────┬──────────────┘
                                               │
            ┌──────────────────────────────────┼──────────────────────────────────┐
            │                                  │                                  │
   ┌────────▼─────────┐               ┌────────▼─────────┐                        │
   │ kubeadm cluster  │               │   EKS cluster    │                        │
   │  (Deprecated)    │               │   (V1, new)      │                        │
   │                  │               │                  │                        │
   │ EIP + NLB        │               │ NLB (IP mode)    │                        │
   │ Traefik DS+host  │               │ Traefik Deploy   │ ← V1: chart replaced   │
   │ kubeadm CP       │               │ EKS managed CP   │                        │
   │ ASG workers      │               │ MNG (system) +   │                        │
   │ Cluster AS       │               │ Karpenter (work) │                        │
   │ NTH (active)     │               │ NTH disabled     │                        │
   │ ESO via node IAM │               │ ESO via Pod ID   │                        │
   └──────────────────┘               └────────┬─────────┘                        │
                                               │                                  │
                  shared VPC (10.0.0.0/16, eu-west-1) — both clusters             │
                                               │                                  │
                                      external-dns ─→ Route53 (workload records)  │
                                      CDK            ─→ Route53 (static infra)  ──┘
```

**Key decisions:**

- **Single VPC** — both clusters share the existing `Shared` stack VPC during cutover; subnets retagged with `kubernetes.io/role/{elb,internal-elb}` and `kubernetes.io/cluster/<name>: shared` (NOT `owned` — `owned` would let EKS delete the subnet).
- **Pure Karpenter** for workloads, with mandatory small system MNG (3× t3.medium across 3 AZs) for Karpenter controller, CoreDNS, kube-proxy, monitoring stack.
- **Pod Identity** (Nov 2023) replaces IRSA. Existing OIDC CloudFront stack retained as a deprecated reference.
- **CloudFront origin failover** as cutover mechanism. Primary-with-automatic-failover semantics; flip is a primary swap, not a weight change.

---

## 3. Compute Strategy

### 3.1 System node group (MNG)

- 3× `t3.medium` on-demand, **spread across 3 AZs** (eu-west-1a/b/c, one per AZ) — required for Traefik anti-affinity (§5.2) and to avoid single-AZ SPOF for the control tier.
- Hosts: `karpenter`, `coredns`, `kube-proxy`, `aws-load-balancer-controller`, `external-dns`, `external-secrets`, `aws-ebs-csi-controller`, `monitoring` stack pods that require persistent placement.
- Taint: `dedicated=system:NoSchedule` — workload pods explicitly tolerated only on Karpenter nodes.
- AMI: EKS-optimized Amazon Linux 2023 (managed by EKS, no Golden AMI pipeline needed).

### 3.2 Workload compute (Karpenter)

V1 scope (deliberately tight):

- **One** `NodePool` named `workloads-default`, on-demand only, `t3.large` family.
- **One** `EC2NodeClass` named `workloads-default-class` referencing existing private subnets + a dedicated worker SG.
- **SQS interruption queue** (provisioned by `EksKarpenterStack`) wired to EventBridge rules for Spot interruption, scheduled change, instance termination, rebalance recommendation events. Even though V1 is on-demand-only, the queue is provisioned now to match Karpenter's operating model and to enable future Spot rollout without re-architecture.
- **No** consolidation strategy tuning, **no** multi-NodePool weights, **no** Spot fallback. Defer to V2+.

### 3.3 Sequencing (the chicken-egg trap)

```
EksClusterStack            (cluster, IAM, KMS)
   ↓
EksSystemNodeGroupStack    (MNG up — Karpenter has somewhere to land)
   ↓
EksPodIdentityStack        (associations created — addons can pull AWS creds)
   ↓
EksAddonsStack             (Helm: karpenter, alb-controller, external-dns, ESO, EBS CSI, VPC CNI)
   ↓ wait: kubectl wait --for=condition=Established crd/nodepools.karpenter.sh
EksKarpenterStack          (NodePool + EC2NodeClass + SQS)
```

ArgoCD bootstrap mirrors this with sync waves. NodePool/EC2NodeClass live in their own ArgoCD app at sync-wave 1; Karpenter Helm install at sync-wave 0; both gated behind `kubectl wait --for=condition=Established` on the CRDs to prevent the CRD-validation-error loop.

---

## 4. Identity (Pod Identity)

### 4.1 Migration of existing IAM bindings

Every Kubernetes ServiceAccount that currently relies on the EC2 node IAM role (kubeadm pattern) gets a Pod Identity Association on EKS:

| Workload | Service Account | Permissions |
|---|---|---|
| `external-secrets` (ESO controller) | `kube-system/external-secrets` | `ssm:GetParameter*`, `secretsmanager:GetSecretValue`, `kms:Decrypt` |
| `aws-load-balancer-controller` | `kube-system/aws-load-balancer-controller` | `elasticloadbalancing:*`, `ec2:DescribeSubnets`, `acm:DescribeCertificate` (per AWS docs IAM policy) |
| `aws-ebs-csi-controller` | `kube-system/ebs-csi-controller-sa` | `ec2:CreateVolume`, `ec2:AttachVolume`, etc. (AWS managed `AmazonEBSCSIDriverPolicy`) |
| `karpenter` | `karpenter/karpenter` | `ec2:RunInstances`, `iam:PassRole` (node role only), `sqs:ReceiveMessage` (interruption queue) |
| `external-dns` | `kube-system/external-dns` | `route53:ChangeResourceRecordSets` scoped to your hosted zone IDs |
| `crossplane-aws-provider` | `crossplane-system/provider-aws-*` | service-specific policies |
| Workload pods (admin-api, ingestion, job-strategist, resume-import, article-pipeline, tucaken-app) | per-namespace SA | RDS connect, S3 read/write, SSM read for app config |

### 4.2 OIDC stack — coexistence, not immediate deprecation

The existing `OidcStack` (CloudFront `oidc.nelsonlamounier.com`) **stays operational** until every IRSA service account above has been verified working under Pod Identity in dev. Only after dev cluster validates ESO + EBS CSI + Crossplane + every workload SA does `OidcStack` get renamed `Deprecated_OidcStack`. IRSA and Pod Identity coexist on EKS — there is no race or conflict.

---

## 5. Networking & Ingress

### 5.1 VPC reuse

- Existing `Shared` stack VPC (10.0.0.0/16, eu-west-1) reused.
- Subnet retagging via CDK `Shared` stack update:
  - Public: `kubernetes.io/role/elb=1`, `kubernetes.io/cluster/<name>=shared`
  - Private: `kubernetes.io/role/internal-elb=1`, `kubernetes.io/cluster/<name>=shared`
- **Pre-cutover audit:** run `aws ec2 describe-subnets --filters "Name=vpc-id,Values=<vpc-id>" --query 'Subnets[*].{ID:SubnetId,AZ:AvailabilityZone,CIDR:CidrBlock,Available:AvailableIpAddressCount}'` to verify each subnet has enough free IPs for both clusters during dual-cluster window. EKS needs at least /28 free per subnet for cluster ENIs; Karpenter pods + kubeadm pods together must fit.
- New SG `eks-workers-<env>` for Karpenter-launched nodes; existing kubeadm SG remains until decommission.

### 5.2 Ingress — V1: Traefik on NLB (IP mode)

Traefik chart rewritten:

- **Deployment** (3 replicas, anti-affinity), no longer DaemonSet, no longer hostNetwork.
- Service of `type: LoadBalancer` with annotations:
  - `service.beta.kubernetes.io/aws-load-balancer-type: external`
  - `service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip` ← **critical for Karpenter**
  - `service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing`
- IP target-type avoids NodePort hop. NodePort registration lags Karpenter node churn → intermittent 502s. IP mode targets pod IPs directly via VPC CNI.

**Unchanged in V1:**
- All workload `IngressRoute` CRDs (admin-api, nextjs, public-api, tucaken-app, argocd-ingress, etc.)
- PostSync patcher jobs (CloudFront origin secret, IP allowlist)
- cert-manager + Let's Encrypt for TLS
- Traefik middleware (CloudFront origin secret regex, IP allowlist)

V1 is a staging state, not a portfolio state. V2 (separate spec) will collapse this into ALB Ingress + ACM + ESO-backed ALB listener rules.

### 5.3 DNS

- **CDK-owned (static):** CloudFront aliases, NLB hostname records, RDS endpoints — `EdgeStack` and `BaseStack` continue to write these via Route53 constructs.
- **external-dns-owned (dynamic):** workload Service/Ingress hostnames tied to pod lifecycle.
- external-dns Helm chart added in `EksAddonsStack`:
  - Pod Identity association with `route53:ChangeResourceRecordSets` scoped to your hosted zone IDs.
  - `--domain-filter=nelsonlamounier.com` (and any other zones).
  - `--txt-owner-id=eks-<env>` so ownership records never collide with the ones CDK writes.
  - `--policy=upsert-only` to prevent accidental record deletion during cluster teardown.

---

## 6. Cutover Mechanism

### 6.1 Mechanism: CloudFront origin failover

Origin failover semantics: **primary-with-automatic-failover, not active-active.** CloudFront only routes to the secondary origin when the primary returns specific HTTP error codes (502, 503, 504 by default; configurable). This means:

- During the parallel observation window, EKS as secondary receives **zero user traffic** unless kubeadm returns errors.
- The "flip" is a primary swap in the origin group config, not a weight change.
- Rollback is equally instant (swap primary back).
- **Origin failover does NOT catch application-correctness regressions** (200-OK with broken content). Pre-flip smoke tests must hit every critical path against the EKS NLB hostname directly.

### 6.2 Per-env sequence

```
Day 0  EKS cluster up, ArgoCD synced, all pods Healthy, NLB DNS allocated
Day 1  EdgeStack updated → CloudFront origin group:
         primary   = kubeadm NLB
         secondary = EKS NLB
       Smoke test EKS NLB hostname directly:
         - every workload health endpoint
         - auth flow end-to-end
         - AI-app paths (ingestion, job-strategist, resume-import)
         - admin-api blue/green rollout
         - ESO secret resolution
         - EBS PVC mount on a fresh Karpenter node
Day 2  EdgeStack updated → swap primary/secondary:
         primary   = EKS NLB
         secondary = kubeadm NLB (kept as safety net)
       Monitor 30 min: CloudFront 5xx rate, app metrics, RDS conn pool
Day 7  If clean → tear down kubeadm EC2s, remove kubeadm NLB from origin group
       If issues → swap primary back, same-day recovery
```

The $5/week extra NLB cost during the parallel observation window is accepted.

### 6.3 Synthetic monitoring (recommended add)

CloudWatch Synthetics canary (one per env) running every 5 min, hitting critical paths against the CloudFront URL. Catches application-level regressions that origin failover cannot. Adds to V1 scope.

---

## 7. Repository Decomposition

### 7.1 cdk-monitoring stack layout

| Stack | Fate | Notes |
|---|---|---|
| `Data` | KEEP | DynamoDB still in use |
| `Base` | MODIFY | Subnet retagging; NLB-for-kubeadm marked deprecated in code |
| `ControlPlane` | DEPRECATE | → `Deprecated_ControlPlaneStack` |
| `GeneralPool` | DEPRECATE | → `Deprecated_GeneralPoolStack` |
| `MonitoringPool` | DEPRECATE | → `Deprecated_MonitoringPoolStack` |
| `AppIam` | REWRITE | Drop EC2 node-role grants; delegated to `EksPodIdentityStack` |
| `Api` | KEEP | Unchanged |
| `Edge` | MODIFY | Origin group additive (kubeadm NLB + EKS NLB) |
| `Oidc` | DEPRECATE *(deferred)* | → `Deprecated_OidcStack` only after every IRSA→PodID migration verified |
| `PlatformRds` | KEEP | Unchanged |
| `Observability` | EXTEND | CloudWatch dashboards add EKS metrics, Karpenter metrics |

**New EKS stacks (6):**

| Stack | Responsibility | Depends on |
|---|---|---|
| `EksClusterStack` | Cluster, KMS envelope key, Cluster IAM role, CloudWatch logs | Shared (VPC) |
| `EksSystemNodeGroupStack` | Small MNG (2× t3.medium) + node IAM role | EksCluster |
| `EksPodIdentityStack` | All Pod Identity Associations | EksSystemNodeGroup |
| `EksAddonsStack` | Helm: karpenter, alb-ctrl, external-dns, ESO, EBS CSI, VPC CNI | EksPodIdentity |
| `EksKarpenterStack` | NodePool + EC2NodeClass + SQS interruption queue + EventBridge rules | EksAddons |
| `EksAccessStack` | Access Entries for GH OIDC role + admin role | EksCluster |

**Single-failure-domain rationale:** when (not if) `EksAddonsStack` fails mid-deploy, you don't want Karpenter, ALB Controller, ESO, EBS CSI, VPC CNI, and Pod Identity all in the same CloudFormation event stream. Splitting them lets you isolate the failure to one Helm chart and re-deploy that stack alone.

**Total counts:** 11 active → 10 active EKS-era + 5 deprecated = 15 stack classes. Net active reduction: 1.

### 7.2 Deprecation file convention

Every deprecated stack file follows this header:

```typescript
/**
 * @deprecated Replaced by EksClusterStack on 2026-MM-DD as part of
 *   self-host→EKS migration.
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md
 *
 * Original purpose:
 *   Provisioned single-node kubeadm control plane (t3.medium ASG, EIP
 *   failover Lambda) for self-hosted Kubernetes cluster.
 *
 * Why deprecated:
 *   - kubeadm upgrades consumed disproportionate ops time
 *   - etcd backup/restore was hand-rolled (S3 systemd timer)
 *   - EKS managed control plane removes both burdens for ~$73/mo per cluster
 *
 * Why kept (not deleted):
 *   - Reference implementation for "self-hosted k8s on EC2" pattern
 *   - Demonstrates EIP failover Lambda, ASG-of-1 control-plane bootstrap,
 *     Step Functions–driven AMI refresh
 *   - Supports portfolio narrative: "I built this the hard way before
 *     migrating to managed services."
 *
 * @destroyOrder
 *   1. Drain and terminate all kubeadm worker nodes
 *   2. Remove kubeadm NLB from CloudFront origin group (EdgeStack deploy)
 *   3. Confirm Route53 records point only at EKS NLB
 *   4. Run: cdk destroy Deprecated_ControlPlaneStack
 *
 * Do not import or instantiate. Filtered out of synth via
 * `getProjectFactoryFromContext` based on the `Deprecated_` class-name prefix.
 */
export class Deprecated_ControlPlaneStack { ... }
```

**Filter rule:** factory registry filters on **class name prefix `Deprecated_`**, NOT on filename. A typo in a filename (`depregated_*` vs `deprecated_*`) must not silently include a deprecated stack in `cdk synth`.

**Folder convention:** deprecated stacks live in `infra/lib/projects/kubernetes/deprecated/`.

### 7.3 kubernetes-bootstrap repo strategy

**R2 — parallel folders, single repo:**

```
argocd-apps/
  eks/                         ← active, ArgoCD root app points here
  _deprecated_kubeadm/         ← reference, not synced
charts/
  eks/                         ← active charts
  _deprecated_kubeadm/         ← reference
gitops/
  eks/
  _deprecated_kubeadm/
sm-a/                          ← entire bootstrap orchestrator deprecated
  → renamed to _deprecated_sm-a/
  → README.md added explaining "kubeadm-era node bootstrap; replaced by EKS managed control plane"
```

Every deprecated YAML gets a top-of-file comment matching the TSDoc pattern (purpose, why deprecated, why kept, destroy order if applicable).

### 7.4 Chart fate table

| Chart | V1 fate | V2 fate | Notes |
|---|---|---|---|
| `traefik` | REWRITE (Deployment + NLB IP mode) | DELETE | Replaced by ALB Ingress in V2 |
| `cluster-autoscaler` | DELETE → `_deprecated_kubeadm/` | — | Karpenter replaces |
| `aws-cloud-controller-manager` | DELETE → `_deprecated_kubeadm/` | — | EKS provides natively |
| `aws-node-termination-handler` | KEEP V1 (active on kubeadm only, **disabled on EKS**) | DELETE | Karpenter SQS handles interruption on EKS; NTH races Karpenter if both run on same nodes — must not coexist |
| `external-secrets` | KEEP, switch to Pod Identity | KEEP | |
| `cert-manager` | KEEP (Traefik V1 still uses Let's Encrypt) | DELETE | ACM replaces in V2 |
| `aws-ebs-csi-driver` | KEEP, switch to Pod Identity | KEEP | |
| `crossplane` + AWS provider | KEEP, switch to Pod Identity | KEEP | |
| `argo-rollouts`, `argocd-image-updater`, `reloader`, `descheduler`, `metrics-server`, `opencost` | KEEP unchanged | KEEP | |
| `arc-controller`, `arc-runners`, `arc-runners-tucaken` | KEEP unchanged | KEEP | |
| `monitoring` (Prom/Loki/Tempo/Grafana/Alloy/etc.) | KEEP chart, fresh PVCs | KEEP | See §8 |
| `platform-rds` (PgBouncer) | KEEP unchanged | KEEP | |
| Workload charts (admin-api, nextjs, public-api, tucaken-app, article-pipeline, ingestion, job-strategist, resume-import, workload-generator) | KEEP V1 (IngressRoute unchanged) | REWRITE (Ingress) | |
| `argocd-ingress` IngressRoute + IP allowlist | KEEP V1 | REWRITE | |

**New charts:**

| Chart | Source | Purpose |
|---|---|---|
| `karpenter` | `oci://public.ecr.aws/karpenter/karpenter` | Workload compute autoscaler |
| `aws-load-balancer-controller` | `eks-charts` | Manages NLB for Traefik (V1); ALBs (V2) |
| `external-dns` | `bitnami/external-dns` (or `kubernetes-sigs`) | Workload DNS records via Pod Identity |
| `karpenter-nodepool` | local custom chart | Wraps NodePool + EC2NodeClass + SQS ARN, parameterized per env |

---

## 8. Observability State

**Strategy: S3 — fresh-start on PVCs, dashboards-as-code preserved.**

| Item | Source of truth | Cutover action |
|---|---|---|
| Grafana dashboards | git (Helm values + ConfigMaps) | preserved automatically |
| Alert rules | git (PrometheusRule CRDs) | preserved automatically |
| Datasource config | git (Grafana datasource values) | preserved automatically |
| Prometheus TSDB | EBS PVC (15-day retention) | accept loss |
| Loki logs | EBS PVC | accept loss |
| Tempo traces | EBS PVC | accept loss |
| Pyroscope profiles | EBS PVC | accept loss |
| Alertmanager state | EBS PVC | accept loss (ephemeral by nature) |

**Pre-cutover one-time check:** run `grafana-backup-tool` (or per-dashboard JSON export from the UI) to capture any dashboards created in the UI rather than from Helm values. If the chart-values audit shows everything is in git, this step is a no-op verification — but verify before deleting old PVCs.

**Why S2 (EBS reattach) was rejected:** AZ pinning. EBS volumes live in a specific AZ; if Karpenter schedules the Prometheus pod on a node in the wrong AZ, the pod sits Pending indefinitely. Solving this requires AZ topology constraints on the workload NodePool — adding state-aware scheduling complexity to a V1 deliberately scoped to a single simple NodePool. Not worth it for 15-day retention data.

**Spec narrative line:** *"Treated cluster-local TSDB as ephemeral; persistent observability lives in dashboards-as-code plus a future remote-write target (Mimir/Thanos)."* This is the honest acknowledgement of where Prom-on-PVC breaks at scale.

---

## 9. Configuration & Deployment Pipeline

### 9.1 Account ID consolidation

**Current state (dual source of truth):**
- Account IDs hardcoded in `infra/lib/config/environments.ts`
- GitHub workflow `_deploy-stack.yml` resolves from `vars.AWS_ACCOUNT_ID` (per GH Environment)

**Target state (single source of truth):**
- `environments.ts` reads `process.env.AWS_ACCOUNT_ID` only.
- Local dev: `.env` file at repo root provides it (already loaded by `app.ts` via dotenv).
- CI: GH workflow exports `vars.AWS_ACCOUNT_ID` into `process.env` before `cdk synth`.
- **Synth-time invariant:** no construct may read `Stack.of(this).account` synchronously during instantiation. Cross-account ARNs (DNS validation role, OIDC issuer trust, KMS key policies, S3 bucket policies) must use lazy resolution (token references) or be constructed from `process.env` reads at synth time, not from `Stack.account` lookups.
- **Inventory task in plan:** grep all `Stack.of(this).account` usages and reclassify each as either (a) safe (token, used in resource property), (b) needs refactor (used in conditional logic at synth time).

### 9.2 GitHub Actions — three deploy workflows + three destroy workflows

Pattern A from brainstorm: mirror per-env workflow files, all calling reusable workflow.

```
.github/workflows/
  deploy-eks-development.yml       ← workflow_run on Deploy Shared (Dev) + workflow_dispatch
  deploy-eks-staging.yml           ← workflow_dispatch only (manual gate)
  deploy-eks-production.yml        ← workflow_dispatch only (manual gate, requires approval)
  destroy-eks-development.yml      ← workflow_dispatch only
  destroy-eks-staging.yml          ← workflow_dispatch only
  destroy-eks-production.yml       ← workflow_dispatch only, requires approval
  _deploy-eks.yml                  ← reusable, takes environment input
  _destroy-eks.yml                 ← reusable, destroy in reverse-dependency order
```

Each `deploy-eks-<env>.yml` is ~30 lines (gate + call to `_deploy-eks.yml` with `environment: <env>`). `_deploy-eks.yml` orchestrates the 6-stack deploy in dependency order (Cluster → SystemNodeGroup → PodIdentity → Addons → Karpenter, plus Access in parallel after Cluster).

`_destroy-eks.yml` reverses order: Karpenter → Addons → PodIdentity → SystemNodeGroup → Access → Cluster. Pre-destroy hook drains workloads and removes finalizers.

### 9.3 Per-env spin-up / teardown

Workflow design supports the "not all 3 running simultaneously" constraint:
- Each env's deploy workflow is independently triggerable.
- Each env's destroy workflow is independently triggerable.
- No cross-env state coupling — no shared ECR repos, no shared KMS keys at the EKS layer.
- Cost during idle: zero (control plane destroyed, no NAT GW dedicated to EKS, no MNG running).

---

## 10. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| Cross-account `Stack.account` reads block account-ID consolidation | Inventory task in plan; refactor each call site before EKS work begins |
| Pod Identity not yet supported by some Helm chart | Hybrid IRSA + Pod Identity allowed; OIDC stack stays until verified |
| Subnet IP exhaustion during dual-cluster window | Pre-cutover audit; create additional `/24` subnets if any subnet has < 64 free IPs |
| Karpenter consolidation behavior surprises during traffic peak | V1 disables consolidation tuning; observe baseline first |
| External-dns and CDK both manage records of the same name | `--policy=upsert-only` + `--txt-owner-id=eks-<env>` + clear record-ownership boundary documented in §5.3 |
| ALB-Controller-managed NLB security group conflicts with kubeadm SG during dual-cluster window | New `eks-workers-<env>` SG; AWS LB Controller annotated to attach managed SG to NLB; explicitly does not modify kubeadm SG |
| Application-correctness regression invisible to CloudFront origin failover | Pre-flip smoke tests against EKS NLB hostname directly + CloudWatch Synthetics canary |
| `Deprecated_` class filter typo silently includes deprecated stack | Test added: assert no `Deprecated_*` class names appear in synth output |

---

## 11. Acceptance Criteria

V1 is complete in dev when:

1. `cdk deploy` for the kubernetes project provisions all 6 EKS stacks + reuses VPC + retags subnets, with no account ID hardcoded in CDK code.
2. ArgoCD root app on EKS reconciles `argocd-apps/eks/` to Healthy + Synced.
3. Karpenter provisions a t3.large node within 60s of a Pending pod with workload toleration.
4. ESO resolves an SSM parameter via Pod Identity (verify on a test secret).
5. EBS CSI mounts a 1Gi PVC on a fresh Karpenter node.
6. Traefik NLB (IP mode) accepts traffic on 443 with valid Let's Encrypt cert.
7. external-dns creates a Route53 A record for a test workload Service within 60s.
8. CloudFront origin group is updated; pre-flip smoke tests pass against EKS NLB hostname directly.
9. Origin failover flip succeeds; CloudWatch Synthetics canary green for 30 min post-flip.
10. After 7 days clean, kubeadm cluster torn down per `@destroyOrder` sequence.
11. All deprecated files renamed with TSDoc/JSDoc headers per §7.2 convention.
12. Spec line *"Treated cluster-local TSDB as ephemeral..."* reflected in repo README.

V1 is complete across envs when steps 1–11 verified in staging and production, each gated on manual approval.

---

## 12. Out-of-Scope Follow-ups (V2+ Specs)

- **V2 ingress:** Traefik → ALB Ingress Controller, ACM certs, ALB HttpHeader rules for CloudFront origin secret, ESO replaces PostSync patchers. Estimated 1 week.
- **V3 compute:** Spot fallback NodePool, consolidation tuning, multi-NodePool topology (memory-optimized, GPU).
- **V4 observability:** Prometheus remote-write to AMP (or Mimir), Loki to S3, Tempo to S3 — eliminate cluster-local TSDB.
- **V5 identity:** Pod Identity Association lifecycle managed by Crossplane (today: CDK).
