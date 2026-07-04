---
title: "Platform RDS — Networking, Isolated-Subnet Migration & PgBouncer"
type: concept
tags: [rds, postgresql, vpc, networking, security-groups, pgbouncer, migration, snapshot, nat-gateway, cost, kubernetes, platform]
sources:
  - infra/lib/shared/vpc-stack.ts
  - infra/lib/stacks/kubernetes/platform-rds-stack.ts
  - infra/lib/stacks/kubernetes/eks-cluster-stack.ts
  - infra/lib/projects/kubernetes/factory.ts
  - api/admin-api/src/lib/pg.ts
created: 2026-07-04
updated: 2026-07-04
---

# Platform RDS — Networking, Isolated-Subnet Migration & PgBouncer

## Overview

The Tucaken platform runs a single PostgreSQL instance on Amazon RDS inside the
shared VPC. As of **2026-07-04** that instance lives in **isolated (no-NAT) data
subnets** rather than the public subnets it originally occupied. This document
records the full networking design, the snapshot-restore migration that moved the
database between subnets, the cluster-side configuration required for pods to
reach it, and the cost and protocol implications.

For the connection-pooling rationale in isolation, see
[Platform PostgreSQL + PgBouncer Architecture](platform-rds-pgbouncer.md). This
document is the networking and migration companion to it.

A rendered architecture diagram lives at
[`docs/diagrams/platform-rds-networking.drawio`](../diagrams/platform-rds-networking.drawio)
(open in draw.io / diagrams.net).

Verified against live account `771826808455`, region `eu-west-1`.

## Why it was done

The original layout placed RDS in the VPC's **public** subnets with
`publiclyAccessible: false`. That is already not reachable from the internet — the
instance has no public IP — but the subnet route table still carries a
`0.0.0.0/0 → internet gateway` route. Moving the database to **isolated** subnets
removes that route entirely, so the database sits on subnets that have no path to
or from the internet at all. This is defence in depth: the security group is the
inner boundary, `publiclyAccessible: false` the middle boundary, and the absence
of any IGW route the outer one.

Crucially, this was achieved **without a NAT Gateway**. A managed RDS instance
needs no outbound internet — backups, snapshots, CloudWatch metrics, enhanced
monitoring and Performance Insights all travel over the AWS internal network, not
the customer route table. So the isolated subnets carry a **local route only**
(`10.0.0.0/16 → local`) and cost nothing extra.

## Network topology

| Layer | Value |
|---|---|
| VPC | `shared-vpc-development` · `vpc-06c460143d78778fe` · `10.0.0.0/16` |
| Public subnets | `10.0.0.0/24` (eu-west-1a), `10.0.1.0/24` (eu-west-1b) · route `0.0.0.0/0 → igw-0fc7a0a585489ad98` |
| Isolated subnets | `10.0.2.0/24` (eu-west-1a), `10.0.3.0/24` (eu-west-1b) · route `10.0.0.0/16 → local` only |
| NAT Gateways | **none** (`natGateways: 0`) |
| RDS instance | `k8s-dev-platform-rds-iso` · `db.t4g.small` · PostgreSQL 18.3 · Single-AZ (eu-west-1b) · `publiclyAccessible: false` |

The VPC is defined in [`infra/lib/shared/vpc-stack.ts`](../../infra/lib/shared/vpc-stack.ts).
It provisions two subnet groups — `PUBLIC` and `PRIVATE_ISOLATED` — and, since this
migration, publishes the isolated subnet IDs to SSM (see below).

### VPC resolution via SSM, not `Vpc.fromLookup()`

`PlatformRdsStack` no longer imports the VPC with `Vpc.fromLookup()`. That call
performs a **synth-time** subnet discovery which (a) caches into
`cdk.context.json` — going stale after the VPC's subnets change — and (b) requires
the isolated subnets to already exist at synth, a chicken-and-egg with the VPC
stack that creates them.

