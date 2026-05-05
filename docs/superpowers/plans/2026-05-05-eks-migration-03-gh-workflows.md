# EKS Migration — Plan 3 / 6: GitHub Actions Workflows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-env GitHub Actions workflows that deploy and destroy the 6 EKS stacks Plan 2 added, mirroring the existing `_deploy-stack.yml` / `deploy-kubernetes.yml` pattern. Dev triggers automatically after `Deploy Shared (Dev)`; staging/production are manual `workflow_dispatch` only with environment-protection approvals.

**Architecture:** Same primitives as the existing kubeadm pipeline: a reusable `_deploy-eks.yml` orchestrates synth → preflight → deploy of each EKS stack in dependency order via `_deploy-stack.yml` (already in repo). Three per-env trigger workflows (`deploy-eks-development.yml`, `deploy-eks-staging.yml`, `deploy-eks-production.yml`) dispatch into the reusable. Mirror destroy: `_destroy-eks.yml` (reverse order) + three per-env destroy triggers, all `workflow_dispatch` only.

**Tech Stack:** GitHub Actions reusable workflows (`workflow_call`, `workflow_run`, `workflow_dispatch`), AWS OIDC auth (no static keys), `_deploy-stack.yml` per-stack reusable.

**Parent spec:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 9.2.

**Dependencies:**
- Plan 1 (account-id consolidation) ✅ complete.
- Plan 2 (6 EKS stacks synthesize) ✅ complete.

---

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `.github/workflows/_deploy-eks.yml` | Reusable: synth + deploy 6 EKS stacks in dep order |
| `.github/workflows/_destroy-eks.yml` | Reusable: destroy 6 EKS stacks in reverse dep order |
| `.github/workflows/deploy-eks-development.yml` | Trigger: workflow_dispatch + workflow_run on Deploy K8s (Dev) |
| `.github/workflows/deploy-eks-staging.yml` | Trigger: workflow_dispatch only |
| `.github/workflows/deploy-eks-production.yml` | Trigger: workflow_dispatch only (environment=production gates approval) |
| `.github/workflows/destroy-eks-development.yml` | Trigger: workflow_dispatch only |
| `.github/workflows/destroy-eks-staging.yml` | Trigger: workflow_dispatch only |
| `.github/workflows/destroy-eks-production.yml` | Trigger: workflow_dispatch only |

**Files to modify:**

| Path | Change |
|---|---|
| `infra/scripts/shared/stacks.ts` | Register the 6 EKS stack ids (`eksCluster`, `eksSystemNg`, `eksPodIdentity`, `eksAddons`, `eksKarpenter`, `eksAccess`) in the Kubernetes project so `cdk-synthesize` emits them as `GITHUB_OUTPUT` keys for downstream `_deploy-stack.yml` calls |

---

## Task 1: Register EKS stacks in the deploy script registry

**Files:**
- Modify: `infra/scripts/shared/stacks.ts`

The reusable `_deploy-stack.yml` reads stack names from `steps.synth.outputs.<id>`. Without registry entries, the synth script does not emit `GITHUB_OUTPUT` keys for the new stacks, so the EKS deploy workflow has nothing to feed into `_deploy-stack.yml`.

- [ ] **Step 1: Read current registry**

```bash
grep -n "registerProject\|k8sStacks\|id: '" infra/scripts/shared/stacks.ts | head -40
```

Expected: shows `const k8sStacks: StackConfig[] = [...]` followed by `registerProject({ id: 'kubernetes', stacks: k8sStacks, ... })` near the end.

- [ ] **Step 2: Append 6 EKS entries to `k8sStacks`**

In `infra/scripts/shared/stacks.ts`, find the closing `]` of the `k8sStacks` array. Before the `]`, insert:

```typescript
  // ===== EKS V1 stacks (parallel deployment alongside kubeadm cluster) =====
  // Dependency order: eksCluster → eksSystemNg → eksPodIdentity → eksAddons → eksKarpenter
  // (eksAccess deploys in parallel, depends only on eksCluster)
  // Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 7.1
  {
    id: 'eksCluster',
    name: 'EKS Cluster Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksCluster', env),
    description: 'EKS managed control plane + KMS envelope key + control-plane log group',
    dependsOn: ['base'],
  },
  {
    id: 'eksSystemNg',
    name: 'EKS System Node Group Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksSystemNg', env),
    description: '3× t3.medium MNG (system taint, AZ-spread)',
    dependsOn: ['eksCluster'],
  },
  {
    id: 'eksPodIdentity',
    name: 'EKS Pod Identity Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksPodIdentity', env),
    description: 'CfnPodIdentityAssociation + per-purpose IAM roles (Karpenter, ALB, ESO, EBS CSI, external-dns)',
    dependsOn: ['eksSystemNg'],
  },
  {
    id: 'eksAddons',
    name: 'EKS Addons Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksAddons', env),
    description: 'VPC CNI managed addon + Helm: ESO, ALB controller, external-dns, Karpenter, EBS CSI',
    dependsOn: ['eksPodIdentity'],
  },
  {
    id: 'eksKarpenter',
    name: 'EKS Karpenter Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksKarpenter', env),
    description: 'SQS interruption queue + 4 EventBridge rules + NodePool/EC2NodeClass manifests',
    dependsOn: ['eksAddons'],
  },
  {
    id: 'eksAccess',
    name: 'EKS Access Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksAccess', env),
    description: 'AccessEntry × N — IAM principal → Kubernetes RBAC bindings (Nov-2023 GA)',
    dependsOn: ['eksCluster'],
  },
```

Confirm `getStackId` exists in scope (it is already used by every other entry — same import path).

- [ ] **Step 3: Verify registry parses**

```bash
cd infra && yarn typecheck
# Expect exit 0.
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring && \
  AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  GITHUB_OUTPUT=/tmp/synth-out.txt LOG_LEVEL=info \
  npx cdk-synthesize kubernetes development 2>&1 | tail -10
grep -E "^eks(Cluster|SystemNg|PodIdentity|Addons|Karpenter|Access)<<" /tmp/synth-out.txt | head
```

Expected: 6 keys appear in `/tmp/synth-out.txt`, one per EKS stack id.

- [ ] **Step 4: Commit**

```bash
git add infra/scripts/shared/stacks.ts
git commit -m "ci(eks): register 6 EKS stacks in deploy script registry"
```

---

## Task 2: Reusable `_deploy-eks.yml`

**Files:**
- Create: `.github/workflows/_deploy-eks.yml`

This file is large but mechanical — it mirrors the structure of `_deploy-kubernetes.yml` but with only the EKS stacks. Re-use existing actions (`./.github/actions/setup-node-yarn`, `./.github/actions/configure-aws`) and the per-stack reusable `./.github/workflows/_deploy-stack.yml`.

- [ ] **Step 1: Author the reusable workflow**

Create `.github/workflows/_deploy-eks.yml` with this content. Read it carefully before pasting — the dependency wiring (`needs:`) is the load-bearing part.

