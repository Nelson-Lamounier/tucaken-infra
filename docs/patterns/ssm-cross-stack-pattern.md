---
title: SSM Cross-Stack Discovery Pattern
type: pattern
tags: [aws-cdk, ssm, cloudformation, cross-stack, infrastructure-as-code, decoupling]
sources:
  - infra/lib/config/ssm-paths.ts
  - infra/lib/constructs/ssm/ssm-parameter-store.ts
  - infra/lib/stacks/kubernetes/base-stack.ts
  - infra/lib/stacks/kubernetes/control-plane-stack.ts
  - infra/lib/stacks/kubernetes/worker-asg-stack.ts
  - infra/lib/projects/kubernetes/factory.ts
created: 2026-04-28
updated: 2026-04-28
---

# SSM Cross-Stack Discovery Pattern

## Problem: CloudFormation export coupling

CDK's native cross-stack reference mechanism produces `Fn::ImportValue` CloudFormation exports. These create a hard constraint: **you cannot update or delete the exporting stack if any consuming stack still references its export.**

In a 10-stack architecture with a shared base layer, this is severe:

- `KubernetesBaseStack` exports the VPC ID, security group IDs, KMS key ARN, EIP
- 7 downstream stacks import these values
- Changing anything in `BaseStack` — even renaming a resource — is blocked until all 7 consumers are redeployed in perfect order

The consequence is that "long-lived" base infrastructure and "short-lived" compute infrastructure become fused. Replacing an EC2 instance requires touching the same CloudFormation stack as the VPC.

## Solution: SSM as a decoupled output bus

Each stack that produces outputs writes them to SSM Parameter Store at deploy time. Consumer stacks read from SSM independently. No CloudFormation export is created. Stacks are fully independent.

```
KubernetesBaseStack
  → deploys → writes SSM params:
      /k8s/dev/security-group-id
      /k8s/dev/ingress-sg-id
      /k8s/dev/kms-key-arn
      /k8s/dev/nlb-http-target-group-arn
      ...12 total

KubernetesControlPlaneStack
  → deploys after BaseStack (via addDependency) → reads:
      ssm.StringParameter.valueForStringParameter(this, '/k8s/dev/security-group-id')
```

The `addDependency` call still enforces deployment order — but it's a sequencing hint to CloudFormation, not an export/import coupling. Either stack can be redeployed independently after the first deploy.

## Implementation

### `SsmParameterStoreConstruct` — the batch writer

`infra/lib/constructs/ssm/ssm-parameter-store.ts` is an L3 construct that batch-creates SSM parameters from a `Record<string, string>`:

```typescript
new SsmParameterStoreConstruct(this, 'SsmParams', {
    parameters: {
        [ssmPaths.vpcId]:                  vpc.vpcId,
        [ssmPaths.elasticIp]:              eip.ref,
        [ssmPaths.elasticIpAllocationId]:  eip.attrAllocationId,
        [ssmPaths.securityGroupId]:        clusterSg.securityGroupId,
        [ssmPaths.controlPlaneSgId]:       controlPlaneSg.securityGroupId,
        [ssmPaths.ingressSgId]:            ingressSg.securityGroupId,
        [ssmPaths.monitoringSgId]:         monitoringSg.securityGroupId,
        [ssmPaths.scriptsBucket]:          scriptsBucket.bucketName,
        [ssmPaths.hostedZoneId]:           hostedZone.hostedZoneId,
        [ssmPaths.apiDnsName]:             hostedZone.zoneName,
        [ssmPaths.kmsKeyArn]:              kmsKey.keyArn,
        [ssmPaths.nlbFullName]:            nlb.loadBalancerFullName,
    },
});
```

Construct IDs and descriptions are auto-generated from the path's last segment. Adding a parameter is one line in the record.

> **Warning — logical ID stability:** Only use `SsmParameterStoreConstruct` in stacks that have never been deployed with inline `ssm.StringParameter()` calls. Migrating an existing stack changes CloudFormation logical IDs and causes "already exists" deployment failures. For existing stacks, use inline `ssm.StringParameter()` with stable construct IDs.

### `ssm-paths.ts` — single source of truth

`infra/lib/config/ssm-paths.ts` defines all SSM paths as typed interfaces with builder functions:

```typescript
export interface K8sSsmPaths {
    readonly prefix: string;
    readonly vpcId: string;
    readonly elasticIp: string;
    readonly securityGroupId: string;
    readonly controlPlaneSgId: string;
    readonly ingressSgId: string;
    readonly monitoringSgId: string;
    readonly kmsKeyArn: string;
    readonly nlbFullName: string;
    readonly nlbHttpTargetGroupArn: string;
    readonly nlbHttpsTargetGroupArn: string;
    // ...
}

export function k8sSsmPaths(environment: Environment): K8sSsmPaths {
    const prefix = `/k8s/${environment}`;
    return {
        prefix,
        vpcId: `${prefix}/vpc-id`,
        elasticIp: `${prefix}/elastic-ip`,
        // ...
    };
}
```

