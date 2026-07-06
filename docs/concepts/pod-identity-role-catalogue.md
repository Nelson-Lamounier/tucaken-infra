---
title: EKS Pod Identity role catalogue
type: concept
tags: [kubernetes, eks, pod-identity, iam, least-privilege, finops, yace, bedrock, aws-cdk]
sources:
  - infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts
  - infra/lib/config/eks/configurations.ts
created: 2026-07-06
updated: 2026-07-06
---

## What this is

`EksPodIdentityStack` is the single place where every workload's AWS
permissions are declared. It creates **one IAM role per binding**, each linked
to a Kubernetes `namespace`/`serviceAccount` pair via a
`CfnPodIdentityAssociation` — the repo convention is Pod Identity over IRSA
(`eks-pod-identity-stack.ts:1-9`, `85-110`).

The stack loops over `props.bindings` and, for each one, mints an
`iam.Role` that trusts the `pods.eks.amazonaws.com` service principal, with a
description of the form `Pod Identity role for <namespace>/<serviceAccount>`
(`eks-pod-identity-stack.ts:83-89`). Each trust policy additionally grants
**`sts:TagSession`** on top of the default `sts:AssumeRole`; without it the
association create call rejects the role with "Trust policy of the role
provided is invalid", because Pod Identity attaches session tags
(`eks-cluster-arn`, `kubernetes-namespace`, ...) to every STS request
(`eks-pod-identity-stack.ts:90-100`). `attachPurposePolicies` then hangs the
least-privilege statements off the role, and a `CfnPodIdentityAssociation`
wires `clusterName`/`namespace`/`serviceAccount`/`roleArn` together
(`eks-pod-identity-stack.ts:101-109`).

The same stack also installs the `eks-pod-identity-agent` addon and a
tolerated CoreDNS managed addon; the trust-policy and addon mechanics are
covered in
[Karpenter and Pod Identity provisioning](karpenter-pod-identity-provisioning.md),
and where these stacks sit in the deploy order is in
[EKS platform architecture](eks-platform-architecture.md). This doc is the
per-service-account permission matrix.

## The role catalogue

The binding list lives in `COMMON_BINDINGS`
(`configurations.ts:105-124`); the matching permission blocks are the
`switch (purpose)` cases in `attachPurposePolicies`
(`eks-pod-identity-stack.ts:118-620`). Fifteen workloads, three tiers:

| Purpose | namespace / serviceAccount | What it can do | Scope |
|---|---|---|---|
| `karpenter` | `karpenter` / `karpenter` | Drain the SQS interruption queue; launch/terminate EC2; manage instance profiles; resolve EKS AMI SSM params | Mixed (SQS/PassRole/SSM ARN-scoped, EC2/IAM/`eks:DescribeCluster` on `*`) |
| `alb-controller` | `kube-system` / `aws-load-balancer-controller` | Provision NLB/ALB (vendored AWS-published policy) | Mixed (per the vendored `iam_policy.json`) |
| `external-dns` | `kube-system` / `external-dns` | Write Route53 records, or assume a cross-account DNS role | ARN-scoped write + `route53:List*` on `*` |
| `external-secrets` | `external-secrets` / `external-secrets` | Read SSM/Secrets Manager and `kms:Decrypt` for secret injection | `*` |
| `ebs-csi` | `kube-system` / `ebs-csi-controller-sa` | Provision/attach EBS volumes (AWS managed policy) | AWS managed `AmazonEBSCSIDriverPolicy` |
| `grafana-alerting` | `monitoring` / `grafana` | Publish alerts to SNS; read CloudWatch metrics + Logs Insights | SNS ARN-scoped; CloudWatch/logs read on `*` |
| `yace` | `monitoring` / `yace` | Scrape AWS/RDS CloudWatch metrics into Prometheus; discover instances by tag | `*` (see below) |
| `admin-api` | `admin-api` / `admin-api` | S3 asset ops; Cognito account-termination; FinOps Cost Explorer + CloudWatch read | Mixed (Cognito ARN-scoped, S3/FinOps on `*`) |
| `image-updater` | `argocd` / `argocd-image-updater` | Poll ECR for new image tags | ECR repo ARN-scoped + `GetAuthorizationToken` on `*` |
| `headlamp-token-pusher` | `headlamp` / `token-pusher` | Push the viewer token to one SSM parameter | Single-parameter ARN |
| `public-api` | `public-api` / `public-api` | Read the Bedrock chatbot API-key secret | Single-secret ARN |
| `ingestion` | `ingestion` / `ingestion-sa` | Bedrock `InvokeModel` for chunk enrichment + embeddings | Foundation-model + inference-profile ARNs |
| `job-strategist` | `job-strategist` / `job-strategist-sa` | Bedrock invoke + `Rerank`; read/write the assets bucket | Mixed (`Rerank` on `*`, rest ARN-scoped) |
| `article-pipeline` | `article-pipeline` / `article-pipeline-sa` | Same as `job-strategist` (shared case) | Mixed (`Rerank` on `*`, rest ARN-scoped) |
| `ontology-importer` | `ontology-importer` / `ontology-importer-sa` | Submit/poll Bedrock batch jobs; S3 I/O; `PassRole` a Bedrock service role | ARN-scoped (bucket + invoke + `model-invocation-job` + `PassRole`) |