```yaml
# @format
# Reusable EKS deploy — synth then deploy 6 EKS stacks in dependency order.
# Caller: deploy-eks-{development,staging,production}.yml.
# Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.2

name: Deploy EKS (Reusable)

on:
  workflow_call:
    inputs:
      environment:
        description: "Target environment (development | staging | production)"
        required: true
        type: string
      cdk-environment:
        description: "CDK environment name (same as environment for k8s)"
        required: true
        type: string
      require-approval:
        description: "CDK --require-approval mode"
        required: false
        type: string
        default: "never"
    secrets:
      AWS_OIDC_ROLE:
        required: true
      GH_OIDC_ROLE_ARN:
        required: false
      ADMIN_ROLE_ARN:
        required: false

env:
  NODE_VERSION: "22"
  AWS_REGION: ${{ vars.AWS_REGION || 'eu-west-1' }}
  DEPLOY_ENVIRONMENT: ${{ inputs.environment }}

jobs:
  setup:
    name: Synthesize EKS stack names
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest
    timeout-minutes: 15
    environment: ${{ inputs.environment }}
    outputs:
      eks-cluster: ${{ steps.synth.outputs.eksCluster }}
      eks-system-ng: ${{ steps.synth.outputs.eksSystemNg }}
      eks-pod-identity: ${{ steps.synth.outputs.eksPodIdentity }}
      eks-addons: ${{ steps.synth.outputs.eksAddons }}
      eks-karpenter: ${{ steps.synth.outputs.eksKarpenter }}
      eks-access: ${{ steps.synth.outputs.eksAccess }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - uses: ./.github/actions/setup-node-yarn
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Build TypeScript
        run: just build

      - name: Configure AWS Credentials
        uses: ./.github/actions/configure-aws
        with:
          role-to-assume: ${{ secrets.AWS_OIDC_ROLE }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Synthesize & Determine Stack Names
        id: synth
        env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          GH_OIDC_ROLE_ARN: ${{ secrets.GH_OIDC_ROLE_ARN }}
          ADMIN_ROLE_ARN: ${{ secrets.ADMIN_ROLE_ARN }}
        run: just ci-synth kubernetes ${{ inputs.cdk-environment }}

  deploy-cluster:
    name: Deploy EKS Cluster
    needs: [setup]
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: ${{ needs.setup.outputs.eks-cluster }}
      project: kubernetes
      environment: ${{ inputs.environment }}
      aws-region: ${{ vars.AWS_REGION || 'eu-west-1' }}
      require-approval: ${{ inputs.require-approval }}
    secrets: inherit

  deploy-system-ng:
    name: Deploy EKS System Node Group
    needs: [setup, deploy-cluster]
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: ${{ needs.setup.outputs.eks-system-ng }}
      project: kubernetes
      environment: ${{ inputs.environment }}
      aws-region: ${{ vars.AWS_REGION || 'eu-west-1' }}
      require-approval: ${{ inputs.require-approval }}
    secrets: inherit

  deploy-pod-identity:
    name: Deploy EKS Pod Identity
    needs: [setup, deploy-system-ng]
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: ${{ needs.setup.outputs.eks-pod-identity }}
      project: kubernetes
      environment: ${{ inputs.environment }}
      aws-region: ${{ vars.AWS_REGION || 'eu-west-1' }}
      require-approval: ${{ inputs.require-approval }}
    secrets: inherit

  deploy-addons:
    name: Deploy EKS Addons (Helm)
    needs: [setup, deploy-pod-identity]
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: ${{ needs.setup.outputs.eks-addons }}
      project: kubernetes
      environment: ${{ inputs.environment }}
      aws-region: ${{ vars.AWS_REGION || 'eu-west-1' }}
      require-approval: ${{ inputs.require-approval }}
    secrets: inherit

  deploy-karpenter:
    name: Deploy EKS Karpenter (SQS + NodePool)
    needs: [setup, deploy-addons]
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: ${{ needs.setup.outputs.eks-karpenter }}
      project: kubernetes
      environment: ${{ inputs.environment }}
      aws-region: ${{ vars.AWS_REGION || 'eu-west-1' }}
      require-approval: ${{ inputs.require-approval }}
    secrets: inherit

  deploy-access:
    name: Deploy EKS Access (Access Entries)
    needs: [setup, deploy-cluster]
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: ${{ needs.setup.outputs.eks-access }}
      project: kubernetes
      environment: ${{ inputs.environment }}
      aws-region: ${{ vars.AWS_REGION || 'eu-west-1' }}
      require-approval: ${{ inputs.require-approval }}
    secrets: inherit

  summary:
    name: EKS Deploy Summary
    needs:
      - deploy-cluster
      - deploy-system-ng
      - deploy-pod-identity
      - deploy-addons
      - deploy-karpenter
      - deploy-access
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Aggregate status
        env:
          STATUSES: ${{ toJSON(needs) }}
        run: |
          echo "$STATUSES" | jq -r 'to_entries[] | "\(.key): \(.value.result)"'
          if echo "$STATUSES" | jq -e 'to_entries | any(.value.result == "failure" or .value.result == "cancelled")' > /dev/null; then
            echo "FAILED"; exit 1
          fi
          echo "SUCCESS"
```

