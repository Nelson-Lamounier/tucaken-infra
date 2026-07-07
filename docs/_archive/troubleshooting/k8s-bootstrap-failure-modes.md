---
title: Kubernetes Control Plane Bootstrap Failure Modes
type: troubleshooting
tags: [kubernetes, aws-ssm, self-managed-k8s, calico, cloud-controller-manager, bootstrap]
sources:
  - scripts/local/control-plane-autofix.ts
  - scripts/local/control-plane-troubleshoot.ts
  - docs/runbooks/bootstrap-deadlock-ccm.md
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the self-managed kubeadm control plane, replaced by managed Amazon EKS in the kubeadm to EKS migration ([ADR-0001](../../decisions/0001-self-managed-k8s-vs-eks.md) records the original self-managed rationale; [EKS platform architecture](../../concepts/eks-platform-architecture.md) is the current design). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

The SSM Automation execution that runs `control_plane.py` finishes with
status `Failed`, or completes with `Success` but the control plane node
never reaches `Ready`. One of three distinct failure signatures applies:

1. Calico pods never appear — `kubectl get pods -n calico-system` returns
   empty after 5+ minutes following bootstrap.
2. All pods across the cluster stay `Pending` indefinitely after a clean
   bootstrap or re-bootstrap.
3. A re-run of the bootstrap script silently skips steps that previously
   failed.

## Root cause

Three distinct failure modes are catalogued in `control-plane-autofix.ts`
(lines 81–103):

### Failure 1 — Missing `podSubnet` in kubeadm-config

The Calico operator reads the `podSubnet` field from the `kubeadm-config`
ConfigMap at install time. If the SSM Automation writes the ConfigMap before
the `podSubnet` value is available — or if `kubeadm init` runs without the
`--pod-network-cidr` flag — the field is absent. Calico silently fails to
deploy its node agents because it cannot determine the network CIDR to
configure. No error is returned; the operator simply produces no pods
([`control-plane-autofix.ts:84-88`](../../../scripts/local/control-plane-autofix.ts)).

### Failure 2 — CCM taint not removed on timeout

Kubernetes nodes started with `--cloud-provider=external` receive the taint
`node.cloudprovider.kubernetes.io/uninitialized=true:NoSchedule` automatically.
The AWS Cloud Controller Manager removes this taint after registering the node
with the AWS API. If CCM installation times out or CCM is absent, all pods
remain `Pending` — including ArgoCD, which is required to deploy CCM in the
GitOps model. This is the classic bootstrap deadlock
([`docs/runbooks/bootstrap-deadlock-ccm.md`](../runbooks/bootstrap-deadlock-ccm.md)).

The autofix script detects this pattern when the automation output contains
`CCM installed but taint not removed` or `uninitialized` + `still present`
([`control-plane-autofix.ts:91-96`](../../../scripts/local/control-plane-autofix.ts)).

### Failure 3 — Stale idempotency markers after partial run

The bootstrap script writes marker files after completing each step:
- `/etc/kubernetes/.calico-installed`
- `/etc/kubernetes/.ccm-installed`

A partial bootstrap run — one that started, partially succeeded, and then
failed — leaves these markers in place. A subsequent re-run skips the marked
steps even though they did not fully succeed, producing a cluster that appears
to have bootstrapped but is missing components
([`control-plane-autofix.ts:75-78`](../../../scripts/local/control-plane-autofix.ts)).

## How to diagnose

Run the troubleshooter from any machine with valid AWS credentials:

```bash
yarn tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account
```

The script runs four diagnostic phases and produces a consolidated report
with pass/fail verdicts and root cause analysis
([`scripts/local/control-plane-troubleshoot.ts:1-30`](../../../scripts/local/control-plane-troubleshoot.ts)).

For manual inspection via SSM:

```bash
# Connect to control plane
just k8s-tunnel-auto

# Check podSubnet in kubeadm-config
kubectl get cm kubeadm-config -n kube-system \
  -o jsonpath="{.data.ClusterConfiguration}" | grep podSubnet

# Check marker files
ssh <instance> "ls -la /etc/kubernetes/.calico-installed /etc/kubernetes/.ccm-installed"

# Check for uninitialized taint
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'

# Check Calico pods
kubectl get pods -n calico-system
```

## How to fix

Run the autofix script — it detects the failure mode, applies the
appropriate repair, and re-runs the bootstrap:

```bash
yarn tsx scripts/local/control-plane-autofix.ts \
  --profile dev-account \
  --bucket k8s-development-scripts-<suffix>
```

For each failure mode the script applies:

**Missing podSubnet:** Patches the kubeadm-config ConfigMap via inline
Python (not sed) to add `podSubnet: 192.168.0.0/16`. The patch command is
in `applyRepair()` at
[`control-plane-autofix.ts:405-425`](../../../scripts/local/control-plane-autofix.ts).

**CCM taint / stale markers:** Removes the marker files and re-runs
`control_plane.py` with the full environment from `/etc/kubernetes/bootstrap-env`.
See [`bootstrap-deadlock-ccm.md`](../runbooks/bootstrap-deadlock-ccm.md) for
manual CCM installation if the script is unavailable.

**Dry-run mode** — verify what the script would do without executing:

```bash
yarn tsx scripts/local/control-plane-autofix.ts --dry-run
```

## How to prevent

1. **Ensure `podSubnet` is in the kubeadm init command.** The SSM Automation
   document must pass `--pod-network-cidr=192.168.0.0/16` to `kubeadm init`.
   Verify this is set before triggering bootstrap.

2. **Deploy CCM before ArgoCD.** `control_plane.py` step 4b (`step_install_ccm`)
   installs CCM via Helm before ArgoCD bootstrap, breaking the deadlock cycle.
   Confirm the updated script is synced to S3 before re-running automation.

3. **Clear markers before a forced re-run.** If a partial bootstrap run is
   suspected, remove stale markers before re-running:
   ```bash
   rm -f /etc/kubernetes/.calico-installed /etc/kubernetes/.ccm-installed
   ```

4. **Use the post-automation pipeline step.** The autofix script is designed
   to run as the step immediately after SSM Automation in a CI pipeline
   (`--automation-id` flag). This catches failures automatically without
   manual intervention.

## Deeper detail

- [Bootstrap deadlock — CCM](../runbooks/bootstrap-deadlock-ccm.md)
  — full manual recovery procedure for the CCM deadlock with real-world
  recovery timeline from 2026-03-25

<!--
Evidence trail (auto-generated):
- Source: scripts/local/control-plane-autofix.ts (read on 2026-04-29)
- Source: scripts/local/control-plane-troubleshoot.ts (read on 2026-04-29)
- Source: docs/runbooks/bootstrap-deadlock-ccm.md (read on 2026-04-29)
-->
