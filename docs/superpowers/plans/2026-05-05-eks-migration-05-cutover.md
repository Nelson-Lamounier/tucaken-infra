# EKS Migration — Plan 5 / 6: Workload Migration + Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every workload from the kubeadm cluster onto EKS, expose them through a Traefik-on-NLB ingress (V1 form), then flip CloudFront's origin group from kubeadm NLB to EKS NLB. After 7 days clean, tear down the kubeadm cluster.

**Architecture:** CloudFront origin failover is the cutover mechanism — primary-with-automatic-failover, NOT active-active. The flip is a primary swap in the origin-group config; rollback is the inverse swap. Application-correctness regressions are caught by direct smoke tests against the EKS NLB hostname (CloudFront only fails over on 5xx) plus a CloudWatch Synthetics canary.

**Tech Stack:** ArgoCD v2.x, Helm 3, Traefik v3 (Deployment + NLB IP-mode), AWS Load Balancer Controller, CloudFront origin failover, CloudWatch Synthetics, EKS Pod Identity, cert-manager + Let's Encrypt (V1 retains).

**Parent spec:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md` §§ 5.2, 6, 8.

**Repos touched:**
- `kubernetes-bootstrap` — `argocd-apps/eks/development/` (workload Apps), `charts/` (values overlays).
- `cdk-monitoring` — `EdgeStack` (origin group update), `EksAddonsStack` (Synthetics canary).

**Dependencies:**
- Plan 1 (account-id consolidation) ✅
- Plan 2 (6 EKS stacks deployed in dev) ✅
- Plan 3 (GH workflows) ✅
- Plan 4 (ArgoCD root app on EKS) ✅
- Live: EKS cluster ACTIVE, ArgoCD synced, Karpenter provisioning workload nodes.

---

## File Structure

**Files to create (in `kubernetes-bootstrap`):**

| Path | Purpose |
|---|---|
| `argocd-apps/eks/development/traefik.yaml` | Traefik v3 (Deployment + NLB IP-mode), single replica per AZ via topology spread |
| `argocd-apps/eks/development/cert-manager.yaml` | cert-manager + Let's Encrypt issuer (V1 keeps Let's Encrypt; ACM is V2) |
| `argocd-apps/eks/development/external-secrets-stores.yaml` | ClusterSecretStore for ESO → AWS SSM/Secrets Manager |
| `argocd-apps/eks/development/admin-api.yaml` | admin-api workload App + values-eks-development.yaml overlay |
| `argocd-apps/eks/development/public-api.yaml` | public-api workload App |
| `argocd-apps/eks/development/nextjs.yaml` | Next.js portfolio frontend |
| `argocd-apps/eks/development/tucaken-app.yaml` | Tucaken SaaS frontend |
| `argocd-apps/eks/development/article-pipeline.yaml` | Article generation Job |
| `argocd-apps/eks/development/ingestion.yaml` | RSS ingestion Job |
| `argocd-apps/eks/development/job-strategist.yaml` | Job-strategist pipeline |
| `argocd-apps/eks/development/resume-import.yaml` | Resume import processor |
| `argocd-apps/eks/development/platform-rds.yaml` | PgBouncer connection pooler |
| `argocd-apps/eks/development/monitoring.yaml` | Prometheus / Grafana / Loki / Tempo (fresh PVCs per spec § 8) |
| `charts/<workload>/values-eks-development.yaml` | EKS-specific overlay per workload (Pod ID SA refs, system→Karpenter NodePool selector, tolerations, ingress class) |

**Files to create (in `cdk-monitoring`):**

| Path | Purpose |
|---|---|
| `infra/lib/constructs/observability/synthetics-canary.ts` | CloudWatch Synthetics canary construct (5-min schedule, hits CloudFront URL) |
| `infra/tests/unit/constructs/observability/synthetics-canary.test.ts` | Unit test |

**Files to modify (in `cdk-monitoring`):**

| Path | Change |
|---|---|
| `infra/lib/stacks/kubernetes/edge-stack.ts` | Add EKS NLB as secondary origin; cutover task swaps primary/secondary |
| `infra/lib/stacks/kubernetes/observability-stack.ts` | Wire the Synthetics canary; alarm on consecutive failures |

---

## Task 1: ESO ClusterSecretStore (foundation for every workload)

**Files (kubernetes-bootstrap):**
- Create: `argocd-apps/eks/development/external-secrets-stores.yaml`

ESO is already installed by `EksAddonsStack`. We need a `ClusterSecretStore` that points it at AWS SSM (and Secrets Manager). Pod Identity supplies credentials.

- [ ] **Step 1: Author the manifest**

```yaml
# @format
# ESO ClusterSecretStore — AWS SSM Parameter Store + Secrets Manager.
# Each workload's ExternalSecret references storeRef: aws-ssm.
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-ssm
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  provider:
    aws:
      service: ParameterStore
      region: eu-west-1
      # Pod Identity supplies creds — the controller's SA in
      # external-secrets/external-secrets is bound by EksPodIdentityStack.
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  provider:
    aws:
      service: SecretsManager
      region: eu-west-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