Row-by-row grounding: `karpenter` `:119-203`, `alb-controller` `:204-221`,
`external-dns` `:222-256`, `external-secrets` `:257-271`, `ebs-csi`
`:272-278`, `grafana-alerting` `:279-308`, `yace` `:309-335`, `ingestion`
`:336-353`, `job-strategist`/`article-pipeline` `:354-410`,
`ontology-importer` `:411-488`, `admin-api` `:489-560`, `image-updater`
`:561-588`, `headlamp-token-pusher` `:589-603`, `public-api` `:605-619` (all
`eks-pod-identity-stack.ts`).

## Least privilege, and when `*` is unavoidable

The default is ARN scoping, and the file scopes wherever the action supports
it. `*` appears only where the AWS action has no resource type, and each such
case carries an inline reason in the code.

### `bedrock:Rerank` MUST be `*`

For `job-strategist` and `article-pipeline`, ordinary Bedrock invoke
(`bedrock:InvokeModel`, `InvokeModelWithResponseStream`) is scoped to
`foundation-model/*` and `inference-profile/*` ARNs
(`eks-pod-identity-stack.ts:360-372`). But `bedrock:Rerank` is granted on `*`
by necessity:

> `bedrock:Rerank` does NOT support resource-level permissions (the IAM
> service-authorization reference lists no resource type for it), so it MUST
> be granted on "*". Scoping it to foundation-model/inference-profile ARNs
> made the statement a silent no-op -> "no identity-based policy allows
> bedrock:Rerank" at call time (confirmed via simulate-principal-policy).
> — `eks-pod-identity-stack.ts:377-383`

Scoping an action that has no resource type does not fail closed with an
error at deploy time; it fails silently at call time, which is why this one is
called out explicitly (`eks-pod-identity-stack.ts:373-385`).

### Cost Explorer and CloudWatch read

Cost Explorer (`ce:GetCostAndUsage`, `ce:GetTags`) and CloudWatch reads
(`cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`) have no resource-level
scoping either — Cost Explorer is a global service, and the CloudWatch read
actions do not take a resource ARN. These land on `*` in `admin-api`,
`grafana-alerting`, and `yace` (`eks-pod-identity-stack.ts:546-559`,
`289-307`, `319-334`).

### Contrast: scoping IS used wherever the action supports it

The same file is aggressive about ARN scoping when it can be:

- **`headlamp-token-pusher`** — `ssm:PutParameter` on exactly one parameter
  ARN, `.../parameter/k8s/<env>/headlamp-viewer-token`, no wildcard
  (`eks-pod-identity-stack.ts:594-602`).
- **`image-updater`** — `ecr:DescribeRepositories`/`DescribeImages`/`ListImages`
  scoped to `repository/*` in this account/region; only the token action
  (`ecr:GetAuthorizationToken`, which has no resource type) is on `*`
  (`eks-pod-identity-stack.ts:566-587`).
- **`public-api`** — `secretsmanager:GetSecretValue` scoped to the single
  `bedrock-*/bedrock-api-key-*` secret ARN
  (`eks-pod-identity-stack.ts:610-618`).
- **`ontology-importer`** — every statement is ARN-scoped: batch S3 I/O to the
  `ontology-importer-batch-<env>` bucket, Bedrock batch actions to
  foundation-model/inference-profile/`model-invocation-job` ARNs, and
  `iam:PassRole` to the one Bedrock batch service role it creates
  (`eks-pod-identity-stack.ts:452-486`).