- [ ] **Step 2: Lint the YAML**

```bash
yamllint -d "{rules: {line-length: disable, document-start: disable}}" .github/workflows/_deploy-eks.yml
```

If `yamllint` is not installed in your shell, skip this step — actionlint catches schema bugs in CI.

- [ ] **Step 3: actionlint**

```bash
actionlint .github/workflows/_deploy-eks.yml || echo "actionlint not installed locally — CI will run it"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/_deploy-eks.yml
git commit -m "ci(eks): add reusable _deploy-eks.yml workflow"
```

---

## Task 3: Per-env trigger workflows (deploy)

**Files:**
- Create: `.github/workflows/deploy-eks-development.yml`
- Create: `.github/workflows/deploy-eks-staging.yml`
- Create: `.github/workflows/deploy-eks-production.yml`

- [ ] **Step 1: `deploy-eks-development.yml`**

Triggers: `workflow_dispatch` AND `workflow_run` after `Deploy K8s to Development` succeeds. (Don't trigger on `Deploy Shared` directly — EKS depends on `Base-development` which is part of the K8s project, so chain after K8s.)

```yaml
# @format
# Deploy EKS to Development.
# Trigger: workflow_dispatch | workflow_run [Deploy K8s (Dev) success].
# Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.2

name: Deploy EKS to Development

on:
  workflow_dispatch:
  workflow_run:
    workflows: ["Deploy K8s to Development"]
    types: [completed]
    branches: [main]

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-eks-development
  cancel-in-progress: false

jobs:
  gate:
    name: Check upstream
    runs-on: ubuntu-latest
    outputs:
      ok: ${{ steps.check.outputs.ok }}
    steps:
      - id: check
        run: |
          if [[ "${{ github.event_name }}" == "workflow_run" ]]; then
            CONCLUSION="${{ github.event.workflow_run.conclusion }}"
            if [[ "$CONCLUSION" != "success" ]]; then
              echo "ok=false" >> "$GITHUB_OUTPUT"
              echo "Upstream concluded: $CONCLUSION — skipping EKS deploy."
            else
              echo "ok=true" >> "$GITHUB_OUTPUT"
            fi
          else
            echo "ok=true" >> "$GITHUB_OUTPUT"
          fi

  deploy:
    name: Deploy
    needs: [gate]
    if: needs.gate.outputs.ok == 'true'
    uses: ./.github/workflows/_deploy-eks.yml
    with:
      environment: development
      cdk-environment: development
      require-approval: never
    secrets: inherit
```

- [ ] **Step 2: `deploy-eks-staging.yml`**

Manual only — no `workflow_run`. The `environment: staging` GitHub Environment must be configured with the same OIDC role and `AWS_ACCOUNT_ID` `vars` as the kubeadm pipeline, so this is purely a workflow file:

```yaml
# @format
# Deploy EKS to Staging — manual only.
# Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.2

name: Deploy EKS to Staging

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-eks-staging
  cancel-in-progress: false

jobs:
  deploy:
    name: Deploy
    uses: ./.github/workflows/_deploy-eks.yml
    with:
      environment: staging
      cdk-environment: staging
      require-approval: never
    secrets: inherit
```

- [ ] **Step 3: `deploy-eks-production.yml`**

Same as staging but `environment: production`. The GitHub Environment "production" should have a required reviewer rule already (this is org configuration, not workflow YAML).

```yaml
# @format
# Deploy EKS to Production — manual only, gated by GH Environment approval.
# Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.2

name: Deploy EKS to Production

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-eks-production
  cancel-in-progress: false

jobs:
  deploy:
    name: Deploy
    uses: ./.github/workflows/_deploy-eks.yml
    with:
      environment: production
      cdk-environment: production
      require-approval: never
    secrets: inherit
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-eks-development.yml \
        .github/workflows/deploy-eks-staging.yml \
        .github/workflows/deploy-eks-production.yml
git commit -m "ci(eks): add per-env deploy triggers (dev workflow_run, staging+prod manual)"
```

---

## Task 4: Reusable `_destroy-eks.yml`

**Files:**
- Create: `.github/workflows/_destroy-eks.yml`

Reverse dependency order: Karpenter → Addons → PodIdentity → SystemNg → Access → Cluster. The Karpenter destroy job must drain workload pods first; for V1 dev, accept that any pods on Karpenter nodes are killed when the NodePool is destroyed (no workloads land on EKS yet — that's Plan 4).

- [ ] **Step 1: Create the file**

```yaml
# @format
# Reusable EKS destroy — reverse dependency order.
# Caller: destroy-eks-{development,staging,production}.yml.
# Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.2

name: Destroy EKS (Reusable)

on:
  workflow_call:
    inputs:
      environment:
        required: true
        type: string
      cdk-environment:
        required: true
        type: string
    secrets:
      AWS_OIDC_ROLE:
        required: true

env:
  NODE_VERSION: "22"
  AWS_REGION: ${{ vars.AWS_REGION || 'eu-west-1' }}

jobs:
  setup:
    name: Synthesize stack names
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest
    timeout-minutes: 15
    environment: ${{ inputs.environment }}
    outputs:
      eks-cluster: ${{ steps.synth.outputs.eksCluster }}
      eks-system-ng: ${{ steps.synth.outputs.eksSystemNg }}
      eks-pod-identity: ${{ steps.synth.outputs.eksPodIdentity }}
      eks-addons: ${{ steps.synth.outputs.eksAddons }}
      eks-karpenter: ${{ steps.synth.outputs.eksKarpenter }}
      eks-access: ${{ steps.synth.outputs.eksAccess }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-node-yarn
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - run: just build
      - uses: ./.github/actions/configure-aws
        with:
          role-to-assume: ${{ secrets.AWS_OIDC_ROLE }}
          aws-region: ${{ env.AWS_REGION }}
      - id: synth
        env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
        run: just ci-synth kubernetes ${{ inputs.cdk-environment }}

  destroy-karpenter:
    needs: [setup]
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-node-yarn
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - run: just build
      - uses: ./.github/actions/configure-aws
        with:
          role-to-assume: ${{ secrets.AWS_OIDC_ROLE }}
          aws-region: ${{ env.AWS_REGION }}
      - env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          STACK: ${{ needs.setup.outputs.eks-karpenter }}
        run: npx cdk destroy --force "$STACK" -c project=kubernetes -c environment=${{ inputs.cdk-environment }}

  # Repeat the same shape for: addons, pod-identity, system-ng, access, cluster.
  # Each `needs:` the previous + setup. Cluster destroys last because every other
  # stack imports it; access can run in parallel with addons but for simplicity
  # we serialize the chain.

  destroy-addons:
    needs: [setup, destroy-karpenter]
    runs-on: ubuntu-latest
    container: { image: "ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest" }
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-node-yarn
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - run: just build
      - uses: ./.github/actions/configure-aws
        with: { role-to-assume: "${{ secrets.AWS_OIDC_ROLE }}", aws-region: "${{ env.AWS_REGION }}" }
      - env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          STACK: ${{ needs.setup.outputs.eks-addons }}
        run: npx cdk destroy --force "$STACK" -c project=kubernetes -c environment=${{ inputs.cdk-environment }}

  destroy-pod-identity:
    needs: [setup, destroy-addons]
    runs-on: ubuntu-latest
    container: { image: "ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest" }
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-node-yarn
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - run: just build
      - uses: ./.github/actions/configure-aws
        with: { role-to-assume: "${{ secrets.AWS_OIDC_ROLE }}", aws-region: "${{ env.AWS_REGION }}" }
      - env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          STACK: ${{ needs.setup.outputs.eks-pod-identity }}
        run: npx cdk destroy --force "$STACK" -c project=kubernetes -c environment=${{ inputs.cdk-environment }}

  destroy-system-ng:
    needs: [setup, destroy-pod-identity]
    runs-on: ubuntu-latest
    container: { image: "ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest" }
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-node-yarn
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - run: just build
      - uses: ./.github/actions/configure-aws
        with: { role-to-assume: "${{ secrets.AWS_OIDC_ROLE }}", aws-region: "${{ env.AWS_REGION }}" }
      - env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          STACK: ${{ needs.setup.outputs.eks-system-ng }}
        run: npx cdk destroy --force "$STACK" -c project=kubernetes -c environment=${{ inputs.cdk-environment }}

  destroy-access:
    needs: [setup, destroy-system-ng]
    runs-on: ubuntu-latest
    container: { image: "ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest" }
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-node-yarn
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - run: just build
      - uses: ./.github/actions/configure-aws
        with: { role-to-assume: "${{ secrets.AWS_OIDC_ROLE }}", aws-region: "${{ env.AWS_REGION }}" }
      - env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          STACK: ${{ needs.setup.outputs.eks-access }}
        run: npx cdk destroy --force "$STACK" -c project=kubernetes -c environment=${{ inputs.cdk-environment }}

  destroy-cluster:
    needs: [setup, destroy-access]
    runs-on: ubuntu-latest
    container: { image: "ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest" }
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: ./.github/actions/setup-node-yarn
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - run: just build
      - uses: ./.github/actions/configure-aws
        with: { role-to-assume: "${{ secrets.AWS_OIDC_ROLE }}", aws-region: "${{ env.AWS_REGION }}" }
      - env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          STACK: ${{ needs.setup.outputs.eks-cluster }}
        run: npx cdk destroy --force "$STACK" -c project=kubernetes -c environment=${{ inputs.cdk-environment }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/_destroy-eks.yml
git commit -m "ci(eks): add reusable _destroy-eks.yml workflow"
```

---

## Task 5: Per-env destroy triggers

**Files:**
- Create: `.github/workflows/destroy-eks-development.yml`
- Create: `.github/workflows/destroy-eks-staging.yml`
- Create: `.github/workflows/destroy-eks-production.yml`

All three: `workflow_dispatch` only. Production GitHub Environment supplies the approval gate.

- [ ] **Step 1: All three files (use the same shape, vary `environment:`)**

```yaml
# @format
# Destroy EKS — manual only. Use only when you want to delete the EKS cluster
# and its 6 stacks. Reversible via deploy-eks-<env> workflow.
# Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.2

name: Destroy EKS in <ENV>

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: destroy-eks-<env>
  cancel-in-progress: false

jobs:
  destroy:
    name: Destroy
    uses: ./.github/workflows/_destroy-eks.yml
    with:
      environment: <env>
      cdk-environment: <env>
    secrets: inherit
```

Replace `<env>` / `<ENV>` per file:
- `destroy-eks-development.yml`: `<env>=development`, `<ENV>=Development`
- `destroy-eks-staging.yml`: `<env>=staging`, `<ENV>=Staging`
- `destroy-eks-production.yml`: `<env>=production`, `<ENV>=Production`

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/destroy-eks-*.yml
git commit -m "ci(eks): add per-env destroy triggers (manual only)"
```

---

## Task 6: actionlint sweep + dry-run

**Files:** none (verification only)

- [ ] **Step 1: Run actionlint locally if installed**

```bash
actionlint .github/workflows/_deploy-eks.yml \
           .github/workflows/_destroy-eks.yml \
           .github/workflows/deploy-eks-development.yml \
           .github/workflows/deploy-eks-staging.yml \
           .github/workflows/deploy-eks-production.yml \
           .github/workflows/destroy-eks-development.yml \
           .github/workflows/destroy-eks-staging.yml \
           .github/workflows/destroy-eks-production.yml
```

Expected: zero issues. If `actionlint` is not on PATH, skip — CI will run it on push.

- [ ] **Step 2: Push to a feature branch and confirm GitHub parses without errors**

This is a manual step — push the branch and check the Actions tab for "Workflow failed to parse" warnings. Do not merge to `main` until clean.

```bash
git push origin develop:feat/eks-gh-workflows
```

Then on GitHub: Actions tab → confirm both `Deploy EKS to Development` and `Deploy EKS to Staging` appear in the workflow list. Do NOT trigger them yet.

- [ ] **Step 3: No commit — verification only**

---

## Task 7: README pointer + spec status

**Files:**
- Modify: `.github/workflows/README.md` (add EKS workflows to the index)
- Modify: `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 9.2

- [ ] **Step 1: Append to README**

```bash
grep -n "deploy-kubernetes\|deploy-shared" .github/workflows/README.md | head
```

Locate the workflow table. Add 8 rows for the new files (4 deploy + 4 destroy if you count the reusables, otherwise 6 triggers + 2 reusables). Match the existing column convention.

- [ ] **Step 2: Mark spec § 9.2 done**

Append to § 9.2:

```markdown

**Status:** ✅ Done (2026-05-05) — see Plan 3 (`docs/superpowers/plans/2026-05-05-eks-migration-03-gh-workflows.md`). 8 workflows: 2 reusables (`_deploy-eks.yml`, `_destroy-eks.yml`) + 3 per-env deploy triggers + 3 per-env destroy triggers. Dev auto-triggers on `Deploy K8s to Development` success; staging + production are `workflow_dispatch` only with GitHub Environment approval gates.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/README.md \
        docs/superpowers/specs/2026-05-05-eks-migration-design.md
# `docs/` is gitignored — use -f.
git add -f docs/superpowers/specs/2026-05-05-eks-migration-design.md
git commit -m "docs(eks): index EKS workflows + mark Plan 3 (GH workflows) complete"
```

---

## Acceptance Criteria — Plan 3 Done When

1. `infra/scripts/shared/stacks.ts` registers all 6 EKS stack ids. `cdk-synthesize` emits matching `GITHUB_OUTPUT` keys.
2. `_deploy-eks.yml` exists, parses cleanly via actionlint, and chains 6 deploy jobs in dependency order with the correct `needs:` graph.
3. `deploy-eks-development.yml` triggers automatically when `Deploy K8s to Development` succeeds on `main`.
4. `deploy-eks-staging.yml` and `deploy-eks-production.yml` are `workflow_dispatch` only and rely on GitHub Environment approval gates.
5. `_destroy-eks.yml` reverses the dependency order (Karpenter → Addons → PodId → SystemNg → Access → Cluster).
6. All three `destroy-eks-<env>.yml` files are `workflow_dispatch` only.
7. GitHub Actions UI shows all 8 new workflows after push to `main` (or feature branch).
8. Spec § 9.2 marked Done.

---

## Out of Scope (later plans)

- ArgoCD bootstrap on EKS / `kubernetes-bootstrap` repo restructure — Plan 4.
- CloudFront origin failover + smoke tests + cutover runbook — Plan 5.
- `Deprecated_*` rename of kubeadm-era stacks + workflows — Plan 6.

---

## Risks Specific to This Plan

| Risk | Mitigation |
|---|---|
| `_deploy-stack.yml` schema does not match what `_deploy-eks.yml` passes | Read `_deploy-stack.yml` `inputs:` block before authoring; test with `actionlint`. |
| GitHub Environment "staging" / "production" lacks `vars.AWS_ACCOUNT_ID` for the relevant account | Pre-flight: in the GH UI, confirm the env has `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_OIDC_ROLE` set. Document this as a prerequisite in the trigger workflow comment block. |
| `workflow_run` chain triggers in a tight loop if `Deploy K8s to Development` runs frequently | `concurrency:` group prevents overlap; `gate` step skips if upstream conclusion ≠ `success`. |
| Destroy chain hangs because EKS cluster has live workloads | V1 dev has no workloads on EKS yet (Plan 4 introduces them). For staging/production destroys, add an explicit `kubectl delete --all -A` step before the `destroy-karpenter` job — out of scope for V1. |
| `_destroy-eks.yml` is verbose — same pattern repeated 6 times | Acceptable: GH Actions does not support reusable jobs across stacks the way `_deploy-stack.yml` does for deploys (no per-stack reusable destroy exists yet). Building one is a Plan 6 cleanup task. |