- [ ] **Step 2: Wrap as ArgoCD Application**

Add a thin Application manifest at the same path (combine with the above
in one file, separated by `---`):

```yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-secrets-stores-eks-development
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: default
  source:
    repoURL: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
    targetRevision: main
    path: argocd-apps/eks/development/external-secrets-stores
  destination:
    server: https://kubernetes.default.svc
    namespace: external-secrets
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [ServerSideApply=true]
```

- [ ] **Step 3: Verify after first sync**

```bash
kubectl --context eks-dev get clustersecretstore
# Expected: aws-ssm and aws-secretsmanager, both Ready=true
```

- [ ] **Step 4: Commit + push**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git checkout -b feat/eks-workload-migration
git add argocd-apps/eks/development/external-secrets-stores.yaml
git commit -m "feat(eks): ESO ClusterSecretStore for SSM + SecretsManager"
```

---

## Task 2: cert-manager + Let's Encrypt issuer

**Files (kubernetes-bootstrap):**
- Create: `argocd-apps/eks/development/cert-manager.yaml`

V1 retains Let's Encrypt for TLS (V2 swaps to ACM). cert-manager runs as a
Helm release with a system-MNG toleration; the `ClusterIssuer` is the
HTTP-01 issuer via Traefik, matching the kubeadm setup.

- [ ] **Step 1: Author**

```yaml
# @format
# cert-manager + Let's Encrypt issuer for EKS V1.
# V2 (deferred) replaces with ACM-managed certs on ALB.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager-eks-development
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  project: default
  source:
    chart: cert-manager
    repoURL: https://charts.jetstack.io
    targetRevision: v1.16.1
    helm:
      valuesObject:
        installCRDs: true
        tolerations:
          - key: dedicated
            value: system
            effect: NoSchedule
        webhook:
          tolerations:
            - key: dedicated
              value: system
              effect: NoSchedule
        cainjector:
          tolerations:
            - key: dedicated
              value: system
              effect: NoSchedule
        startupapicheck:
          tolerations:
            - key: dedicated
              value: system
              effect: NoSchedule
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
---
# ClusterIssuer applied separately (depends on cert-manager CRDs being live)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager-config-eks-development
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  project: default
  source:
    repoURL: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
    targetRevision: main
    path: charts/cert-manager-config-eks  # new chart with ClusterIssuer + ClusterRole
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated: { prune: true, selfHeal: true }
```

- [ ] **Step 2: Create the `charts/cert-manager-config-eks/` chart**

Copy the existing `charts/cert-manager-config/` chart from the kubeadm
tree and adjust:
- `ingressClass` should be `traefik` (matches V1 ingress; same as kubeadm).
- `email` stays the same (Let's Encrypt account email).
- Solver config uses `http01.ingress.class: traefik`.

```bash
cp -r charts/cert-manager-config charts/cert-manager-config-eks
# Edit charts/cert-manager-config-eks/clusterissuer.yaml to confirm:
#   - solvers[0].http01.ingress.class: traefik
#   - acme.server: https://acme-v02.api.letsencrypt.org/directory
git add charts/cert-manager-config-eks/
```

- [ ] **Step 3: Commit**

```bash
git add argocd-apps/eks/development/cert-manager.yaml
git commit -m "feat(eks): cert-manager + LE ClusterIssuer for V1 ingress"
```

---

## Task 3: Traefik v3 (Deployment + NLB IP-mode)

**Files (kubernetes-bootstrap):**
- Create: `argocd-apps/eks/development/traefik.yaml`
- Create: `charts/traefik-eks/` (new chart based on existing `charts/traefik/` adjusted for EKS)

V1 ingress: Traefik as `Deployment` (3 replicas, anti-affinity), Service of `type: LoadBalancer` annotated for ALB controller to provision an NLB in IP target mode. Per spec § 5.2, IP target type is critical for Karpenter — NodePort-mode targets churn with Karpenter node lifecycle.

- [ ] **Step 1: Copy + adapt the chart**

```bash
cp -r charts/traefik charts/traefik-eks
```

Edit `charts/traefik-eks/values.yaml`:
- `deployment.kind: Deployment` (was `DaemonSet`).
- `deployment.replicas: 3`.
- `service.type: LoadBalancer`.
- `service.annotations` — set:
  - `service.beta.kubernetes.io/aws-load-balancer-type: external`
  - `service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip`
  - `service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing`
  - `service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"`