Instead the stack resolves the VPC from SSM, choosing the read mode deliberately:

- **`vpcId`** via `StringParameter.valueFromLookup` (synth-time). A VPC id is
  immutable, so a cached value is always correct. This keeps the database security
  group's `VpcId` a **concrete literal** — `VpcId` is immutable on a security
  group, so a token there would force a replacement of the fixed-name SG.
- **isolated subnet IDs** via `StringParameter.valueForStringParameter` (a
  deploy-time `{{resolve:ssm:...}}` dynamic reference). Subnet IDs can change, so
  they resolve at deploy, not synth. They land only in the DB subnet group, which
  CloudFormation can freely update.

The VPC stack publishes `/shared/vpc/<env>/isolated-subnet-ids` (and per-subnet
ids); the RDS stack consumes them. Because the subnet reference is deploy-time,
the RDS stack now synthesises even before the subnets physically exist.

## Protocol and connection path

All application pods connect **exclusively through PgBouncer** — never directly to
RDS.

```
admin-api / worker pod  ──►  PgBouncer  ──►  RDS PostgreSQL
   pg Pool (max 5)          transaction        TCP 5432 · TLS
                            mode · ≤20          isolated subnet
                            server conns
```

- **Wire protocol:** the PostgreSQL frontend/backend protocol over **TCP port
  5432**. There is no HTTP in this path.
- **Transport security:** TLS. The Node.js `pg` client connects with
  `ssl: { rejectUnauthorized: false }` (see
  [`api/admin-api/src/lib/pg.ts`](../../api/admin-api/src/lib/pg.ts)); RDS presents
  its managed certificate.
- **PgBouncer** runs as a `Deployment` in the `platform` namespace, reachable at
  `pgbouncer.platform.svc.cluster.local:5432`. It runs in **transaction mode**:
  a server connection is held only for the duration of a single transaction, then
  returned to the pool. It caps server-side connections to RDS at **≤20**,
  multiplexing them across up to 5 client connections per pod.
- **Authentication:** IAM database authentication is enabled on the instance
  (`iamAuthentication: true`), but PgBouncer currently connects with the generated
  Secrets Manager password until an IAM-token rollout is implemented.

Because both the pods (public subnets) and RDS (isolated subnets) are inside the
same VPC, traffic routes over the VPC-internal `local` route — no IGW, no NAT.

## Cluster-side configuration required for the connection

Two things must be in place for a pod to reach the database.

### 1. Security-group ingress (SG-to-SG)

The database security group (`sg-0a3858a8…`, `k8s-dev-platform-rds`) admits **no
CIDR ingress**. The previous design allowed `5432` from the whole VPC CIDR; that
rule was removed. Access is now granted **security-group to security-group**:
approved source stacks add an explicit rule.

`EksClusterStack` adds the rule that lets cluster workloads in:

```typescript
// infra/lib/stacks/kubernetes/eks-cluster-stack.ts
const platformRdsSecurityGroupId = ssm.StringParameter.valueForStringParameter(
    this, `/k8s/${props.targetEnvironment}/platform-rds/sg-id`);

new ec2.CfnSecurityGroupIngress(this, 'PlatformRdsIngressFromEksCluster', {
    groupId: platformRdsSecurityGroupId,
    ipProtocol: 'tcp', fromPort: 5432, toPort: 5432,
    sourceSecurityGroupId: this.cluster.clusterSecurityGroupId,
    description: 'PostgreSQL from EKS managed workload SG via PgBouncer',
});
```

Live, the RDS SG now accepts `5432` from the EKS cluster SG
(`sg-07dc2b1a8b09275e2`). Because `EksClusterStack` reads the RDS SG id from SSM,
the RDS stack must deploy first;
[`factory.ts`](../../infra/lib/projects/kubernetes/factory.ts) enforces this with
`eksClusterStack.addDependency(platformRdsStack)`.

### 2. Credentials and host injection (External Secrets Operator)

