---
title: Creating a New CDK Construct
type: runbook
tags: [aws-cdk, constructs, typescript, iac, testing, development]
sources:
  - infra/lib/constructs/README.md
  - infra/lib/constructs/finops/budget-construct.ts
  - infra/lib/constructs/storage/s3-bucket.ts
  - infra/lib/constructs/networking/cloudfront.ts
  - infra/lib/constructs/index.ts
  - infra/tests/fixtures/test-app.ts
  - infra/tests/fixtures/constants.ts
  - infra/tests/unit/constructs/finops/budget-construct.test.ts
created: 2026-04-29
updated: 2026-04-29
---

## When to run this

Use this runbook when adding a new AWS resource that:

- Will be reused across more than one stack, **or**
- Needs opinionated defaults (security hardening, environment-aware behaviour), **or**
- Requires compile-time validation that cannot be expressed in the TypeScript type system alone

If the resource is one-off and stack-specific, add it directly in the stack rather than creating a construct.

## Prerequisites

- Node.js ≥ 18 and yarn installed
- Familiar with the [CDK Construct Architecture](../concepts/cdk-construct-architecture.md) — specifically the five design principles and the two-layer default value strategy

## Step 1 — Choose the domain directory

Constructs live in `infra/lib/constructs/<domain>/`. Pick the domain that matches the AWS service category:

| Domain | AWS services |
|:-------|:-------------|
| `compute/` | EC2, ASG, Lambda, Launch Template, SSM State Manager |
| `networking/` | CloudFront, ALB, NLB, API Gateway, VPC endpoints |
| `storage/` | S3, EBS, ECR |
| `security/` | ACM, Security Groups, WAF, GuardDuty, Security Hub |
| `ssm/` | SSM Parameter Store, Run Command documents |
| `finops/` | AWS Budgets |
| `events/` | EventBridge, Step Functions, AMI refresh automation |
| `observability/` | CloudWatch dashboards, Bedrock observability |
| `iam/` | Cross-account IAM, Crossplane IAM |

Constructs that span multiple services belong in the domain of the primary resource. `CloudFrontConstruct` lives in `networking/` even though it also configures an S3 log bucket.

## Step 2 — Create the construct file

**File path:** `infra/lib/constructs/<domain>/<construct-name>.ts`

Use kebab-case for filenames. The class name is PascalCase + `Construct` suffix.

**Minimum structure:**

```ts
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '../../config/environments';

export interface MyServiceConstructProps {
    readonly environment: Environment;
    // Required props first, then optional with JSDoc defaults
    readonly myProp: string;
    /** @default 'sensible-value' */
    readonly optionalProp?: string;
}

export class MyServiceConstruct extends Construct {
    public readonly resource: aws.MyService;

    constructor(scope: Construct, id: string, props: MyServiceConstructProps) {
        super(scope, id);

        // Inline fallback — never import a shared defaults object
        const optionalProp = props.optionalProp ?? 'sensible-value';

        this.resource = new aws.MyService(this, 'Resource', {
            // ...
        });
    }
}
```

**Five rules from `infra/lib/constructs/README.md`:**

1. **Inline defaults** — `props.foo ?? 'literal'` inside the constructor, never a shared `DEFAULTS` object
2. **Config layer overrides** — environment-specific values arrive from `configurations.ts`/`allocations.ts`, passed as props by the consuming stack
3. **Blueprint pattern** — construct creates resources; the consuming stack wires dependencies and creates `CfnOutput`
4. **Security by default** — `enforceSSL: true`, `blockPublicAccess: BLOCK_ALL`, least-privilege IAM where applicable
5. **Tag delegation** — only add a `Component: <name>` tag here; org tags are applied by `TaggingAspect` at app level

## Step 3 — Add compile-time validation where needed

Two mechanisms are available inside the constructor:

```ts
// Fatal — stop synthesis immediately (use when the config is logically impossible)
if (props.domainNames?.length && !props.certificate) {
    throw new Error('ACM certificate is required when using custom domain names.');
}

// Advisory — synthesis continues and collects all errors
if (isProduction && !props.encryptionKey) {
    cdk.Annotations.of(this).addWarning(
        `Production resource ${props.name} uses S3-managed encryption. Consider a CMK.`
    );
}
```

See [CDK Aspects Governance](cdk-aspects-governance.md) for the full decision table on which mechanism to use.

## Step 4 — Export from the domain index

Add the export to `infra/lib/constructs/<domain>/index.ts`:

```ts
export { MyServiceConstruct } from './my-service';
export type { MyServiceConstructProps } from './my-service';
```