Every stack that reads or writes these parameters imports `k8sSsmPaths(environment)`. No inline path string concatenation anywhere in the codebase.

### SSM path namespaces

| Prefix | Owner stack | Consumer stacks |
|---|---|---|
| `/k8s/{env}/...` | KubernetesBaseStack, ControlPlaneStack | ControlPlane, Workers, AppIam, Edge, Observability |
| `/nextjs/{env}/...` | DataStack, CognitoAuthStack | ApiStack, EdgeStack, AppIamStack |
| `/shared/ecr-{service}/{env}/...` | SharedVpcStack | CI/CD workflows, K8s deploy scripts |
| `/bedrock-{env}/...` | ai-applications stacks | AppIamStack, EdgeStack (admin-api-url, public-api-url) |
| `/self-healing-{env}/...` | ai-applications GatewayStack | ObservabilityStack |
| `/k8s/{env}/platform-rds/...` | PlatformRdsStack | K8s ESO manifests (external-secrets-operator) |

### Cross-region SSM reads (Edge stack)

`KubernetesEdgeStack` deploys in `us-east-1` but needs values published by `KubernetesBaseStack` in `eu-west-1`. It uses `AwsCustomResource` backed by a Lambda in `us-east-1` to call the `eu-west-1` SSM API:

```typescript
const eipReader = new cr.AwsCustomResource(this, 'EipReader', {
    onUpdate: {
        service: 'SSM',
        action: 'getParameter',
        parameters: { Name: eipSsmPath },
        region: eipSsmRegion,  // eu-west-1
        physicalResourceId: cr.PhysicalResourceId.of('EipReader'),
    },
});
const eip = eipReader.getResponseField('Parameter.Value');
```

The factory comment warns: if the `deploy-base → sync-bootstrap → deploy-edge` sequencing is broken, the `AwsCustomResource` will fail with `ParameterNotFound`.

## VPC ID is a special case

The `sharedVpcId` is NOT resolved via SSM at consumer stack deploy time:

```typescript
// factory.ts
const sharedVpcId = baseStack.vpc.vpcId;
// Passed directly to consumer stacks as a string prop
```

`baseStack.vpc` is constructed via `Vpc.fromLookup(this, 'Vpc', { vpcId })` which resolves the VPC ID at **synth time** against the live AWS account, storing it in `cdk.context.json`. This produces a concrete string — not a CDK token — so passing it to consumer stacks does not create a `Fn::ImportValue`. It behaves identically to an SSM lookup from the consumer's perspective.

## IAM grants — using the wildcard path

Stacks that need to grant read access to their SSM outputs use the `wildcard` path:

```typescript
// AppIamStack grants the K8s node IAM role read access to all k8s SSM params
const ssmParameterPath = k8sSsmPaths(environment).wildcard; // /k8s/dev/*
```

This avoids granting `ssm:GetParameter` on `*` while still covering all parameters published by base/compute stacks.

## Why not CloudFormation cross-stack references?

| Factor | CloudFormation exports | SSM parameters |
|---|---|---|
| Stack independence | None — locked until consumer updates | Full — update exporting stack anytime |
| Deployment order | Enforced by CDK `addDependency` | Enforced by CDK `addDependency` (same) |
| Cross-region lookup | Not supported natively | Supported via `AwsCustomResource` |
| Cross-repo reads | Impossible | Parameters are just strings in AWS |
| Drift detection | Tight coupling catches drift | Consumer reads stale value silently |
| Secrets | Not suitable | Use `SecureString` tier for secrets |

The drift risk is mitigated by integration tests in `_deploy-kubernetes.yml` that verify SSM parameter existence and value correctness after each stack deploys.

## When to use this pattern

**Use SSM** when:
- A stack's output will be consumed by multiple independent stacks
- You want to update the producing stack without cascading updates
- You need cross-region or cross-repo parameter sharing
- The consumer is a script, K8s bootstrap job, or external system (not CDK)

**Use CDK tokens / props** when:
- The consuming stack is always deployed atomically with the producer (single factory call)
- The value is resolved at synth time (e.g., `Vpc.fromLookup`)
- The stacks are tightly coupled by design and that's intentional

<!--
Evidence trail (auto-generated):
- Source: infra/lib/config/ssm-paths.ts (read on 2026-04-28)
- Source: infra/lib/constructs/ssm/ssm-parameter-store.ts (read on 2026-04-28)
- Source: infra/lib/stacks/kubernetes/base-stack.ts (read on 2026-04-28)
- Source: infra/lib/stacks/kubernetes/control-plane-stack.ts (read on 2026-04-28)
- Source: infra/lib/stacks/kubernetes/worker-asg-stack.ts (read on 2026-04-28)
- Source: infra/lib/projects/kubernetes/factory.ts (read on 2026-04-28)
-->