- `service.spec.externalTrafficPolicy: Cluster` (no longer needs Local since target-type is `ip`).
- Remove `hostNetwork: true` and `hostPort:` blocks (kubeadm-only).
- Remove control-plane node toleration; keep system toleration if any infra reason — but Traefik should land on Karpenter workload nodes, NOT system MNG. So remove tolerations entirely.
- Add anti-affinity:
  ```yaml
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels: { app.kubernetes.io/name: traefik }
            topologyKey: topology.kubernetes.io/zone
  ```
- IngressRoute CRDs unchanged from kubeadm — workload Apps reference them as before.

- [ ] **Step 2: Author the ArgoCD Application**

```yaml
# @format
# Traefik v3 — V1 EKS ingress (Deployment + NLB IP-mode).
# V2 (deferred): replaced by ALB Ingress Controller + ACM.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik-eks-development
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  project: default
  source:
    repoURL: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
    targetRevision: main
    path: charts/traefik-eks
  destination:
    server: https://kubernetes.default.svc
    namespace: traefik
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```

- [ ] **Step 3: Wait for NLB provisioning**

After Traefik syncs, wait for ALB controller to provision the NLB:

```bash
kubectl --context eks-dev -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
# Expected: <random>.elb.eu-west-1.amazonaws.com
```

Save the hostname for Task 6 (CloudFront origin update).

- [ ] **Step 4: Commit**

```bash
git add charts/traefik-eks/ argocd-apps/eks/development/traefik.yaml
git commit -m "feat(eks): Traefik v3 Deployment + NLB IP-mode"
```

---

## Task 4: Workload migration (one App per workload)

**Files (kubernetes-bootstrap):**
- Create: `argocd-apps/eks/development/<workload>.yaml` for each of: `admin-api`, `public-api`, `nextjs`, `tucaken-app`, `article-pipeline`, `ingestion`, `job-strategist`, `resume-import`, `platform-rds`.
- Create: `charts/<workload>/values-eks-development.yaml` — overlay file per chart.

