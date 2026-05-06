# EKS Migration — Plan 4 / 6: ArgoCD Bootstrap on EKS (Additive)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up ArgoCD on the new EKS cluster (Plan 2 + 3) and seed an additive `argocd-apps/eks/` tree in the `kubernetes-bootstrap` repo so future workload migrations have a clear home. Kubeadm ArgoCD continues to reconcile its existing tree untouched. No workloads move to EKS yet — that is Plan 5.

**Architecture:**
- Plan 2's `EksAddonsStack` already installs Karpenter, ESO, ALB controller, external-dns, EBS CSI via CDK Helm. ArgoCD does NOT manage those (CDK owns them in V1 to avoid reconcile fights).
- ArgoCD itself is installed once, manually, after the EKS cluster is up — via `helm install argocd` from a runbook step. Subsequent reconciliation is git-driven.
- A single ArgoCD `Application` (the root app) points at `argocd-apps/eks/development/` and reconciles every manifest committed there. That folder is empty in V1; Plan 5 fills it as workloads migrate.
- The kubeadm cluster's existing root app (`argocd-apps/*.yaml`) is unchanged; the two ArgoCD instances run in separate clusters and reconcile from disjoint paths in the same repo.

**Tech Stack:** ArgoCD v2.x, Helm 3, GitOps (one repo, two cluster trees), AWS EKS Pod Identity (Plan 2), Kubernetes 1.30.

**Repo:** `kubernetes-bootstrap` (separate from `cdk-monitoring`).

**Parent spec:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 7.3.

**Dependencies:**
- Plan 1 (account-ID consolidation) ✅
- Plan 2 (6 EKS stacks synthesize) ✅
- Plan 3 (GH workflows registered) ✅
- EKS cluster live in `development` (manual `workflow_dispatch` of `Deploy EKS to Development`).

---

## File Structure

All file paths are relative to `kubernetes-bootstrap/` (separate repo from `cdk-monitoring`).

**Files to create:**

| Path | Purpose |
|---|---|
| `argocd-apps/eks/README.md` | Explains the additive-tree convention; pointer to spec § 7.3. |
| `argocd-apps/eks/root-app-development.yaml` | Single ArgoCD `Application` whose source path is `argocd-apps/eks/development/`. Sync wave 0. |
| `argocd-apps/eks/development/.gitkeep` | Keeps the empty directory tracked in git so the root app reconciles to a Healthy + Synced state from day one. |
| `argocd-apps/eks/development/README.md` | Explains: "Plan 5 fills this directory with workload `Application` manifests. Empty in V1." |
| `docs/runbooks/argocd-on-eks.md` | Step-by-step runbook: install ArgoCD via Helm, apply root app, verify reconciliation. |

**Files to modify:**

| Path | Change |
|---|---|
| `README.md` (top of repo) | Add a section describing the dual-cluster gitops layout (kubeadm at top level vs `argocd-apps/eks/`). |

---

## Task 1: Author the EKS subtree README + root app

**Files:**
- Create: `argocd-apps/eks/README.md`
- Create: `argocd-apps/eks/root-app-development.yaml`

- [ ] **Step 1: `argocd-apps/eks/README.md`**