The RDS stack publishes six parameters under `/k8s/<env>/platform-rds/`:
`host`, `port`, `database`, `user`, `secret-arn`, `sg-id`. The generated master
credentials live in Secrets Manager; that secret's JSON embeds `host`, `port`,
`username`, `password`, `dbname` and `dbInstanceIdentifier`.

External Secrets Operator (ESO) in the cluster reads the SSM `secret-arn` (and/or
the Secrets Manager secret) and materialises a Kubernetes `Secret`. PgBouncer and
the pods receive the endpoint through `PG_HOST` and credentials from that synced
Secret at start-up.

> **Important:** ESO must reference the **SSM-published `secret-arn`/`host`**, not
> a hard-coded secret name. The migration below replaced the instance, which
> changed both the endpoint and the credentials-secret name. If the
> `kubernetes-bootstrap` `ExternalSecret` points at a fixed name, it must be
> updated to the new ARN.

## The migration: recovering RDS from one subnet to another

### Why an in-place move was impossible

RDS cannot relocate a **running** instance to a disjoint set of subnets. The clean
CDK change — flipping `vpcSubnets` from `PUBLIC` to `PRIVATE_ISOLATED` — makes
CloudFormation modify the DB subnet group to drop the public subnets, which fails
while the live instance still occupies one of them:

```
Some of the subnets to be deleted are currently in use: subnet-027ebf40f0edca13f
```

The supported way to move an instance to new subnets is therefore a
**snapshot and restore**.

### The sequence that worked

1. **Deploy the VPC stack** (`Shared-Infra-development`, project `shared`) to
   create the isolated subnets and publish their ids to SSM. Additive only:
   new `/24` subnets and route tables; existing public subnets untouched;
   still zero NAT. (~47 s.)
2. **Take a safety snapshot** of the live instance:
   `k8s-dev-platform-rds-pre-isolated-20260704`.
3. **Deploy `PlatformRds-development`** with the instance re-modelled as a
   `DatabaseInstanceFromSnapshot` targeting the isolated subnets. CloudFormation
   does a create-before-delete replacement: it builds a new subnet group and a new
   instance from the snapshot, re-publishes the endpoint and secret ARN to SSM,
   then deletes the old instance and its old subnet group. (~15.5 min for the
   restore.)
4. **Deploy `EksCluster-development`** to add the SG-to-SG ingress rule that
   replaces the removed VPC-CIDR rule. (~3 min.)

### The gotchas encountered (and how each was resolved)

Every one of these produced a clean CloudFormation rollback — the live database was
never harmed — before the fix landed:

| Symptom | Root cause | Fix |
|---|---|---|
| `Security Group … already exists` | The SG `description` was edited. `GroupDescription` is **immutable**; with a fixed `securityGroupName` the forced replace collides. | Keep the description byte-identical; the access change lives in the ingress rules, not the label. |
| `subnets … currently in use` | Modifying the shared, auto-created DB subnet group while the old instance still holds a public subnet. | Give the restored instance its **own** explicit `rds.SubnetGroup`; the old group is deleted only after the old instance. |
| `AllocatedStorage 20 → 100` | Dropping `allocatedStorage` let CDK apply its **100 GiB default**, tripling storage cost. | Set `allocatedStorage: 20` explicitly to hold the snapshot size. |
| cdk-nag `AwsSolutions-RDS2` | `DatabaseInstanceFromSnapshot` does not emit `StorageEncrypted`, so nag cannot see the inherited encryption. | Suppress with justification — the restored volume is encrypted because the snapshot is. |
| New identifier & secret required | CloudFormation replacement is create-before-delete; a same-name instance or secret collides with the still-existing original. | Restore as `k8s-dev-platform-rds-iso` with a CDK auto-named secret; the new endpoint and ARN propagate through SSM. |

### Permanent consequence: the snapshot is now a dependency

