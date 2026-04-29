---
title: "ADR-002: SSM Parameters over CloudFormation Cross-Stack Exports"
type: decision
tags: [aws-cdk, ssm, cloudformation, cross-stack, infrastructure-as-code, decoupling]
sources:
  - infra/lib/config/ssm-paths.ts
  - infra/lib/constructs/ssm/ssm-parameter-store.ts
  - infra/lib/stacks/kubernetes/base-stack.ts
  - infra/lib/stacks/kubernetes/control-plane-stack.ts
  - infra/lib/projects/kubernetes/factory.ts
created: 2026-04-28
updated: 2026-04-28
---

# ADR-002: SSM Parameters over CloudFormation Cross-Stack Exports

**Date:** 2026-04-28
**Status:** Accepted
**Deciders:** Nelson Lamounier (solo developer)

---

## Context

The Kubernetes project deploys 10 stacks that share infrastructure values: VPC ID, security group IDs, KMS key ARN, Elastic IP, NLB target group ARNs. In a multi-stack CDK app, the standard mechanism for sharing these values is CloudFormation exports via `Fn::ImportValue`.

The platform architecture requires `KubernetesBaseStack` to be deployable and updatable independently of the 7 stacks that depend on it. A compliance update to a security group rule, for example, should not require redeploying the control plane ASG or the edge CloudFront distribution.

---

## Decision

Use SSM Parameter Store as the cross-stack output bus. Every stack that produces values other stacks need writes them to SSM via `SsmParameterStoreConstruct`. Consumer stacks read from SSM using `ssm.StringParameter.valueForStringParameter()` or `AwsCustomResource`.

`infra/lib/config/ssm-paths.ts` is the single source of truth for all parameter paths, defined as typed interfaces with builder functions (`k8sSsmPaths(environment)`, `nextjsSsmPaths(environment)`, etc.).

---

## Alternatives considered

### Alternative 1: CloudFormation cross-stack exports (`Fn::ImportValue`)

This is CDK's default behavior when you pass a resource property from one stack to another as a prop.

**Problem — stack update lock:**
CloudFormation blocks updates to a stack that has active exports consumed by other stacks. With 7 stacks importing from `BaseStack`, any change to `BaseStack` (even renaming an internal construct) would require deploying all 7 consumers first — in the correct order, without failures. In practice, this makes base infrastructure effectively immutable after initial deployment.

**Problem — cross-region limitation:**
`KubernetesEdgeStack` deploys in `us-east-1` but needs the Elastic IP from `us-east-1`. CloudFormation exports are region-scoped. Cross-region exports do not exist.

**Problem — cross-repo limitation:**
K8s bootstrap scripts in `kubernetes-bootstrap` and application deploy scripts need the ECR URIs, NLB ARNs, and RDS endpoint. These scripts are shell/Python processes — they cannot consume CloudFormation exports. They can read from SSM.

### Alternative 2: Pass all values as CDK props within a single app

Instead of independent stacks, create one large combined stack where `baseStack.securityGroup` is passed directly to `controlPlaneStack`.

**Problem — blast radius:**
A change to the security group configuration forces CloudFormation to update the entire combined stack, including ASG launch templates, which triggers a rolling replacement of all EC2 instances.

**Problem — lifecycle coupling:**
Data, compute, IAM, edge, and observability have fundamentally different change rates. Data resources change when schema changes. Compute resources change when AMIs are rebuilt. Edge resources change when domains or certificates change. Coupling them into one stack means every change touches every resource type.

### Alternative 3: AWS Secrets Manager for all values

Use Secrets Manager for all cross-stack discovery.

**Problem — cost:**
Secrets Manager charges $0.40/secret/month plus $0.05/10,000 API calls. With 20+ values to publish, this is ~$8/month in secret storage alone. SSM Standard tier is free.

**Problem — semantics:**
Security group IDs, bucket names, and hosted zone IDs are not secrets. Using Secrets Manager for non-secret values is semantically incorrect and complicates IAM policy design (all callers need `secretsmanager:GetSecretValue`).

---

## Consequences

**Positive:**
- `KubernetesBaseStack` can be updated, redeployed, or even replaced without touching any consumer stack
- Bootstrap scripts and K8s deploy scripts in `kubernetes-bootstrap` read the same SSM parameters — no separate config injection needed
- Cross-region reads supported via `AwsCustomResource` (used by EdgeStack to read EIP from `eu-west-1`)
- Adding a new output = one line in the `SsmParameterStoreConstruct` record

**Negative:**
- SSM reads happen at deploy time, not synth time. If a parameter doesn't exist when a consumer stack deploys, the deployment fails with `ParameterNotFound`. Deployment order must still be correct.
- SSM reads are eventually consistent at scale — irrelevant for a single-account deployment but a consideration at enterprise scale
- No automatic drift detection: if a producer stack is replaced and the new stack writes a different value, consumers will silently read the new value on next deploy

**Mitigation for deployment order:**
CDK `addDependency` calls in the factory enforce CloudFormation deployment sequencing. The `_deploy-kubernetes.yml` workflow adds an additional layer of integration tests between stages (`verify-base`, `verify-data`, `verify-edge`) that confirm SSM parameters exist and are valid before the next stage proceeds.

---

## Implementation reference

- `infra/lib/config/ssm-paths.ts` — all path definitions
- `infra/lib/constructs/ssm/ssm-parameter-store.ts` — batch-write L3 construct
- `infra/lib/stacks/kubernetes/base-stack.ts` — primary SSM publisher (12 params)
- `infra/lib/stacks/kubernetes/edge-stack.ts` — cross-region SSM consumer via `AwsCustomResource`
- [SSM Cross-Stack Pattern](../patterns/ssm-cross-stack-pattern.md) — usage guide

<!--
Evidence trail (auto-generated):
- Source: infra/lib/config/ssm-paths.ts (read on 2026-04-28)
- Source: infra/lib/constructs/ssm/ssm-parameter-store.ts (read on 2026-04-28)
- Source: infra/lib/stacks/kubernetes/base-stack.ts (read on 2026-04-28)
- Source: infra/lib/stacks/kubernetes/control-plane-stack.ts (read on 2026-04-28)
- Source: infra/lib/projects/kubernetes/factory.ts (read on 2026-04-28)
-->
