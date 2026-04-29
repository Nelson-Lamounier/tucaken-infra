---
title: CDK Aspects Governance
type: concept
tags: [aws-cdk, aspects, governance, iac, synthesis-validation, cdk-nag, tagging, iam, finops, npm-package]
sources:
  - infra/bin/app.ts
  - infra/lib/aspects/tagging-aspect.ts
  - infra/lib/aspects/enforce-readonly-dynamodb-aspect.ts
  - infra/lib/aspects/cdk-nag-aspect.ts
  - infra/lib/stacks/kubernetes/edge-stack.ts
  - packages/cdk-governance-aspects/src/tagging-aspect.ts
  - packages/cdk-governance-aspects/src/enforce-readonly-dynamodb-aspect.ts
  - packages/cdk-governance-aspects/test/tagging-aspect.test.ts
  - packages/cdk-governance-aspects/test/enforce-readonly-dynamodb-aspect.test.ts
  - packages/cdk-governance-aspects/README.md
created: 2026-04-29
updated: 2026-04-29
---

## What CDK Aspects are — and how they differ from constructs

A CDK construct creates infrastructure: it instantiates resources, wires dependencies, and produces CloudFormation configuration. An Aspect does none of that. An Aspect **observes and annotates** the construct tree after it has been fully built.

The interface is a single method:

```typescript
interface IAspect {
    visit(node: IConstruct): void;
}
```

The key difference: constructs are **producers** (add resources to the tree); Aspects are **validators and mutators** (inspect or modify every node in the tree without being invited by each construct). A construct cannot know about every sibling in its stack — an Aspect can.

This makes Aspects the right tool for:
- Governance rules that must apply everywhere without each construct opting in (tagging)
- Policy invariants that must hold at the final synthesised state (IAM guardrails)
- Compliance scanning across the entire template (cdk-nag)

This repo defines three production Aspects: `TaggingAspect`, `EnforceReadOnlyDynamoDbAspect`, and the cdk-nag compliance wrappers. All three are wired in [`infra/bin/app.ts`](../../infra/bin/app.ts).

## How visit() is scheduled

CDK synthesis runs in two phases:

1. **Instantiation** — constructs are created, dependencies are declared. Every `new SomeConstruct(this, ...)` call executes here.
2. **Prepare** — CDK traverses the construct tree and calls `aspect.visit(node)` on every node in depth-first order, after all stacks have been instantiated.

The prepare-phase guarantee means Aspects see the complete, final construct tree. An Aspect can safely inspect a resource added by a different construct at instantiation time — it will not miss it.

`Aspects.of(scope)` scopes the traversal. `Aspects.of(stack)` visits that stack's nodes only. `Aspects.of(app)` visits every node across all stacks. Both patterns are used in this repo.

## TaggingAspect — per-stack application

`TaggingAspect` (`infra/lib/aspects/tagging-aspect.ts`) is applied **per-stack**, not at app level (`infra/bin/app.ts:85-94`):

```ts
stacks.forEach(stack => {
    cdk.Aspects.of(stack).add(new TaggingAspect({
        environment,
        project: projectConfig.namespace?.toLowerCase(),
        owner: 'nelson-l',
        component: inferComponent(stack.stackName),
        version: INFRA_VERSION,
        costCentre: inferCostCentre(stack.stackName),
    }));
});
```

`inferComponent(stack.stackName)` and `inferCostCentre(stack.stackName)` derive tag values from the stack name at synthesis time (`app.ts:100-119`). A `data` stack gets `component: 'data'`; an `edge` stack gets `component: 'networking'` and `costCentre: 'infrastructure'`. One `TaggingAspect` class produces different tag values per stack — no per-resource tagging is needed anywhere in the codebase.

**INFRA_VERSION and Launch Template coupling.** The `version` tag is sourced from `process.env.INFRA_VERSION ?? '1.0.0'` (`app.ts:83`). Changing this value mutates the `version` tag on Launch Templates. CloudFormation responds by creating a new LT version, which ASG rolling update uses to replace running EC2 instances. Only bump when intentional rolling replacement is desired.