```markdown
# ArgoCD Apps — EKS Cluster Tree

This subtree is reconciled by the ArgoCD instance running on the **EKS** cluster
(see `cdk-monitoring/infra/lib/stacks/kubernetes/eks-cluster-stack.ts`). The
existing top-level `argocd-apps/*.yaml` tree is reconciled by the **kubeadm**
cluster's ArgoCD and is not touched by EKS.

## Layout

- `root-app-<env>.yaml` — single `Application` whose source path is
  `argocd-apps/eks/<env>/`. Apply once after ArgoCD is installed on the EKS
  cluster; everything else is reconciled from git.
- `<env>/` — flat list of `Application` manifests. Empty in V1 (Plan 4).
  Plan 5 (workload cutover) fills this directory.

## Why a separate tree

The kubeadm and EKS clusters run different chart versions and different infra
addons (kubeadm runs Karpenter not at all and Cluster Autoscaler instead;
EKS uses Karpenter via CDK Helm in `EksAddonsStack`). Having one tree per
cluster keeps reconciliation deterministic — no conditional logic in Helm
values based on cluster identity.

## Spec

`docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 7.3.
```

- [ ] **Step 2: `argocd-apps/eks/root-app-development.yaml`**

The "app of apps" pattern: this single Application reconciles every manifest in
`argocd-apps/eks/development/`. ArgoCD's `directory.recurse: false` keeps it
flat (matching the convention of the kubeadm tree).

```yaml
# @format
# ArgoCD root Application for the EKS development cluster.
#
# Apply once via `kubectl apply -f` after ArgoCD is installed on the EKS
# cluster (see docs/runbooks/argocd-on-eks.md). Subsequent reconciliation
# is git-driven — every manifest dropped into `argocd-apps/eks/development/`
# becomes an Application automatically.
#
# The kubeadm cluster has its own root app (top-level argocd-apps/*.yaml),
# which is unchanged by this manifest.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: eks-root-development
  namespace: argocd
  annotations:
    kubernetes.io/description: "Root app — reconciles everything in argocd-apps/eks/development/"
    argocd.argoproj.io/sync-wave: "-10"
  labels:
    app.kubernetes.io/part-of: argocd
    environment: development
    cluster: eks
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
    targetRevision: main
    path: argocd-apps/eks/development
    directory:
      recurse: false
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: true   # development/ is empty in V1; Plan 5 fills it.
    syncOptions:
      - CreateNamespace=false
      - ApplyOutOfSyncOnly=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

`allowEmpty: true` is the key flag — without it, an empty target directory makes
ArgoCD report `OutOfSync` rather than `Synced`. We need Synced from day one so
that Plan 5 can drop manifests in incrementally and watch each one reconcile.

- [ ] **Step 3: Commit (in `kubernetes-bootstrap` repo)**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git checkout -b feat/argocd-eks-bootstrap
git add argocd-apps/eks/README.md argocd-apps/eks/root-app-development.yaml
git commit -m "feat(argocd): add eks/ tree + development root app"
```

---

## Task 2: Empty target directory + placeholder

**Files:**
- Create: `argocd-apps/eks/development/.gitkeep`
- Create: `argocd-apps/eks/development/README.md`

- [ ] **Step 1: `.gitkeep`** — zero-byte file so git tracks the otherwise-empty directory.

```bash
mkdir -p argocd-apps/eks/development
touch argocd-apps/eks/development/.gitkeep
```

- [ ] **Step 2: `argocd-apps/eks/development/README.md`**

```markdown
# argocd-apps/eks/development

Reconciled by `eks-root-development` (one directory up).

Empty in V1 (Plan 4) — Plan 5 (workload cutover) fills this directory with
`Application` manifests, one per workload that migrates from the kubeadm
cluster.

## Adding a workload

1. Copy the matching top-level manifest (e.g. `argocd-apps/admin-api.yaml`)
   into this directory and rename it `<name>-development.yaml`.
2. Adjust:
   - `metadata.name` → `<name>-eks-development` so it doesn't collide with the
     kubeadm-cluster app name.
   - `spec.source.path` → the chart's existing path (chart code is shared).
   - `spec.source.helm.valueFiles` → use a new `values-eks-development.yaml`
     overlay if EKS-specific changes are needed (Pod Identity SAs, NodePool
     tolerations, ALB Ingress instead of IngressRoute).
3. Commit. The root app picks it up on next sync (default: 3 min, or trigger
   via `argocd app sync eks-root-development`).
```

- [ ] **Step 3: Commit**

```bash
git add argocd-apps/eks/development/
git commit -m "feat(argocd): seed empty argocd-apps/eks/development/ target"
```

---

## Task 3: Runbook — install ArgoCD on the EKS cluster

**Files:**
- Create: `docs/runbooks/argocd-on-eks.md`

This is a one-time bootstrap step. After the EKS cluster is up (via `Deploy EKS
to Development` workflow), run these commands once. Subsequent updates flow
through git.

- [ ] **Step 1: Author the runbook**

```markdown
# Runbook — Install ArgoCD on the EKS Cluster

**When to run:** Once, after `Deploy EKS to Development` workflow reports
success and `kubectl get nodes` shows 3 system nodes Ready.

**Why:** ArgoCD is the entry point for everything else. We install it
manually one time so subsequent changes are git-driven via the root app
created in `argocd-apps/eks/root-app-development.yaml`.

**Why not via `EksAddonsStack`?** Mixing ArgoCD with the CDK-managed Helm
charts in the addons stack creates a chicken-and-egg: ArgoCD would need to
exist before it can reconcile its own configuration. Cleaner to install
once via Helm CLI and hand off to git.

## Prerequisites

- AWS CLI configured with the dev account.
- `kubectl` and `helm` installed.
- EKS cluster `k8s-eks-development` exists and is ACTIVE.

## Steps

### 1. Configure kubectl

\`\`\`bash
aws eks update-kubeconfig \
  --name k8s-eks-development \
  --region eu-west-1 \
  --alias eks-dev
kubectl --context eks-dev get nodes
# Expected: 3 t3.medium nodes, taint dedicated=system:NoSchedule
\`\`\`

### 2. Install ArgoCD via Helm

\`\`\`bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --version 7.7.5 \
  --set 'server.service.type=ClusterIP' \
  --set 'configs.params."server.insecure"=true' \
  --set 'controller.tolerations[0].key=dedicated' \
  --set 'controller.tolerations[0].value=system' \
  --set 'controller.tolerations[0].effect=NoSchedule' \
  --kube-context eks-dev
\`\`\`

The system MNG taint forces ArgoCD's stateful controllers onto the system
nodes (where the SQS-receiving Karpenter controller also runs); workload
pods land on Karpenter-provisioned nodes once Plan 5 begins.

### 3. Wait for ArgoCD to be Ready

\`\`\`bash
kubectl --context eks-dev -n argocd wait \
  --for=condition=available deployment --all --timeout=5m
\`\`\`

### 4. Add the SSH deploy key (read-only)

The root app's \`source.repoURL\` is SSH. ArgoCD needs a private key to
clone:

\`\`\`bash
# Read the deploy-key private blob from SSM (provisioned by cdk-monitoring
# Shared stack in 0b42315 era; same key reused on EKS).
DEPLOY_KEY=\$(aws ssm get-parameter \
  --name /shared/development/argocd-deploy-key \
  --with-decryption --query 'Parameter.Value' --output text)

kubectl --context eks-dev -n argocd create secret generic argocd-repo-creds \
  --from-literal=type=git \
  --from-literal=url=git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git \
  --from-literal=sshPrivateKey="\$DEPLOY_KEY"
kubectl --context eks-dev -n argocd label secret argocd-repo-creds \
  argocd.argoproj.io/secret-type=repository
\`\`\`

### 5. Apply the root app

\`\`\`bash
kubectl --context eks-dev apply \
  -f https://raw.githubusercontent.com/Nelson-Lamounier/kubernetes-bootstrap/main/argocd-apps/eks/root-app-development.yaml
\`\`\`

### 6. Verify

\`\`\`bash
kubectl --context eks-dev -n argocd get application eks-root-development
# Expected: SYNC STATUS=Synced, HEALTH STATUS=Healthy
\`\`\`

The app reconciles an empty directory, so \`Synced\` + \`Healthy\` is the
target state for V1. Plan 5 fills the directory and watches individual
workload Apps appear.

## Troubleshooting

- **OutOfSync, "directory is empty":** the root app is missing
  \`syncPolicy.automated.allowEmpty: true\`. Re-apply the manifest.
- **ComparisonError, "repository not accessible":** the deploy-key secret
  is missing the \`argocd.argoproj.io/secret-type=repository\` label. ArgoCD
  ignores secrets without it.
- **Application controller pod Pending:** the system MNG isn't tolerated
  in the Helm values above — re-run step 2 with the toleration flags.

## Spec

\`docs/superpowers/specs/2026-05-05-eks-migration-design.md\` §§ 3.3, 7.3.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/argocd-on-eks.md
git commit -m "docs(runbook): install ArgoCD on the EKS development cluster"
```

---

## Task 4: Top-level README pointer

**Files:**
- Modify: `README.md` (root of `kubernetes-bootstrap`)

- [ ] **Step 1: Add a "Dual-cluster layout" section**

```bash
grep -n "^## " README.md | head
```

Insert (before the existing "## Conventions" or similar section, or near the
top under the project description):

```markdown
## Dual-cluster layout (2026-05-05)

This repo is reconciled by **two** ArgoCD instances:

| Cluster | Tree | Status |
|---|---|---|
| Self-hosted kubeadm (current) | `argocd-apps/*.yaml` (top level) | Active. |
| EKS (V1, dev only) | `argocd-apps/eks/<env>/` | Empty target — Plan 5 fills. |

The EKS subtree was added as part of the kubeadm → EKS migration. See:
- Spec: `cdk-monitoring/docs/superpowers/specs/2026-05-05-eks-migration-design.md`
- Plan 4 (this addition): `cdk-monitoring/docs/superpowers/plans/2026-05-05-eks-migration-04-argocd-bootstrap.md`
- Runbook: `docs/runbooks/argocd-on-eks.md`
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe dual-cluster ArgoCD layout (kubeadm vs eks/)"
```

---

## Task 5: Push branch + open PR

- [ ] **Step 1: Push**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git push -u origin feat/argocd-eks-bootstrap
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --head feat/argocd-eks-bootstrap \
  --title "feat(argocd): add EKS bootstrap subtree (additive)" \
  --body "$(cat <<'EOF'
## Summary

Plan 4 of the kubeadm → EKS migration. Additive: leaves the existing
top-level `argocd-apps/*.yaml` tree alone.

- New `argocd-apps/eks/development/` directory (empty).
- Root app `argocd-apps/eks/root-app-development.yaml` reconciles that
  directory — `allowEmpty: true` so it reaches Synced from day one.
- Runbook `docs/runbooks/argocd-on-eks.md` documents the one-time Helm
  install and deploy-key wiring on the EKS cluster.

Workload migration into `argocd-apps/eks/development/` is Plan 5.

## Test plan

- [ ] After EKS cluster is up (cdk-monitoring PR #112 merged + manual
      deploy), run the runbook to install ArgoCD.
- [ ] Apply the root app — verify `Synced` + `Healthy`.
- [ ] Drop a no-op test Application into `eks/development/`, watch the
      root app reconcile it.
EOF
)"
```

- [ ] **Step 3: Note the PR URL** in this plan's commit history.

---

## Task 6: Mark spec § 7.3 status (in `cdk-monitoring`)

**Files:**
- Modify: `cdk-monitoring/docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 7.3

- [ ] **Step 1: Append**

```markdown

**Status:** ✅ Done (2026-05-05) — see Plan 4 (`cdk-monitoring/docs/superpowers/plans/2026-05-05-eks-migration-04-argocd-bootstrap.md`). Additive approach: `argocd-apps/eks/development/` created in `kubernetes-bootstrap`; root app `eks-root-development` reconciles the (initially empty) directory with `allowEmpty: true`. Kubeadm tree untouched. Runbook `docs/runbooks/argocd-on-eks.md` documents the one-time Helm install. Workload migration into the directory is Plan 5.
```

- [ ] **Step 2: Commit (in `cdk-monitoring` repo on `develop`)**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
git add -f docs/superpowers/specs/2026-05-05-eks-migration-design.md
git commit -m "docs(eks): mark Plan 4 (ArgoCD bootstrap, additive) complete"
```

---

## Acceptance Criteria — Plan 4 Done When

1. `kubernetes-bootstrap` PR merged: `argocd-apps/eks/development/` exists, contains `.gitkeep` + `README.md`, and `eks-root-development` Application reconciles it.
2. `argocd-apps/eks/root-app-development.yaml` has `allowEmpty: true` so an empty directory reports `Synced`.
3. Runbook `docs/runbooks/argocd-on-eks.md` exists and lists exact commands for `helm install argocd`, deploy-key wiring, and root-app apply.
4. Top-level README explains the dual-cluster layout.
5. EKS-side ArgoCD installed on `k8s-eks-development` per the runbook (manual step, gated by EKS cluster being live).
6. `kubectl --context eks-dev -n argocd get application eks-root-development` returns `Synced` + `Healthy`.
7. Spec § 7.3 marked Done.

Step 5 + 6 require the EKS cluster to be live (cdk-monitoring PR #112 merged + `Deploy EKS to Development` workflow run). They are out of scope for Plan 4 commit-level work but are part of the acceptance gate.

---

## Out of Scope (later plans)

- Plan 5: workload migration — fills `argocd-apps/eks/development/` with admin-api, ingestion, etc., adapted for EKS (Pod Identity SAs, NodePool tolerations).
- Plan 6: `_deprecated_kubeadm/` rename of the top-level tree once cutover is complete and stable.

---

## Risks Specific to This Plan

| Risk | Mitigation |
|---|---|
| Two ArgoCD instances reconciling the same chart code from `charts/` create version drift between clusters during the dual-cluster window | Acceptable for V1 dev — there is no shared workload yet. Documented in `argocd-apps/eks/README.md`. |
| `allowEmpty: true` makes it easy to forget the root app exists | Counter: by Plan 5 the directory will not be empty for long. The runbook's verification step also surfaces the app status. |
| Manual ArgoCD install drifts from git over time (helm upgrade vs git source-of-truth) | Plan 5 introduces an `argocd-self-managed` Application that points at this same chart. V1 keeps it simple. |
| ArgoCD on EKS may not have Pod Identity for any workload secrets | ArgoCD doesn't itself need AWS API access in V1. Workload-specific Pod Identity is wired in `EksPodIdentityStack` from Plan 2. |
