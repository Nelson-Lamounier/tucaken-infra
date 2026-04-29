# Cross-AZ Disaster Recovery Runbook

> **Scenario**: eu-west-1a is unavailable. EBS volume is inaccessible.
> The entire control plane must be rebuilt in a different AZ.

## Prerequisites

Before you start, confirm these S3 backups exist:

```bash
# etcd snapshot (hourly via systemd timer)
aws s3 ls s3://<scripts-bucket>/dr-backups/etcd/latest.db \
  --region eu-west-1 --profile dev-account

# PKI certificates (saved after kubeadm init)
aws s3 ls s3://<scripts-bucket>/dr-backups/pki/latest.tar.gz \
  --region eu-west-1 --profile dev-account
```

If these exist, recovery preserves full cluster state. If not, the cluster
will bootstrap fresh from Git (ArgoCD rebuilds everything, but Secrets and
runtime state are lost).

---

## Recovery Steps

### 1. Confirm AZ Outage

```bash
# Check AZ status
aws ec2 describe-availability-zones \
  --region eu-west-1 \
  --query 'AvailabilityZones[?ZoneName==`eu-west-1a`].State' \
  --output text --profile dev-account
```

If `impaired` or `unavailable`, proceed with cross-AZ recovery.

### 2. Pause ASG Self-Healing

The ASG will try to launch in eu-west-1a and fail repeatedly.
Suspend it to stop wasted attempts:

```bash
aws autoscaling suspend-processes \
  --auto-scaling-group-name k8s-development-compute \
  --region eu-west-1 --profile dev-account
echo "ASG suspended — no new launches until resumed"
```

### 3. Create EBS Volume in Healthy AZ

**Option A: From DLM Snapshot (preferred)**

```bash
# Find latest snapshot
SNAPSHOT_ID=$(aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Name,Values=k8s-development-data" \
  --query 'Snapshots | sort_by(@, &StartTime) | [-1].SnapshotId' \
  --output text --region eu-west-1 --profile dev-account)

echo "Latest snapshot: ${SNAPSHOT_ID}"

# Create volume in eu-west-1b from snapshot
aws ec2 create-volume \
  --availability-zone eu-west-1b \
  --snapshot-id "${SNAPSHOT_ID}" \
  --volume-type gp3 \
  --encrypted \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=k8s-development-data}]' \
  --region eu-west-1 --profile dev-account
```

**Option B: Fresh Volume (no snapshot available)**

```bash
aws ec2 create-volume \
  --availability-zone eu-west-1b \
  --size 30 \
  --volume-type gp3 \
  --encrypted \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=k8s-development-data}]' \
  --region eu-west-1 --profile dev-account
```

Note the new Volume ID (e.g., `vol-0abc123`).

### 4. Update CDK Stack — Change AZ

Edit `base-stack.ts` and `control-plane-stack.ts` to target `eu-west-1b`:

```diff
# infra/lib/stacks/kubernetes/base-stack.ts (line 336)
- availabilityZone: `${this.region}a`,
+ availabilityZone: `${this.region}b`,

# infra/lib/stacks/kubernetes/control-plane-stack.ts (line 209)
- availabilityZones: [`${this.region}a`],
+ availabilityZones: [`${this.region}b`],
```

Also update the EBS Volume ID in SSM so the stack uses the new volume:

```bash
aws ssm put-parameter \
  --name "/k8s/development/ebs-volume-id" \
  --value "vol-0abc123" \
  --type String --overwrite \
  --region eu-west-1 --profile dev-account
```

### 5. Deploy Updated Stacks

```bash
# Deploy base infrastructure first
just ci-deploy Base-development

# Resume ASG and deploy compute
aws autoscaling resume-processes \
  --auto-scaling-group-name k8s-development-compute \
  --region eu-west-1 --profile dev-account

just ci-deploy ControlPlane-development
```

### 6. Trigger Bootstrap

The new instance will launch in eu-west-1b. The bootstrap pipeline
runs automatically:

1. **Step 2 (restore_backup)** detects empty EBS → restores etcd + certs from S3
2. **Step 3 (init_kubeadm)** starts with restored data
3. **Step 7 (bootstrap_argocd)** re-applies ArgoCD from Git
4. **Step 10 (install_etcd_backup)** re-enables hourly backups

### 7. Verify Recovery

```bash
# Port-forward via SSM
just k8s-tunnel-auto

# Check cluster
kubectl get nodes
kubectl get pods --all-namespaces

# Verify ArgoCD apps
kubectl get applications -n argocd

# Verify Crossplane Claims
kubectl get encryptedbuckets,monitoredqueues -n golden-path
```

### 8. Recycle Worker Nodes

If certificates were restored from S3, workers rejoin automatically.
If fresh init (no S3 backup), workers need new join credentials:

```bash
# On control plane (via SSM session)
kubeadm token create --ttl 24h
```

Then terminate worker instances — ASG will replace them and they'll
pick up the new join token from SSM.

---

## Recovery Timeline

| Phase | Duration | Notes |
|:---|:---:|:---|
| Confirm outage | 2 min | AWS Health Dashboard + CLI |
| Suspend ASG | 1 min | Prevents wasted launch attempts |
| Create EBS volume | 5 min | From snapshot: fast; fresh: instant |
| Update CDK + deploy | 15 min | AZ change + stack update |
| Bootstrap | 15 min | Full 10-step bootstrap |
| Verify | 5 min | kubectl checks |
| **Total** | **~45 min** | With S3 backups: full state preserved |

---

## Post-Recovery Checklist

- [ ] `kubectl get nodes` shows control plane Ready
- [ ] `systemctl status etcd-backup.timer` is active
- [ ] `aws s3 ls s3://<bucket>/dr-backups/etcd/` shows new backups
- [ ] ArgoCD dashboard accessible (port-forward 8080)
- [ ] Worker nodes joined and running workloads
- [ ] CloudFront → NLB → Traefik → Next.js serving traffic
- [ ] Revert CDK AZ back to `eu-west-1a` when AZ recovers (optional)

## Related

- [Self-Healing Platform](../projects/self-healing-platform.md) — canonical entry point: cross-AZ recovery is the only failure mode with no automated path
- [NLB Architecture](../concepts/nlb-architecture.md) — EIP SubnetMapping and how the NLB survives an AZ outage
- [etcd Restore SAN Mismatch](../troubleshooting/etcd-restore-san-mismatch.md) — API server cert SANs reference old IP after control plane migration
