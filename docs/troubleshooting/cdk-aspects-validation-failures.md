---
title: CDK Aspects Validation Failures
type: troubleshooting
tags: [aws-cdk, aspects, cdk-nag, synthesis-validation, iam, troubleshooting]
sources:
  - infra/lib/aspects/enforce-readonly-dynamodb-aspect.ts
  - infra/lib/aspects/cdk-nag-aspect.ts
  - infra/lib/stacks/kubernetes/edge-stack.ts
  - infra/bin/app.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom: synthesis exits non-zero with Annotation errors

CDK synthesis can fail with two types of output:

**Hard throws** — a JavaScript `Error` thrown inside a constructor. The output looks like:

```
Error: ACM certificate is required when using custom domain names.
    at new CloudFrontConstruct (.../cloudfront.ts:218:13)
```

**Annotation errors** — emitted via `cdk.Annotations.of(node).addError()`. These appear at the end of synthesis output:

```
[Error at /StackName/ConstructPath/Resource] Rule `AwsSolutions-L1`: ...
```

Annotation errors exit synthesis with code 1 after collecting all violations. Hard throws exit immediately on first failure. Both prevent CloudFormation template generation.

## Diagnosis: locate the failing node path

For Annotation errors, the bracketed path `[Error at /StackName/ConstructPath/Resource]` is the CDK construct path. To find the resource:

1. Run `cdk synth` and capture the output: `npx cdk synth -c project=kubernetes -c environment=dev 2>&1 | grep '\[Error'`
2. The path structure is `/<StackName>/<ConstructId>/<ChildId>/.../<ResourceId>`
3. The resource type (e.g. `AWS::Lambda::Function`) is in the rule description or rule ID documentation

## Common failure: AwsSolutions-L1 on CDK framework Lambdas

**Rule:** `AwsSolutions-L1` — Lambda function is not using the latest runtime version.

**Root cause:** CDK's `cr.Provider` and `AwsCustomResource` constructs create framework Lambda functions internally. CDK chooses the runtime at library version time; cdk-nag flags it as outdated when a newer Node.js LTS is available. The construct reference is not directly accessible to the stack author.

**Pattern:** This appears in any stack using `cr.Provider` (e.g. for DNS alias records) or `cr.AwsCustomResource` (e.g. for cross-region SSM reads). Examples from `edge-stack.ts`:

```
[Error at /K8s-Edge-dev/DnsAliasProvider/framework-onEvent/Resource] AwsSolutions-L1: ...
[Error at /K8s-Edge-dev/AWS679f53fac002430cb0da5b7982bd2287/Resource] AwsSolutions-L1: ...
```

**Fix:** Suppress by construct path using `NagSuppressions.addResourceSuppressionsByPath()`. The path must include the exact stack name prefix:

```ts
// For cr.Provider framework Lambda
NagSuppressions.addResourceSuppressionsByPath(
    this,
    `/${this.stackName}/DnsAliasProvider/framework-onEvent/Resource`,
    [{
        id: 'AwsSolutions-L1',
        reason: 'Framework Lambda runtime is managed by CDK cr.Provider and cannot be configured',
    }],
);

// For AwsCustomResource singleton Lambda (CDK-generated logical ID)
NagSuppressions.addResourceSuppressionsByPath(
    this,
    `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    [{
        id: 'AwsSolutions-L1',
        reason: 'Lambda runtime is managed by CDK AwsCustomResource and cannot be configured',
    }],
);
```

The `AWS679f53fac002430cb0da5b7982bd2287` logical ID is a CDK-internal singleton construct for `AwsCustomResource`. It is stable across CDK versions but verify with `cdk synth --json | jq '.Resources | keys'` if the path does not match.

## Common failure: AwsSolutions-IAM5 on wildcard resources

**Rule:** `AwsSolutions-IAM5` — IAM policy allows actions on `*` (wildcard resource).

**Root cause:** Several AWS APIs only accept `*` as the resource ARN — they cannot be scoped to specific resources. `ec2:DescribeManagedPrefixLists` is the most common example in this repo (`base-stack.ts:233-240`). cdk-nag flags these as policy violations.

**Fix:** Suppress at the `AwsCustomResource` construct level with documentation of why the wildcard is unavoidable:

```ts
NagSuppressions.addResourceSuppressions(cfPrefixListLookup, [{
    id: 'AwsSolutions-IAM5',
    reason: 'ec2:DescribeManagedPrefixLists requires wildcard resource — read-only API call with no resource-level permissions',
}], true); // true = apply to child constructs (the generated IAM role)
```

## Common failure: EnforceReadOnlyDynamoDbAspect false positive

**Symptom:** Synthesis fails with:

```
[Error at /StackName/SomeRole/DefaultPolicy/Resource]
[EnforceReadOnlyDynamoDb] ECS task role has forbidden DynamoDB action: "dynamodb:PutItem"
```

**True positive:** The role genuinely has write access and the architecture boundary has been violated. Review whether the write operation should go through API Gateway → Lambda instead.

**False positive scenario:** A non-task IAM role has a construct ID that accidentally contains `taskrole` as a substring. The Aspect matches by pattern — `roleId.toLowerCase().includes(this.roleNamePattern)` (`enforce-readonly-dynamodb-aspect.ts:118-121`).

**Diagnosis:** Check the construct path in the error. If it refers to a role that is not an ECS task role, the match is a false positive.

**Fix option 1 — rename the role construct ID** to not contain `taskrole`:

```ts
// Before (triggers the Aspect)
new iam.Role(this, 'DataTaskRole', { ... });