Each Application:
- `metadata.name`: `<workload>-eks-development` (avoid collision with kubeadm-cluster app names).
- `spec.source.path`: same chart directory the kubeadm cluster uses (chart code is shared between clusters).
- `spec.source.helm.valueFiles`: `[values.yaml, values-development.yaml, values-eks-development.yaml]`.
- `spec.destination.namespace`: same namespace as kubeadm.

Each EKS overlay (`values-eks-development.yaml`):
- Drop `nodeSelector` for kubeadm pool labels (e.g. `pool: general`); EKS uses Karpenter NodePool selectors via `requirements`.
- Drop legacy IAM annotations on ServiceAccount (kubeadm relied on EC2 instance profile); Pod Identity association already maps the SA at the EKS control plane.
- Set `tolerations: []` (workloads land on Karpenter nodes, no taint).
- If chart sets `nodeSelector: {pool: monitoring}` or similar, replace with empty map (`{}`) and rely on Karpenter requirements + topology spread.

- [ ] **Step 1: Per-workload checklist (apply for each of the 9 workloads)**

For workload `admin-api`:

```yaml
# argocd-apps/eks/development/admin-api.yaml
# @format
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: admin-api-eks-development
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "10"
  finalizers: [resources-finalizer.argocd.argoproj.io]
spec:
  project: default
  source:
    repoURL: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
    targetRevision: main
    path: charts/admin-api/chart
    helm:
      valueFiles:
        - values.yaml
        - admin-api-values.yaml
        - admin-api-values-eks-development.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: admin-api
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```

```yaml
# charts/admin-api/admin-api-values-eks-development.yaml
# @format
nodeSelector: {}
tolerations: []
serviceAccount:
  # Pod Identity Association is created in EksPodIdentityStack — no
  # IRSA annotation needed.
  annotations: {}
```

Do this for all 9 workloads. The exact overlay differs per chart's
existing structure — match the chart's `values.yaml` keys.

- [ ] **Step 2: Smoke-test each workload after sync**

```bash
kubectl --context eks-dev -n <namespace> get pods
# Expected: pods Running, Karpenter has provisioned a workload node.
kubectl --context eks-dev -n <namespace> logs deploy/<workload> | tail
# Expected: app-level startup logs, no Pod Identity / IMDS errors.
```

For HTTP-serving workloads, port-forward and curl:

```bash
kubectl --context eks-dev -n admin-api port-forward svc/admin-api 8080:80 &
curl -s http://localhost:8080/healthz
```

- [ ] **Step 3: Commit per workload (one commit each, easier rollback)**

```bash
git add argocd-apps/eks/development/admin-api.yaml \
        charts/admin-api/admin-api-values-eks-development.yaml
git commit -m "feat(eks): admin-api workload App for EKS dev"
```

---

## Task 5: Monitoring stack (fresh PVCs)

**Files (kubernetes-bootstrap):**
- Create: `argocd-apps/eks/development/monitoring.yaml`
- Create: `charts/monitoring/values-eks-development.yaml`

Per spec § 8: cluster-local TSDB (Prometheus, Loki, Tempo) is treated as
ephemeral. Fresh PVCs on EKS; dashboards-as-code in git carry over
unchanged.

- [ ] **Step 1: ArgoCD App**

```yaml
# @format
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: monitoring-eks-development
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "20"  # after workload apps
spec:
  project: default
  source:
    repoURL: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
    targetRevision: main
    path: charts/monitoring
    helm:
      valueFiles:
        - values.yaml
        - values-eks-development.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```

- [ ] **Step 2: Overlay**

`charts/monitoring/values-eks-development.yaml` — empty `nodeSelector`,
empty `tolerations`, default storage class (`gp3` from EBS CSI).

- [ ] **Step 3: Verify dashboards reachable**

After Grafana pods Ready:

```bash
kubectl --context eks-dev -n monitoring port-forward svc/grafana 3000:80 &
open http://localhost:3000
# Expected: every dashboard loads with current data (15-min ramp).
```

- [ ] **Step 4: Commit**