The `visit()` method calls `cdk.TagManager.isTaggable(node)` before acting — non-taggable nodes (custom resource assets, bundled Lambda code) are silently skipped (`tagging-aspect.ts:96-102`). Tags are applied with `node.tags.setTag()`. CDK tag merge semantics: earlier `setTag()` calls win; the Aspect runs in the prepare phase, so it runs after all construct instantiation — Aspect tags override any construct-level tag with the same key.

## EnforceReadOnlyDynamoDbAspect — token resolution

`EnforceReadOnlyDynamoDbAspect` (`infra/lib/aspects/enforce-readonly-dynamodb-aspect.ts`) enforces that ECS task roles never gain DynamoDB write access. Its `visit()` targets only `iam.CfnPolicy` L1 nodes — it returns immediately for any other type (`enforce-readonly-dynamodb-aspect.ts:104-107`).

### Why CfnPolicy L1 and not the L2 Grant

By the time the prepare phase runs, CDK's L2 `iam.Grant` and `PolicyStatement` abstractions have been synthesised into `iam.CfnPolicy` L1 CFN resources. Inspecting at L1 means the Aspect sees the final policy document that will actually be deployed — not an intermediate abstraction that might be further transformed.

### Token resolution in inspectPolicyDocument

CDK constructs defer some values as tokens. A role's logical ID is not known until template generation. The Aspect resolves these before inspecting:

```ts
// Resolve roles array — may contain { Ref: 'LogicalId' } tokens
const resolved = cdk.Stack.of(node).resolve(node.roles);

// Resolve all CDK tokens/Lazy values in the policy document
const resolvedDoc = cdk.Stack.of(node).resolve(doc);
```

`cdk.Stack.of(node).resolve()` converts `[{ Ref: 'TaskRoleB6D0B916' }]` into the actual logical ID string. The Aspect then checks if any resolved role ID contains `taskrole` (case-insensitive). Direct string comparison without resolution produces false negatives because the token object never matches a string pattern.

By default `failOnViolation: true` calls `cdk.Annotations.of(node).addError(message)`, which causes synthesis to exit with a non-zero code. Setting `failOnViolation: false` switches to `addWarning()` — useful during IAM refactoring to see all violations before fixing.

## applyCdkNag — compliance checks at app level

`applyCdkNag` from `infra/lib/aspects/cdk-nag-aspect.ts` is applied to the **entire app** (`app.ts:125-131`):

```ts
applyCdkNag(app, {
    packs: [CompliancePack.AWS_SOLUTIONS],
    verbose: false,
    reports: true,
});
stacks.forEach(stack => applyCommonSuppressions(stack));
```

`Aspects.of(app)` traverses every construct across all stacks in a single pass. `applyCommonSuppressions(stack)` applies the `COMMON_SUPPRESSIONS` list from `cdk-nag-aspect.ts:103-132` — documented project-wide exceptions with rationale strings. Nag checks can be skipped for a specific synthesis run with `-c nagChecks=false` (`app.ts:123`).

## Three annotation mechanisms and when to use each

| Mechanism | Halts synthesis | Use when |
|:----------|:----------------|:---------|
| `throw new Error(message)` | Immediately | Error is fatal — e.g. wrong region, logically impossible configuration |
| `cdk.Annotations.of(node).addError(message)` | After collecting all errors | Continue so other Aspects finish and all problems are visible at once |
| `cdk.Annotations.of(node).addWarning(message)` | Never | Non-fatal advisory — resource can deploy but may be misconfigured |

Examples from this repo:

- `throw new Error()` — `CloudFrontConstruct` when `domainNames` is set but `certificate` is absent (`cloudfront.ts:217-223`). The distribution cannot be configured without a certificate.
- `addError()` — `KubernetesEdgeStack` when the stack region is not `us-east-1` (`edge-stack.ts:247-251`). Other stacks can still be validated in the same synthesis run.
- `addWarning()` — `CloudFrontConstruct` when production logging is disabled (`cloudfront.ts:256-260`), and `KubernetesEdgeStack` when edge config props are absent for CI-only synth runs (`edge-stack.ts:257-263`).

## NagSuppressions — three suppression APIs

cdk-nag provides three suppression functions at different granularity:

```ts
// By construct reference — most specific
NagSuppressions.addResourceSuppressions(
    this.distribution,
    [{ id: 'AwsSolutions-CFR4', reason: 'WAF not required for non-production' }],
    true, // applyToChildren
);

// By construct path string — required when construct reference is unavailable
NagSuppressions.addResourceSuppressionsByPath(
    this,
    `/${this.stackName}/DnsAliasProvider/framework-onEvent/Resource`,
    [{ id: 'AwsSolutions-L1', reason: 'Framework Lambda runtime managed by CDK cr.Provider' }],
);

// Stack-wide — for rules that apply uniformly
NagSuppressions.addStackSuppressions(stack, COMMON_SUPPRESSIONS);
```

`addResourceSuppressionsByPath` is required for CDK-managed framework resources whose construct reference is not exposed — for example, `cr.Provider`'s internal `framework-onEvent` Lambda (`edge-stack.ts:733-742`) and `AwsCustomResource`'s singleton Lambda (`edge-stack.ts:839-848`). The path must match the exact CDK construct path including the stack name prefix.

## The @nelsonlamounier/cdk-governance-aspects npm package

`TaggingAspect` and `EnforceReadOnlyDynamoDbAspect` also exist as a published
npm package:
[`@nelsonlamounier/cdk-governance-aspects`](https://www.npmjs.com/package/@nelsonlamounier/cdk-governance-aspects)
v1.0.0 (MIT).

The package lives at [`packages/cdk-governance-aspects/`](../../packages/cdk-governance-aspects/)
inside this monorepo. The implementations are near-identical to the copies
under `infra/lib/aspects/` — the package versions carry full JSDoc and a
typed `EnforceReadOnlyDynamoDbProps` interface; the infra copies shadow them
with the same logic.

### Why extraction to a package

Aspects that enforce governance rules are only valuable if they can be applied
consistently. Extracting them to a versioned package means:

1. Any future CDK repo (sibling projects, client work) can install the same
   tagging schema with a single `yarn add`.
2. The package acts as a contractual boundary — a semver bump signals that
   the tag schema or enforcement rules changed.
3. It creates a shareable, citable artefact. CDK aspect packages are
   uncommon on npm — the package demonstrates a level of CDK depth most
   engineers never reach.

### Peer dependency contract

```json
"peerDependencies": {
    "aws-cdk-lib": "^2.170.0",
    "constructs": "^10.0.0"
}
```

The package does not bundle `aws-cdk-lib` — it relies on the consumer's CDK
installation. This is the standard CDK library pattern: it avoids duplicate
CDK instances in the dependency tree, which would break construct tree
identity checks
([`packages/cdk-governance-aspects/package.json`](../../packages/cdk-governance-aspects/package.json)).

---

## Testing patterns for Aspects

Aspects run during CDK synthesis, not at runtime. This changes how they are
tested.

### The synthesis trigger

Aspect `visit()` is called during `app.synth()`. A test must explicitly call
`app.synth()` (or use `Template.fromStack(stack)`, which triggers synthesis
internally) to activate Aspects:

```typescript
// From packages/cdk-governance-aspects/test/enforce-readonly-dynamodb-aspect.test.ts:41-44
cdk.Aspects.of(stack).add(new EnforceReadOnlyDynamoDbAspect(aspectProps));

// Force synthesis to trigger aspect visitors
app.synth();
```

Without the `app.synth()` call, `visit()` is never invoked and assertions
on Annotations will silently pass.

### Testing TaggingAspect — Template assertions

`TaggingAspect` mutates the synthesised CloudFormation template. The correct
assertion target is `Template.fromStack(stack)`, which captures the final
template after the prepare phase runs:

```typescript
// From packages/cdk-governance-aspects/test/tagging-aspect.test.ts:36-45
function synthesiseStack(config: TagConfig): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new s3.CfnBucket(stack, 'TagTarget');  // lightweight taggable resource

    cdk.Aspects.of(stack).add(new TaggingAspect(config));

    return Template.fromStack(stack);  // triggers synthesis + aspect
}
```

The test uses `s3.CfnBucket` (not `s3.Bucket`) as the taggable resource.
An L1 `CfnBucket` is lighter than an L2 `Bucket` — no policies, no CDK-generated
dependencies — and it reliably carries the `Tags` property in the resulting
CloudFormation template.

### Testing EnforceReadOnlyDynamoDbAspect — Annotations assertions

`EnforceReadOnlyDynamoDbAspect` communicates via `cdk.Annotations`. The
assertion target is `Annotations.fromStack(stack)`:

```typescript
// From packages/cdk-governance-aspects/test/enforce-readonly-dynamodb-aspect.test.ts:87-93
it('should block dynamodb:PutItem', () => {
    const stack = buildStackWithPolicy(['dynamodb:PutItem']);
    Annotations.fromStack(stack).hasError(
        '*',           // construct path glob — '*' matches any node
        Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*PutItem'),
    );
});
```

`Annotations.fromStack(stack).hasNoError('*', Match.anyValue())` is the
assertion for allowed actions — verifying that synthesis completed without
an `addError()` call.

### Testing scope isolation

The `roleNamePattern` option makes the Aspect scope-aware. Tests verify
that policies on non-matching roles (e.g. `LambdaExecutionRole`) do not
trigger errors:

```typescript
// From test/enforce-readonly-dynamodb-aspect.test.ts:167-175
it('should skip roles that do not match the roleNamePattern', () => {
    const stack = buildStackWithPolicy(
        ['dynamodb:PutItem'],
        'LambdaExecutionRole',  // does not contain 'taskrole'
    );
    Annotations.fromStack(stack).hasNoError('*', Match.anyValue());
});
```

This test pattern is important for Aspects that use pattern-based
scoping — it proves the aspect does not fire broadly on all IAM constructs.

### Key testing invariants

| Test category | Assertion API | Trigger |
|:---|:---|:---|
| Tag values present in template | `Template.fromStack().findResources()` | `Template.fromStack()` calls `synth` internally |
| Tag count correct | `expect(tags).toHaveLength(7)` | Same |
| Annotation error fired | `Annotations.fromStack().hasError(path, matcher)` | Explicit `app.synth()` |
| No annotation error | `Annotations.fromStack().hasNoError(path, matcher)` | Explicit `app.synth()` |
| Warning not error | `.hasNoError()` + `.hasWarning()` | Explicit `app.synth()` |

---

## Deeper detail

- [CDK Construct Architecture](cdk-construct-architecture.md) — L1/L2/L3 layer model, factory pattern, and how Aspects fit in the overall design
- [CDK Aspects Validation Failures](../troubleshooting/cdk-aspects-validation-failures.md) — how to read Annotation errors in synthesis output, common false-positive patterns for `EnforceReadOnlyDynamoDbAspect` and `AwsSolutions-L1`

## Related concepts

- [IaC Security — Dual-Layer](../concepts/iac-security-dual-layer.md)
- [FinOps Observability](../concepts/finops-observability.md)
- [CloudFront Distribution](../concepts/cloudfront-distribution.md)
- [cdk-governance-aspects project](../projects/cdk-governance-aspects.md)

<!--
Evidence trail (auto-generated):
- Source: infra/bin/app.ts (read on 2026-04-29)
- Source: infra/lib/aspects/tagging-aspect.ts (read on 2026-04-29)
- Source: infra/lib/aspects/enforce-readonly-dynamodb-aspect.ts (read on 2026-04-29)
- Source: infra/lib/aspects/cdk-nag-aspect.ts (read on 2026-04-29)
- Source: infra/lib/stacks/kubernetes/edge-stack.ts (read on 2026-04-29) — NagSuppressions at lines 658, 671, 733-742, 839-848
- Source: packages/cdk-governance-aspects/src/tagging-aspect.ts (read on 2026-04-29)
- Source: packages/cdk-governance-aspects/src/enforce-readonly-dynamodb-aspect.ts (read on 2026-04-29)
- Source: packages/cdk-governance-aspects/test/tagging-aspect.test.ts (read on 2026-04-29)
- Source: packages/cdk-governance-aspects/test/enforce-readonly-dynamodb-aspect.test.ts (read on 2026-04-29)
- Source: packages/cdk-governance-aspects/README.md (read on 2026-04-29)
- Source: packages/cdk-governance-aspects/package.json (read on 2026-04-29)
-->
