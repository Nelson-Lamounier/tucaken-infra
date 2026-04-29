# Bootstrap Deadlock Runbook — AWS Cloud Controller Manager

> **Scenario**: ArgoCD and CoreDNS pods are stuck `Pending` after cluster
> bootstrap. All nodes have the `node.cloudprovider.kubernetes.io/uninitialized`
> taint, preventing any pod scheduling.

**Last Updated:** 2026-03-25
**Operator:** Solo — infrastructure owner

---

## Background

Kubernetes nodes started with `--cloud-provider=external` receive the
`node.cloudprovider.kubernetes.io/uninitialized=true:NoSchedule` taint
automatically. Only the AWS Cloud Controller Manager (CCM) removes this
taint after initialising the node's cloud provider metadata.

### The Deadlock

Prior to the permanent fix (step 4b in `control_plane.py`), the CCM was
deployed exclusively via ArgoCD (sync-wave 2). This created a circular
dependency:

```text
kubelet starts with --cloud-provider=external
  → nodes tainted with 'uninitialized'
    → ArgoCD pods can't schedule (taint blocks them)
      → CCM never deployed (it's an ArgoCD Application)
        → taint never removed → deadlock
```

### The Permanent Fix

`control_plane.py` step 4b (`step_install_ccm`) now installs the CCM via
Helm **before** ArgoCD bootstrap, breaking the cycle. ArgoCD adopts the
Helm release on subsequent syncs via the `aws-cloud-controller-manager`
Application (sync-wave 2, `selfHeal: true`).

---

## Diagnosis

### 1. Confirm the Deadlock Symptoms

```bash
# Connect to control plane via SSM
just k8s-tunnel-auto

# Check for Pending pods
kubectl get pods -A --field-selector=status.phase=Pending

# Check for the uninitialized taint
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
# Expected deadlock output: node.cloudprovider.kubernetes.io/uninitialized
```

### 2. Confirm CCM Is Not Running

```bash
kubectl get pods -n kube-system | grep cloud-controller
# Empty output = CCM not deployed

helm list -n kube-system | grep aws-cloud-controller
# Empty output = Helm release not present
```

### 3. Check ArgoCD Status

```bash
kubectl get pods -n argocd
# All pods showing Pending = confirms deadlock
```

---

## Recovery — Manual Fix (from operator workstation)

If the cluster is in the deadlock state — either because the automated
step 4b hasn't been synced to S3 yet, or because a fresh bootstrap ran
before the fix was deployed — apply this manual fix from any machine
with `kubectl` and `helm` access to the cluster.

> **Prerequisite**: Establish a kubectl tunnel to the cluster first:
> `just k8s-tunnel-auto`

### 1. Add the Helm Repository

```bash
helm repo add aws-cloud-controller-manager \
  https://kubernetes.github.io/cloud-provider-aws --force-update
helm repo update
```

### 2. Create Values File and Install CCM

```bash
cat <<'EOF' > /tmp/ccm-values.yaml
args:
  - --v=2
  - --cloud-provider=aws
  - --configure-cloud-routes=false
nodeSelector:
  node-role.kubernetes.io/control-plane: ""
tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule
  - key: node.cloudprovider.kubernetes.io/uninitialized
    value: "true"
    effect: NoSchedule
hostNetworking: true
EOF

helm upgrade --install aws-cloud-controller-manager \
  aws-cloud-controller-manager/aws-cloud-controller-manager \
  --namespace kube-system \
  --values /tmp/ccm-values.yaml \
  --wait --timeout 120s
```

Expected output:

```text
Release "aws-cloud-controller-manager" does not exist. Installing it now.
NAME: aws-cloud-controller-manager
STATUS: deployed
```

### 3. Verify Taint Removal

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
```

Expected: Only `node-role.kubernetes.io/control-plane` taint on the
control plane node. The `uninitialized` taint should be gone from all nodes.

### 4. Verify CCM Pod

```bash
kubectl get pods -n kube-system | grep aws-cloud-controller
# EXPECTED: aws-cloud-controller-manager-xxxxx   1/1   Running
```

### 5. Verify Pods Start Scheduling

```bash
# ArgoCD pods transition from Pending → Running (~30s)
kubectl get pods -n argocd

# CoreDNS should start
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

### 6. Monitor ArgoCD Application Sync

```bash
# Watch as ArgoCD syncs all platform applications
kubectl get applications -n argocd
```

ArgoCD will process all sync waves (0–5). Apps transition through:
`OutOfSync` / `Missing` → `Progressing` → `Synced` / `Healthy`

---

## Recovery — Trigger Automated Fix (preferred)

If the code change (step 4b) is merged **and** the updated
`control_plane.py` has been synced to S3:

### Option A: Re-run the Pipeline

```bash
gh workflow run _deploy-ssm-automation.yml \
  --ref main \
  -f environment=development
```

The pipeline syncs `control_plane.py` to S3, then triggers SSM Automation.
Step 4b installs the CCM and step 7 bootstraps ArgoCD.

### Option B: Re-run Bootstrap on the Node

```bash
# On the control plane (via SSM session):
rm -f /etc/kubernetes/.ccm-installed
python3 /data/k8s-bootstrap/boot/steps/control_plane.py
```

> [!WARNING]
> If the pipeline re-runs **before** the updated `control_plane.py` is
> synced to S3, the node will still have the old bootstrap script and
> step 4b will not exist. In this case, use the manual fix above.