```bash
git add argocd-apps/eks/development/monitoring.yaml \
        charts/monitoring/values-eks-development.yaml
git commit -m "feat(eks): monitoring stack with fresh PVCs"
```

---

## Task 6: CloudFront origin group — EKS NLB as secondary

**Files (cdk-monitoring):**
- Modify: `infra/lib/stacks/kubernetes/edge-stack.ts`

Add the EKS NLB as a secondary origin in the existing `OriginGroup`. CloudFront only routes to secondary on 5xx — until the primary swap happens (Task 8), EKS receives zero user traffic.

- [ ] **Step 1: Locate the origin group**

```bash
grep -n "OriginGroup\|primaryOriginId\|FailoverCriteriaStatusCodes" infra/lib/stacks/kubernetes/edge-stack.ts | head
```

- [ ] **Step 2: Add the EKS NLB origin and re-shape the origin group**

```typescript
// Existing: kubeadm NLB origin = primary.
const kubeadmOrigin = new origins.HttpOrigin(props.kubeadmNlbHostname, {
    httpPort: 80,
    httpsPort: 443,
    customHeaders: { 'X-Origin-Secret': props.originSecret },
});

// New: EKS NLB origin (Task 3 hostname).
const eksOrigin = new origins.HttpOrigin(props.eksNlbHostname, {
    httpPort: 80,
    httpsPort: 443,
    customHeaders: { 'X-Origin-Secret': props.originSecret },
});

const originGroup = new origins.OriginGroup({
    primaryOrigin: kubeadmOrigin,
    fallbackOrigin: eksOrigin,
    fallbackStatusCodes: [502, 503, 504],
});
```

The hostname for `eksNlbHostname` is exposed via SSM by Traefik's
LoadBalancer Service — write a one-shot Lambda or a manual SSM put after
Task 3 lands the NLB:

```bash
EKS_NLB=$(kubectl --context eks-dev -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
aws ssm put-parameter --profile dev-account --region eu-west-1 \
  --name /k8s/development/eks/traefik-nlb-hostname \
  --value "$EKS_NLB" --type String --overwrite
```

EdgeStack reads the SSM param at deploy time (existing pattern in
edge-stack.ts):

```typescript
const eksNlbHostname = ssm.StringParameter.valueForStringParameter(
    this, '/k8s/development/eks/traefik-nlb-hostname',
);
```

- [ ] **Step 3: Synth + diff Edge stack**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra
AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
  ENABLE_CDK_NAG=false npx cdk diff Edge-development \
  -c project=kubernetes -c environment=development 2>&1 | tail -30
```

Expected: only origin-group changes; no destructive changes to the
distribution itself.

- [ ] **Step 4: Deploy**

Use the existing `Deploy K8s to Development` workflow OR run:

```bash
AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 AWS_PROFILE=dev-account \
  ENABLE_CDK_NAG=false npx cdk deploy Edge-development \
  -c project=kubernetes -c environment=development --require-approval never
```

- [ ] **Step 5: Smoke test EKS NLB hostname directly (kubeadm still primary)**

```bash
EKS_NLB=$(aws ssm get-parameter --profile dev-account --region eu-west-1 \
  --name /k8s/development/eks/traefik-nlb-hostname --query Parameter.Value --output text)
# For each workload's domain (admin-api, nextjs, etc.):
curl -kv --resolve admin.dev.nelsonlamounier.com:443:$(dig +short $EKS_NLB | head -1) \
  https://admin.dev.nelsonlamounier.com/healthz
# Expected: 200, response from EKS workload (verify body content matches kubeadm).
```

Run this for: every workload health endpoint, the auth flow end-to-end,
the AI-app paths (ingestion, job-strategist, resume-import), the
admin-api blue/green rollout (touch a no-op release), ESO secret
resolution, and EBS PVC mount on a fresh Karpenter node.

- [ ] **Step 6: Commit (cdk-monitoring)**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
git add infra/lib/stacks/kubernetes/edge-stack.ts
git commit -m "feat(edge): add EKS NLB as origin-group fallback (kubeadm still primary)"
```