Then add it to `infra/lib/constructs/index.ts` if it should be accessible from top-level imports:

```ts
export * from './my-domain';
```

## Step 5 — Update the construct README inventory

Add a row to the correct table in `infra/lib/constructs/README.md`:

```markdown
| `MyServiceConstruct` | `my-domain/my-service.ts` | Purpose in one sentence |
```

If the construct will be used by a specific stack, also add it to the "Consuming Stacks" table at the bottom of the README.

## Step 6 — Write the unit test

**File path:** `infra/tests/unit/constructs/<domain>/<construct-name>.test.ts`

**Minimum test structure:**

```ts
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { MyServiceConstruct } from '../../../../lib/constructs/my-domain/my-service';
import { createTestApp } from '../../../fixtures';

function _createConstruct(overrides?: Partial<MyServiceConstructProps>) {
    const app = createTestApp();
    const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });
    const construct = new MyServiceConstruct(stack, 'MyService', {
        environment: Environment.DEVELOPMENT,
        myProp: 'test-value',
        ...overrides,
    });
    return { stack, template: Template.fromStack(stack), construct };
}

describe('MyServiceConstruct', () => {
    it('creates the expected CloudFormation resource', () => {
        const { template } = _createConstruct();
        template.hasResourceProperties('AWS::SomeService::Resource', {
            MyProperty: 'expected-value',
        });
    });

    it('throws when logically impossible config is provided', () => {
        expect(() => _createConstruct({ impossibleProp: true })).toThrow(/expected message/);
    });
});
```

**Import the shared fixtures** — always use the helpers from `infra/tests/fixtures/`:

| Helper | Use when |
|:-------|:---------|
| `createTestApp()` | Always — skips Lambda bundling in tests via `aws:cdk:bundling-stacks: []` context |
| `TEST_ENV` | Stack needs an explicit account/region (`us-east-1`, account `123456789012`) |
| `TEST_ENV_EU` | Stack is region-specific and must be in `eu-west-1` |
| `createStackWithTemplate(factory)` | Returns `{ stack, template, app }` in one call |
| `createStackWithHelper(helperFactory, stackFactory)` | Stack needs dependencies (VPC, SG) from a separate helper stack |
| `TEST_VPC_CONTEXT_KEY` / `TEST_VPC_CONTEXT` | Any test that triggers `Vpc.fromLookup()` — set on app context before stack creation |

**VPC lookup context** — if your construct is used in stacks that call `ec2.Vpc.fromLookup()`, set the VPC context before instantiating the stack or the test will fail with CDK's default dummy AZs:

```ts
const app = createTestApp();
app.node.setContext(TEST_VPC_CONTEXT_KEY, TEST_VPC_CONTEXT);
const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV_EU });
```

## Step 7 — Verify

```bash
# TypeScript compile check
yarn --cwd infra tsc --noEmit

# Run the unit test in isolation
yarn --cwd infra jest tests/unit/constructs/<domain>/<construct-name>.test.ts

# Synthesise the target stack to confirm the construct renders valid CFN
npx cdk synth -c project=<project> -c environment=dev
```

## Verification checklist

- [ ] File in correct domain directory with kebab-case name
- [ ] Props interface exported alongside the class
- [ ] Inline `?? literal` defaults — no shared defaults object
- [ ] `enforceSSL`, `blockPublicAccess`, or equivalent security hardening applied
- [ ] Only `Component: <name>` tag added — org tags delegated to `TaggingAspect`
- [ ] Exported from domain `index.ts` and root `index.ts`
- [ ] Row added to `infra/lib/constructs/README.md` inventory table
- [ ] Unit test file at `infra/tests/unit/constructs/<domain>/`
- [ ] `createTestApp()` used — not bare `new cdk.App()`
- [ ] `Template.fromStack(stack)` assertions cover the primary resource and at least one validation path
- [ ] `yarn tsc --noEmit` passes with no errors
- [ ] `cdk synth` produces a valid template

<!--
Evidence trail (auto-generated):
- Source: infra/lib/constructs/README.md (read on 2026-04-29)
- Source: infra/lib/constructs/finops/budget-construct.ts (read on 2026-04-29)
- Source: infra/lib/constructs/storage/s3-bucket.ts (read on 2026-04-29)
- Source: infra/lib/constructs/networking/cloudfront.ts (read on 2026-04-29)
- Source: infra/tests/fixtures/test-app.ts (read on 2026-04-29)
- Source: infra/tests/fixtures/constants.ts (read on 2026-04-29)
- Source: infra/tests/unit/constructs/finops/budget-construct.test.ts (read on 2026-04-29)
-->
