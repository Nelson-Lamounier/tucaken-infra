---
title: etcd Restore — API Server Certificate SAN Mismatch After Cross-AZ Recovery
type: troubleshooting
tags: [kubernetes, etcd, disaster-recovery, certificates, self-managed-k8s, pki]
sources:
  - scripts/local/etcd-restore-rto-test.sh
  - docs/runbooks/cross-az-recovery.md
  - scripts/local/control-plane-troubleshoot.ts
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the self-managed kubeadm control plane, replaced by managed Amazon EKS in the kubeadm to EKS migration ([ADR-0001](../../decisions/0001-self-managed-k8s-vs-eks.md) records the original self-managed rationale; [EKS platform architecture](../../concepts/eks-platform-architecture.md) is the current design). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

After restoring an etcd snapshot onto a new control plane instance (cross-AZ
recovery or Spot instance replacement), the API server starts but kubelet
cannot connect. The Kubernetes API is unreachable and `kubectl` commands
fail with TLS errors. `journalctl -u kubelet` shows:

```
x509: certificate is valid for <old-IP>, not <new-IP>
```

Or the control plane troubleshooter reports:

```
⚠ MISMATCH: Cert SANs [10.0.0.11] do NOT include current IP 10.0.0.33
```

## Root cause

The API server TLS certificate (`/etc/kubernetes/pki/apiserver.crt`) encodes
the Subject Alternative Names (SANs) at the time `kubeadm init` ran. The
SANs include the control plane's private IP at that time.

When a cross-AZ recovery moves the control plane to a new Availability Zone,
the EC2 instance receives a new private IP address from the new AZ's subnet.
The restored etcd snapshot and PKI certificates still reference the old IP.
The new kubelet connects to the API server using the new IP, but the
certificate only validates against the old IP — causing a TLS handshake
failure.

This failure mode is documented in the troubleshooter's Phase 3 (DR &
Certificate Diagnostics) which checks certificate SANs against the current
IMDS private IP
([`control-plane-troubleshoot.ts:691-724`](../../../scripts/local/control-plane-troubleshoot.ts)).

The `etcd-restore-rto-test.sh` script times the restore sequence but does
not regenerate certificates — the SAN mismatch only surfaces when the
restored cluster starts on a different IP than where it was originally
initialised
([`scripts/local/etcd-restore-rto-test.sh`](../../../scripts/local/etcd-restore-rto-test.sh)).

## How to diagnose

Run the control plane troubleshooter with DR phase:

```bash
yarn tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account
```

The Phase 3 output will show the SAN mismatch explicitly. For manual
inspection on the control plane node (via SSM session):

```bash
# Check current SANs
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text \
  | grep -A3 "Subject Alternative Name"

# Check current instance IP
curl -s -H "X-aws-ec2-metadata-token: $(curl -sX PUT \
  http://169.254.169.254/latest/api/token \
  -H X-aws-ec2-metadata-token-ttl-seconds:21600)" \
  http://169.254.169.254/latest/meta-data/local-ipv4

# Check kubelet TLS errors
journalctl -u kubelet --no-pager -n 30 --priority=err
```

## How to fix

Regenerate the API server certificate with the current IP as an additional
SAN **before** starting the API server. The troubleshooter's `--fix` flag
performs this automatically:

```bash
yarn tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account --fix
```

The fix script (`attemptRepair()`) performs:

```bash
# Delete existing cert and key
rm -f /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key

# Regenerate with current IP in SANs
kubeadm init phase certs apiserver \
  --apiserver-advertise-address=<new-private-ip> \
  --apiserver-cert-extra-sans=127.0.0.1,<new-private-ip>,k8s-api.k8s.internal,<public-ip>

# Restart static pod (kills kube-apiserver container; kubelet restarts it)
crictl rm $(crictl ps --name kube-apiserver -q)
sleep 5
systemctl restart kubelet
```

Verify the new certificate includes the correct IP:

```bash
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text \
  | grep -A3 "Subject Alternative Name"
# Expected: IP Address:<new-private-ip> present in the output
```

## How to prevent

- **Include the cross-AZ recovery runbook step for cert regeneration.**
  Step 6 of
  [`docs/runbooks/cross-az-recovery.md`](../runbooks/cross-az-recovery.md)
  references the bootstrap sequence, but does not explicitly call out cert
  regeneration as a prerequisite before starting the API server. Add cert
  regeneration as an explicit prerequisite step when moving AZs.

- **Back up PKI with the etcd snapshot.** The
  [`cross-az-recovery.md`](../runbooks/cross-az-recovery.md) runbook
  confirms that PKI is backed up separately to S3 (`dr-backups/pki/latest.tar.gz`).
  Restoring this backup and then regenerating only the API server cert
  (which is IP-specific) is faster than regenerating all certs.

- **Use a stable DNS name instead of IP in kubeadm-config.** Configuring
  the `controlPlaneEndpoint` as a DNS name (`k8s-api.k8s.internal`) rather
  than an IP allows certificate reuse across IP changes. The current setup
  uses both the DNS name and IP in SANs — the DNS name remains valid, only
  the old IP SAN becomes invalid after AZ migration.

## Deeper detail

- [Cross-AZ Recovery Runbook](../runbooks/cross-az-recovery.md)
  — full recovery procedure including EBS volume recreation and ASG update

<!--
Evidence trail (auto-generated):
- Source: scripts/local/etcd-restore-rto-test.sh (read on 2026-04-29)
- Source: docs/runbooks/cross-az-recovery.md (read on 2026-04-29)
- Source: scripts/local/control-plane-troubleshoot.ts (read on 2026-04-29, Phase 3 DR diagnostics)
-->