- **`karpenter`** — `iam:PassRole` scoped to the worker-node role ARN and
  `ssm:GetParameter` scoped to the EKS/Bottlerocket AMI parameter paths, even
  though its EC2 and instance-profile actions require `*`
  (`eks-pod-identity-stack.ts:182-202`).

The wildcard S3 grant in `admin-api`
(`arn:aws:s3:::*/*`, `eks-pod-identity-stack.ts:495-512`) is the one place a
resource-scopable action is left on `*`, and the code says why: the bucket
name is published at runtime by a sibling repo's stack and is not available at
CDK synthesis time.

## YACE CloudWatch-read role

The `yace` case (`eks-pod-identity-stack.ts:309-335`) is the IAM half of moving
the RDS observability panels off the fragile Grafana CloudWatch datasource and
onto Prometheus. YACE (yet-another-cloudwatch-exporter) scrapes AWS/RDS
CloudWatch metrics and exposes them for Prometheus to ingest. The single
statement grants:

- **`cloudwatch:GetMetricData`, `GetMetricStatistics`, `ListMetrics`** —
  read-only, they pull the metric series
  (`eks-pod-identity-stack.ts:322-325`).
- **`tag:GetResources`** — lets YACE discover the RDS instance(s) **by tag**,
  so an instance rename or a brand-new instance is picked up with no config
  change (`eks-pod-identity-stack.ts:326`, `310-316`).
- **`iam:ListAccountAliases`** — added later, purely to silence a per-scrape
  `AccessDenied`. YACE calls it once per scrape to set an `account_alias`
  label; without it metrics still flow, the scrape just logs a noisy
  `AccessDenied` (`eks-pod-identity-stack.ts:327-330`).

None of these CloudWatch or tagging actions support resource-level scoping, so
the statement is on `*` — the code notes this is the same rationale as
`grafana-alerting`'s read policy (`eks-pod-identity-stack.ts:316-334`). The
decision record behind the datasource migration lives in a sibling repo and is
not reproduced here.

## admin-api FinOps grant

The `admin-api` role carries a dedicated FinOps block
(`eks-pod-identity-stack.ts:548-559`) that powers the Cost tab of the admin
dashboard. The `admin-api` finops routes read Cost Explorer and CloudWatch
custom metrics directly — there is no intermediate Lambda — so the pod itself
needs:

- **`ce:GetCostAndUsage`, `ce:GetTags`** for the cost figures, and
- **`cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`** for the custom
  metrics.

Without them the failure modes are asymmetric, per the code comment: the Cost
tab reads **empty** because the `ce:` `AccessDenied` is swallowed by the
route's `try/catch`, while the metric routes **500** because the `cloudwatch:`
denial is not caught (`eks-pod-identity-stack.ts:541-547`). This traces to
issue #168 (`eks-pod-identity-stack.ts:545`). All four actions are on `*` as
covered above. See [FinOps observability](finops-observability.md) for how
these metrics are surfaced.

## Adding a new workload role

1. Add the binding to `COMMON_BINDINGS` in `configurations.ts` with its
   `namespace`, `serviceAccount`, and a new `purpose` literal (also extend the
   `purpose` union at `configurations.ts:30-45`).
2. Add a matching `case '<purpose>':` block to `attachPurposePolicies`
   (`eks-pod-identity-stack.ts:118`).
3. **Scope by ARN** wherever the action supports a resource type — follow the
   `headlamp-token-pusher`/`public-api` pattern of a single-resource ARN.
4. Only fall back to `resources: ['*']` when the action genuinely has no
   resource type (the CloudWatch/Cost Explorer/`bedrock:Rerank` cases), or when
   the ARN is unknowable at synth time (the `admin-api` S3 case), and leave an
   **inline comment** stating which of those two reasons applies.

The association itself is created automatically by the binding loop
(`eks-pod-identity-stack.ts:104-109`) — no extra wiring is needed.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts (read 2026-07-06, lines 1-622) — full stack: association mechanism (1-111) and all 15 purpose cases (118-620)
- Source: infra/lib/config/eks/configurations.ts (read 2026-07-06, lines 25-124) — PodIdentityBinding interface + purpose union (27-46) and COMMON_BINDINGS namespace/serviceAccount/purpose matrix (105-124)
- Source: docs/concepts/karpenter-pod-identity-provisioning.md (read 2026-07-06) — sibling doc for house format/tone and to avoid duplicating Karpenter-role detail
-->