---

## Task 7: CloudWatch Synthetics canary

**Files (cdk-monitoring):**
- Create: `infra/lib/constructs/observability/synthetics-canary.ts`
- Create: `infra/tests/unit/constructs/observability/synthetics-canary.test.ts`
- Modify: `infra/lib/stacks/kubernetes/observability-stack.ts`

Per spec § 6.3: a CloudWatch Synthetics canary that hits the CloudFront
URL every 5 minutes catches application-level regressions (200-OK with
broken body) that origin failover cannot.

- [ ] **Step 1: TDD red**

```typescript
// infra/tests/unit/constructs/observability/synthetics-canary.test.ts
process.env.AWS_ACCOUNT_ID = '123456789012';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { SyntheticsCanary } from '../../../../lib/constructs/observability/synthetics-canary';

describe('SyntheticsCanary', () => {
    it('should create one canary running every 5 minutes', () => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'S', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        new SyntheticsCanary(stack, 'C', {
            url: 'https://dev.nelsonlamounier.com/healthz',
            name: 'edge-healthz',
        });
        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::Synthetics::Canary', 1);
        t.hasResourceProperties('AWS::Synthetics::Canary', {
            Schedule: { Expression: 'rate(5 minutes)' },
        });
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// infra/lib/constructs/observability/synthetics-canary.ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export interface SyntheticsCanaryProps {
    readonly url: string;
    readonly name: string;
}

export class SyntheticsCanary extends Construct {
    public readonly canary: synthetics.Canary;
    public readonly failureAlarm: cloudwatch.Alarm;

    constructor(scope: Construct, id: string, props: SyntheticsCanaryProps) {
        super(scope, id);

        this.canary = new synthetics.Canary(this, 'Canary', {
            canaryName: props.name,
            schedule: synthetics.Schedule.rate(cdk.Duration.minutes(5)),
            test: synthetics.Test.custom({
                code: synthetics.Code.fromInline(`
                    const synthetics = require('Synthetics');
                    const log = require('SyntheticsLogger');
                    exports.handler = async () => {
                        const page = await synthetics.getPage();
                        const r = await page.goto('${props.url}', { waitUntil: 'domcontentloaded' });
                        if (r.status() !== 200) throw new Error(\`status \${r.status()}\`);
                    };
                `),
                handler: 'index.handler',
            }),
            runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_9_1,
        });
        this.failureAlarm = this.canary.metricFailed().createAlarm(this, 'FailureAlarm', {
            threshold: 2,
            evaluationPeriods: 2,
            datapointsToAlarm: 2,
            alarmDescription: \`Canary \${props.name} failed twice in a row\`,
        });
    }
}
```

- [ ] **Step 3: Wire into ObservabilityStack**

Add a canary instance per critical path (CloudFront URL `/healthz`,
admin-api login flow, public-api). Alarm action: SNS topic that already
goes to `notificationEmail`.

- [ ] **Step 4: Test, deploy, commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra
yarn typecheck && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/constructs/observability/synthetics-canary.test.ts --no-coverage
cd .. && git add infra/lib infra/tests
git commit -m "feat(obs): CloudWatch Synthetics canary on edge URLs"
git push origin develop
```

Deploy via `Deploy K8s to Development` (Observability stack picks up canary).

---

## Task 8: Day 1 — flip primary origin to EKS

**Files (cdk-monitoring):**
- Modify: `infra/lib/stacks/kubernetes/edge-stack.ts` — swap `primaryOrigin` and `fallbackOrigin`.

This is the cutover moment. Pre-flip checklist:

- [ ] All workload Apps green in ArgoCD.
- [ ] Direct smoke tests against EKS NLB (Task 6 Step 5) all passed.
- [ ] CloudWatch Synthetics canary green for ≥30 min.
- [ ] Karpenter has provisioned ≥1 t3.large workload node and pods land cleanly.
- [ ] Grafana dashboards on EKS show the same shape of metrics as kubeadm dashboards.

- [ ] **Step 1: Edit edge-stack.ts**

```typescript
const originGroup = new origins.OriginGroup({
    primaryOrigin: eksOrigin,        // was: kubeadmOrigin
    fallbackOrigin: kubeadmOrigin,   // was: eksOrigin (kept as safety net)
    fallbackStatusCodes: [502, 503, 504],
});
```

- [ ] **Step 2: Diff + deploy**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra
AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 AWS_PROFILE=dev-account \
  ENABLE_CDK_NAG=false npx cdk deploy Edge-development \
  -c project=kubernetes -c environment=development --require-approval never
```

CloudFront origin-group updates are near-instant (no distribution
deployment-time wait).

- [ ] **Step 3: Monitor 30 minutes post-flip**

Watch:
- CloudFront 5xx rate (CloudWatch → CloudFront → Per-Distribution).
- Application metrics (Grafana → admin-api, public-api panels).
- RDS connection pool (PgBouncer dashboard).
- Synthetics canary state.

If 5xx spikes or canary fails: see rollback (Task 10).

- [ ] **Step 4: Commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
git add infra/lib/stacks/kubernetes/edge-stack.ts
git commit -m "feat(edge): cutover - EKS NLB now primary, kubeadm fallback"
git push origin develop
```

---

## Task 9: Day 7 — kubeadm teardown

After 7 days of EKS-as-primary with the canary green and zero rollbacks,
remove the kubeadm origin from the origin group, then tear down the
kubeadm cluster's CDK stacks.

- [ ] **Step 1: Remove kubeadm fallback from origin group**

In edge-stack.ts, simplify back to a single-origin distribution:

```typescript
new cloudfront.Distribution(this, 'Distribution', {
    defaultBehavior: {
        origin: eksOrigin,
        // ... existing behavior settings
    },
    // ... no more origin group
});
```

Deploy.

- [ ] **Step 2: Tear down kubeadm cluster (per spec § 9.2 destroy order)**

Run via `Destroy K8s in Development` workflow OR per stack:

```bash
# Reverse-dependency order:
aws cloudformation delete-stack --stack-name MonitoringPool-development --profile dev-account --region eu-west-1
aws cloudformation delete-stack --stack-name GeneralPool-development --profile dev-account --region eu-west-1
aws cloudformation delete-stack --stack-name AppIam-development --profile dev-account --region eu-west-1
aws cloudformation delete-stack --stack-name ControlPlane-development --profile dev-account --region eu-west-1
# Base stays — VPC is still shared by EKS.
```

- [ ] **Step 3: Confirm zero impact**

Synthetics canary still green. Grafana dashboards unchanged. Verify with
`kubectl --context eks-dev get pods -A` — every workload pod still
running.

- [ ] **Step 4: Commit**

```bash
git add infra/lib/stacks/kubernetes/edge-stack.ts
git commit -m "feat(edge): remove kubeadm fallback after 7d clean window"
```

---

## Task 10: Rollback runbook

**Files (cdk-monitoring):**
- Create: `docs/runbooks/eks-cutover-rollback.md`

If 5xx spikes or canary fails post-cutover:

- [ ] **Step 1: Author rollback runbook**

```markdown
# Runbook — Roll back EKS cutover

## Trigger conditions

Roll back if any of these are true within 30 min of Task 8 deploy:
- CloudFront 5xx rate > 1% sustained for 5 min.
- Synthetics canary fails 3 consecutive runs.
- Any workload reports user-visible errors.

## Steps

1. Edit \`infra/lib/stacks/kubernetes/edge-stack.ts\` — swap primary
   and fallback again (kubeadm becomes primary).
2. \`npx cdk deploy Edge-development -c project=kubernetes -c environment=development --require-approval never\`
3. Wait 5 min for CloudFront edge propagation.
4. Confirm Synthetics canary recovers.
5. Investigate root cause; do not re-cutover until reproduced + fixed.

## Spec

\`docs/superpowers/specs/2026-05-05-eks-migration-design.md\` § 6.2.
```

- [ ] **Step 2: Commit (cdk-monitoring)**

```bash
git add -f docs/runbooks/eks-cutover-rollback.md
git commit -m "docs(runbook): EKS cutover rollback procedure"
```

---

## Task 11: Mark spec § 6 done

**Files:**
- Modify: `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 6

- [ ] **Step 1: Append status block to § 6.2**

```markdown

**Status (V1, dev):** ✅ Done (2026-MM-DD) — see Plan 5 (\`docs/superpowers/plans/2026-05-05-eks-migration-05-cutover.md\`). Workloads migrated, EKS NLB became CloudFront primary on Day 1, Synthetics canary green for 7 days, kubeadm cluster torn down on Day 7. Rollback runbook at \`docs/runbooks/eks-cutover-rollback.md\`.
```

- [ ] **Step 2: Commit**

```bash
git add -f docs/superpowers/specs/2026-05-05-eks-migration-design.md
git commit -m "docs(eks): mark Plan 5 (cutover) complete"
git push origin develop
```

---

## Acceptance Criteria — Plan 5 Done When

1. Every workload runs on EKS with Pod Identity, Karpenter-provisioned nodes, and clean health endpoints.
2. ESO ClusterSecretStore resolves SSM/Secrets Manager via Pod Identity.
3. Traefik on EKS NLB (IP-mode) terminates traffic for every workload domain.
4. CloudWatch Synthetics canary on the CloudFront URL is green for ≥30 min before cutover.
5. CloudFront origin group has EKS NLB as primary; kubeadm fallback held for 7 days.
6. CloudFront 5xx rate post-cutover ≤ pre-cutover baseline +0.1%.
7. After 7 days clean: kubeadm fallback removed, kubeadm CDK stacks destroyed, Synthetics still green.
8. Rollback runbook tested via dry-run revert (not live; just verify the diff).
9. Spec §§ 5.2, 6, 8 marked Done.

---

## Out of Scope (Plan 6)

- `Deprecated_*` rename of remaining kubeadm-era CDK stacks (`ControlPlaneStack`, `GeneralPoolStack`, `MonitoringPoolStack`, `WorkerAsgStack`).
- `_deprecated_kubeadm/` rename of top-level `argocd-apps/*.yaml` tree.
- `sm-a/` bootstrap orchestrator deprecation.

---

## Risks Specific to This Plan

| Risk | Mitigation |
|---|---|
| First Karpenter-provisioned workload node takes longer than 60s; user requests time out | Karpenter consolidation tuning is V2; for cutover, pre-warm with a dummy Pending pod before flipping primary |
| Pod Identity not bound to a workload's SA → app crashes on first AWS API call | Pre-flip smoke test (Task 6 Step 5) hits ESO secret resolution and DynamoDB writes; failures stop the cutover |
| ALB controller Service-mutating webhook briefly unavailable during a Karpenter node churn → workload Service create blocked | Plan 2's webhook namespace exclusion already prevents this for infra namespaces; workload namespaces still in-scope, but Plan 5 introduces no new Service creates after initial sync |
| CloudFront origin failover fires on transient 5xx, masking a real regression for hours before someone notices | Synthetics canary on critical paths catches application-correctness regressions origin failover misses |
| 7-day clean window slips into a weekend; on-call gets paged for cosmetic issues during teardown | Schedule Task 9 (kubeadm teardown) for a weekday morning, not a Friday |
| Grafana dashboards visible but data sparse for 15 min after cutover (Prom scrape interval ramp) | Documented in spec § 8; this is expected, not a regression |