---

## Verification Checklist

```bash
# 1. CCM pod is Running
kubectl get pods -n kube-system | grep aws-cloud-controller
# EXPECTED: aws-cloud-controller-manager-xxxxx   1/1   Running

# 2. No 'uninitialized' taint on any node
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
# EXPECTED: only control-plane NoSchedule taint on the CP node

# 3. ArgoCD pods are Running
kubectl get pods -n argocd
# EXPECTED: all pods 1/1 Running

# 4. CoreDNS is Running
kubectl get pods -n kube-system -l k8s-app=kube-dns
# EXPECTED: 2/2 Running

# 5. No Pending or failing pods across the cluster
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
# EXPECTED: No resources found

# 6. ArgoCD applications syncing
kubectl get applications -n argocd
# EXPECTED: Most apps Synced/Healthy, some Progressing

# 7. Endpoints responding
curl -sk -o /dev/null -w "%{http_code}" https://ops.nelsonlamounier.com/argocd/
# EXPECTED: 200 (or 307 redirect to login) — may take 5–10 min after recovery
```

---

## Real-World Recovery Log — 2026-03-25

This section documents the actual recovery performed on 2026-03-25 and
serves as a reference for future incidents.

### Timeline

| Time (UTC) | Event |
| :--- | :--- |
| ~17:00 (D-1) | Cluster bootstrapped, CCM not installed (old `control_plane.py`) |
| 04:34 | Fix committed: `step_install_ccm()` added to `control_plane.py` |
| 04:45 | `_deploy-ssm-automation.yml` pipeline re-triggered |
| 05:12 | Pipeline complete, but cluster still in deadlock |
| 05:14 | Diagnosis confirmed: CCM absent, taint present on all 4 nodes |
| 05:17 | Manual Helm install from operator workstation |
| 05:17:35 | CCM deployed, taint removed within seconds |
| 05:18 | ArgoCD pods transition to Running, CoreDNS starts |
| 05:19 | ArgoCD syncs 17 applications (monitoring, Traefik, Crossplane, etc.) |
| 05:22 | All pods Running, endpoints returning HTTP 404 (Traefik routing) |
| ~05:30 | Full platform operational |

### Key Observations

1. **S3 sync timing**: The pipeline re-run triggered the bootstrap
   **before** the updated `control_plane.py` was synced to S3. The node
   executed the old script without step 4b.

2. **Taint removal was instant**: Once the CCM DaemonSet pod started
   on the control plane, all 4 nodes had the `uninitialized` taint
   removed within seconds.

3. **Cascade recovery**: Removing the taint caused all blocked pods to
   schedule immediately — ArgoCD, CoreDNS, and then all downstream
   platform apps via ArgoCD sync waves.

4. **ArgoCD adopted the Helm release**: The `aws-cloud-controller-manager`
   ArgoCD Application (sync-wave 2, `selfHeal: true`) detected the
   manually-installed Helm release and reported `Synced` / `Healthy`
   without any conflict.

5. **Endpoint progression**: Endpoints moved from `connection refused` →
   `HTTP 404` → `HTTP 200` as Traefik, then the backend apps, came online.

### Lesson Learned

> [!IMPORTANT]
> When adding new bootstrap steps, ensure the updated script is synced
> to S3 **before** triggering the SSM automation. The pipeline should
> sequence: (1) S3 sync → (2) SSM trigger. If the bootstrap runs from
> a stale script, new steps will not execute.

---

## Recovery Timeline (expected)

| Phase | Duration | Notes |
| :--- | :---: | :--- |
| Diagnose deadlock | 2 min | Confirm Pending pods + taint |
| Install CCM (manual) | 3 min | Helm install + repo add |
| Taint removal | ~5s | CCM processes all nodes instantly |
| ArgoCD starts | 1 min | Pods schedule + containers start |
| Full platform sync | 10 min | ArgoCD syncs all wave 0–5 apps |
| **Total** | **~15 min** | Manual intervention |

---

## Prevention

This deadlock is prevented by `step_install_ccm()` in `control_plane.py`
(step 4b), which installs the CCM via Helm before ArgoCD bootstrap.

The step is **idempotent** — guarded by the marker file
`/etc/kubernetes/.ccm-installed`. On re-runs, it skips if the CCM is
already installed.

## Source Files

- `kubernetes-app/k8s-bootstrap/boot/steps/control_plane.py` — Bootstrap sequence with step 4b (`step_install_ccm`)
- `kubernetes-app/platform/argocd-apps/aws-cloud-controller-manager.yaml` — ArgoCD Application manifest (adopts the Helm release)
- `kubernetes-app/k8s-bootstrap/system/argocd/bootstrap_argocd.py` — ArgoCD bootstrap script (step 7)
- `.github/workflows/_deploy-ssm-automation.yml` — Pipeline that syncs bootstrap scripts and triggers SSM

## Related

- [Self-Healing Platform](../projects/self-healing-platform.md) — canonical entry point: where the CCM deadlock fits in the broader self-healing architecture
- [SSM Bootstrap & Self-Healing Pipeline Integration](../concepts/self-healing-ssm-integration.md) — failure classification, agent tool loop, run_summary.json structure
- [K8s Bootstrap Failure Modes](../troubleshooting/k8s-bootstrap-failure-modes.md) — three SSM Automation failure modes including CCM taint timeout

---

*Commands and paths above are real values from the cdk-monitoring repository.*