`DatabaseInstanceFromSnapshot` bakes `DBSnapshotIdentifier` into the instance.
Per CloudFormation semantics, that property must be **kept for the life of the
instance** — removing it forces RDS to replace the instance with a fresh, **empty**
one (data loss). Therefore:

- **Do not delete** the snapshot `k8s-dev-platform-rds-pre-isolated-20260704`; it is
  a live dependency of the current template.
- Returning to a plain `DatabaseInstance` construct (to shed this coupling) is a
  separate, deliberate migration and is tracked as tech-debt.

## Cost implications

Grounded in the code and live account; dollar figures are **approximate AWS list
prices for eu-west-1** and should be treated as estimates.

| Item | Cost impact |
|---|---|
| NAT Gateway | **$0** — none provisioned. A NAT Gateway would add ~$35/month plus ~$0.045/GB data processing. Avoiding it is the entire point of the isolated-subnet design. |
| Isolated subnets and route tables | **$0** — free VPC primitives. |
| RDS instance | **Unchanged** — same `db.t4g.small` before and after (~$25/month list). |
| Storage | **Held at 20 GiB** — the `allocatedStorage: 20` fix prevented an accidental jump to 100 GiB. |
| Safety snapshot | **~$2/month** — ~20 GiB of manual snapshot storage beyond the instance's free backup allowance, now a permanent dependency. |
| Migration overlap | **~pennies** — two `db.t4g.small` instances co-existed for the ~15-minute restore. |
| Cross-AZ data transfer | **Minor** — RDS is Single-AZ in eu-west-1b; a pod in eu-west-1a talking to it crosses AZs (~$0.01/GB each way). PgBouncer keeps the connection count and therefore this traffic low. |

Net effect: **no new ongoing charge of note**, and the design continues to avoid
the ~$35/month NAT Gateway.

### Endpoint charges

RDS does **not** bill for the DNS endpoint itself. What you pay for is
instance-hours, allocated storage, provisioned IOPS/throughput, backup storage
beyond the free allowance, and data transfer. Because the database is reached over
the VPC-internal `local` route — never through an internet gateway, NAT gateway or
VPC endpoint — there are **no per-request, NAT data-processing or interface-endpoint
charges** on the connection path. The only transfer cost is the small cross-AZ rate
noted above.

## Verification

Infrastructure (verified this migration):

- New instance `k8s-dev-platform-rds-iso` — `available`, `publiclyAccessible:
  false`, 20 GiB, on the isolated subnets.
- Those subnets' route tables carry `local` only — no IGW, no NAT.
- SSM `/k8s/development/platform-rds/host` and `secret-arn` point at the new
  instance and secret.
- RDS SG admits `5432` from the EKS cluster SG.

Data plane (run with cluster access):

```bash
kubectl -n platform get externalsecret,secret     # ESO synced new host/creds?
kubectl -n platform logs deploy/pgbouncer | tail   # connecting to the -iso host?
kubectl -n platform rollout restart deploy/pgbouncer   # if a dead endpoint is cached
```

## Related concepts

- [Platform PostgreSQL + PgBouncer Architecture](platform-rds-pgbouncer.md) — the pooler design in detail
- [Security Group Configuration](security-group-configuration.md) — SG-to-SG patterns across the platform
- [EKS Platform Architecture](eks-platform-architecture.md) — the cluster that hosts PgBouncer

<!-- evidence-trail
  vpc-stack.ts: isolated subnet config + SSM isolated-subnet-ids publishing read
  platform-rds-stack.ts: DatabaseInstanceFromSnapshot, SSM VPC resolution, explicit SubnetGroup, nag suppressions read
  eks-cluster-stack.ts: CfnSecurityGroupIngress from cluster SG read
  factory.ts: eksClusterStack.addDependency(platformRdsStack) read
  Live account 771826808455/eu-west-1 verified: subnets, route tables, RDS placement, SG ingress, SSM params, secret shape
  Deploy timings observed: VPC 47s, RDS restore 929.9s, EKS 184s
-->