// After (does not trigger the Aspect)
new iam.Role(this, 'DataProcessingRole', { ... });
```

**Fix option 2 — configure a specific pattern** when applying the Aspect, so it only matches the intended role:

```ts
Aspects.of(computeStack).add(new EnforceReadOnlyDynamoDbAspect({
    roleNamePattern: 'nextjs-taskrole', // exact prefix, not generic 'taskrole'
}));
```

**Fix option 3 — warn-only mode** during migration:

```ts
Aspects.of(computeStack).add(new EnforceReadOnlyDynamoDbAspect({
    failOnViolation: false, // addWarning instead of addError
}));
```

## Common failure: EnforceReadOnlyDynamoDbAspect on dynamodb:* wildcard

**Symptom:**

```
[EnforceReadOnlyDynamoDb] ECS task role has forbidden DynamoDB action: "dynamodb:*"
```

**Root cause:** A CDK `iam.PolicyStatement` was granted with `grantFullAccess()` or `actions: ['dynamodb:*']`. The Aspect detects `dynamodb:*` as a wildcard that includes write actions (`enforce-readonly-dynamodb-aspect.ts:190-196`).

**Fix:** Replace with specific read actions:

```ts
// Before
tableArn.grantFullAccess(taskRole);

// After
table.grantReadData(taskRole); // adds GetItem, Query, Scan, BatchGetItem
```

## Disabling nag checks for a single synthesis run

To synthesise without nag checks (e.g. to inspect the raw CloudFormation template):

```bash
npx cdk synth -c project=kubernetes -c environment=dev -c nagChecks=false
```

This skips `applyCdkNag` (`app.ts:123`) and outputs the template without running any compliance rules.

## Related

- [CDK Aspects Governance](../concepts/cdk-aspects-governance.md) — how Aspects are scheduled, three annotation mechanisms, NagSuppressions API reference
- [CDK Construct Architecture](../concepts/cdk-construct-architecture.md) — compile-time validation patterns overview
- [IaC Security — Dual-Layer](../concepts/iac-security-dual-layer.md) — cdk-nag and Checkov complementary roles

<!--
Evidence trail (auto-generated):
- Source: infra/lib/aspects/enforce-readonly-dynamodb-aspect.ts (read on 2026-04-29)
- Source: infra/lib/aspects/cdk-nag-aspect.ts (read on 2026-04-29)
- Source: infra/lib/stacks/kubernetes/edge-stack.ts (read on 2026-04-29) — lines 733-742, 839-848 for NagSuppressions patterns
- Source: infra/lib/stacks/kubernetes/base-stack.ts (read on 2026-04-29) — lines 233-240 for ec2:DescribeManagedPrefixLists wildcard pattern
- Source: infra/bin/app.ts (read on 2026-04-29) — line 123 for nagChecks context flag
-->
