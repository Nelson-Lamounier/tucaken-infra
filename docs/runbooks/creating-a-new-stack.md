---
title: Creating a New CDK Stack
type: runbook
tags: [aws-cdk, typescript, infrastructure-as-code, factory-pattern, runbook]
sources:
  - infra/lib/factories/project-interfaces.ts
  - infra/lib/factories/project-registry.ts
  - infra/lib/config/projects.ts
  - infra/lib/config/ssm-paths.ts
  - infra/lib/constructs/ssm/ssm-parameter-store.ts
  - infra/lib/projects/kubernetes/factory.ts
  - .github/workflows/_deploy-kubernetes.yml
created: 2026-04-28
updated: 2026-04-28
---

# Creating a New CDK Stack

Step-by-step guide for adding a new stack to an existing project (most common case) or a new project. Every step is grounded in how the existing stacks in this repo are structured.

---

## Part A — Adding a stack to an existing project

This is the normal case. You have a new AWS service to provision that belongs to the `kubernetes` or `shared` project.

### Step 1 — Create the stack file

Create `infra/lib/stacks/{project}/my-stack.ts`. Follow the conventions from existing stacks:

```typescript
/**
 * @format
 * My Stack — one-line description of what this provisions
 *
 * Resources Created:
 *   - List the AWS resources here
 *
 * Resources Consumed (via SSM):
 *   - List what this stack reads from SSM
 */

import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { mySsmPaths } from '../../config/ssm-paths';      // define in Step 3
import { SsmParameterStoreConstruct } from '../../constructs/ssm';

export interface MyStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly namePrefix: string;
    // add only what this stack needs — do NOT pass things it can read from SSM
}

export class MyStack extends cdk.Stack {
    public readonly someOutput: string;

    constructor(scope: Construct, id: string, props: MyStackProps) {
        super(scope, id, props);
        const { targetEnvironment, namePrefix } = props;
        const ssmPaths = mySsmPaths(targetEnvironment);

        // === Create resources ===
        // ...

        // === Publish SSM outputs ===
        new SsmParameterStoreConstruct(this, 'SsmParams', {
            parameters: {
                [ssmPaths.someOutput]: this.someOutput,
            },
        });
    }
}
```

**Do not pass security group IDs, ARNs, or resource names from other stacks via props.** If a consumer stack needs a value from this stack, publish it to SSM and let the consumer read from SSM. See [SSM Cross-Stack Pattern](../patterns/ssm-cross-stack-pattern.md).

### Step 2 — Export from the index barrel

`infra/lib/stacks/{project}/index.ts`:

```typescript
export * from './my-stack';
```

### Step 3 — Add SSM paths

`infra/lib/config/ssm-paths.ts` — add a new interface and builder function:

```typescript
export interface MySsmPaths {
    readonly prefix: string;
    readonly someOutput: string;
    readonly wildcard: string;
}

export function mySsmPaths(environment: Environment): MySsmPaths {
    const prefix = `/my-service/${environment}`;
    return {
        prefix,
        someOutput: `${prefix}/some-output`,
        wildcard: `${prefix}/*`,
    };
}
```

Keep paths under a consistent namespace (e.g., `/k8s/{env}/my-resource/...` for K8s project stacks, `/shared/my-resource/{env}/...` for Shared stacks).

### Step 4 — Add to the project factory

Open the factory for the target project (e.g., `infra/lib/projects/kubernetes/factory.ts`) and add the stack inside `createAllStacks`:

```typescript
import { MyStack } from '../../stacks/kubernetes';

// Inside createAllStacks():
const myStack = new MyStack(
    scope,
    stackId(this.namespace, 'MyService', environment),
    {
        targetEnvironment: environment,
        namePrefix,
        env,
        description: `My service — ${environment}`,
    },
);
myStack.addDependency(baseStack);   // declare deploy order
stacks.push(myStack);
stackMap.myService = myStack;       // key used by CI workflow to extract stack name
```

**`addDependency` is required** if this stack reads SSM outputs from another stack. It tells CloudFormation to deploy the producer first. Without it, `ParameterNotFound` errors occur if both stacks deploy concurrently.

### Step 5 — Wire the deploy workflow

If this stack is part of the `kubernetes` project, add a deploy job to `_deploy-kubernetes.yml`:

```yaml
deploy-my-service:
  name: Deploy MyService
  needs: [verify-base]              # what must succeed before this runs
  uses: ./.github/workflows/_deploy-stack.yml
  with:
    stack-name: ${{ needs.setup.outputs.my-service-stack }}
    project: kubernetes
    environment: ${{ inputs.environment }}
    require-approval: ${{ inputs.require-approval }}
  secrets: inherit
```

Also add the stack name to the `setup` job's outputs in `_deploy-kubernetes.yml`:

```yaml
# In the setup job's outputs section:
my-service-stack: ${{ steps.synth.outputs.myService }}
```

The `synth` step runs `synthesize-ci.ts` which calls `factory.createAllStacks()` and emits stack names as outputs. The new key (`myService`) must match the `stackMap` key in the factory.

### Step 6 — Add CDK-Nag suppressions if needed

If CDK-Nag or Checkov flags a rule you've intentionally accepted, add a suppression with justification:

```typescript
import { NagSuppressions } from 'cdk-nag';

NagSuppressions.addStackSuppressions(this, [{
    id: 'AwsSolutions-RDS3',
    reason: 'Multi-AZ not required for dev environment portfolio project — cost optimization',
}]);
```

Do not suppress without a reason. The CI pipeline runs CDK-Nag and fails on unaddressed findings.

### Step 7 — Write documentation

Create `docs/projects/my-stack.md` or add a section to `docs/projects/cdk-platform-stacks.md` with:
- What it creates
- What problem it solves
- SSM outputs
- Dependencies

---

## Part B — Adding a new project

Use this when the new service has a fundamentally different lifecycle from the existing `kubernetes`, `shared`, or `org` projects.

### Step 1 — Extend the Project enum

`infra/lib/config/projects.ts`:

```typescript
export enum Project {
    SHARED     = 'shared',
    ORG        = 'org',
    KUBERNETES = 'kubernetes',
    MY_NEW     = 'my-new',
}

export const PROJECT_CONFIGS: Record<Project, ProjectConfig> = {
    // ...
    [Project.MY_NEW]: {
        displayName: 'My New Project',
        description: 'What this project does',
        namespace: 'MyNew',
        requiresSharedVpc: true,
    },
};
```

### Step 2 — Create the factory

`infra/lib/projects/my-new/factory.ts` — implement `IProjectFactory`:

```typescript
export class MyNewProjectFactory implements IProjectFactory {
    readonly project = Project.MY_NEW;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.MY_NEW).namespace;
    }

    createAllStacks(scope: cdk.App, context: ProjectFactoryContext): ProjectStackFamily {
        const stacks: cdk.Stack[] = [];
        const stackMap: Record<string, cdk.Stack> = {};
        const env = cdkEnvironment(context.environment);

        const myStack = new MyStack(scope, stackId(this.namespace, 'Main', context.environment), {
            targetEnvironment: context.environment,
            env,
        });
        stacks.push(myStack);
        stackMap.main = myStack;

        return { stacks, stackMap };
    }
}
```

Export: `infra/lib/projects/my-new/index.ts` → `export * from './factory'`
Export: `infra/lib/projects/index.ts` → `export * from './my-new'`

### Step 3 — Register in the registry

`infra/lib/factories/project-registry.ts`:

```typescript
import { MyNewProjectFactory } from '../projects/my-new';

const projectFactoryRegistry: Record<Project, ProjectFactoryConstructor> = {
    // ...
    [Project.MY_NEW]: MyNewProjectFactory,
};
```

### Step 4 — Create a deploy workflow

`.github/workflows/deploy-my-new.yml`:

```yaml
name: Deploy My New Project (Dev)

on:
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  deploy-main:
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: MyNew-Main-development
      project: my-new
      environment: development
      aws-account-id: ${{ vars.AWS_ACCOUNT_ID }}
    secrets:
      AWS_OIDC_ROLE: ${{ secrets.AWS_OIDC_ROLE }}
```

### Step 5 — Validate with CDK synth

```bash
npx cdk synth -c project=my-new -c environment=dev
```

Add this project to the `ci-synth-validate` job in `ci.yml` so it's validated on every PR.

---

## Checklist

Before opening a PR for a new stack:

- [ ] Stack file created in `infra/lib/stacks/{project}/`
- [ ] Exported from the project index barrel
- [ ] SSM path interface and builder added to `ssm-paths.ts`
- [ ] `SsmParameterStoreConstruct` used to publish all outputs
- [ ] Stack added to factory with `addDependency` calls
- [ ] `stackMap` key added (matches workflow output name)
- [ ] Deploy workflow wired with correct `needs:` dependency
- [ ] CDK-Nag suppressions added with justification (if any)
- [ ] `npx cdk synth` passes locally
- [ ] Documentation added to `docs/projects/cdk-platform-stacks.md`

## IaC context — why this structure matters for modern deployments

This pattern aligns with three modern IaC principles:

**Separation of concerns via independent lifecycle stacks.** Long-lived base infrastructure (VPC, SGs, KMS) and short-lived compute (EC2 ASG, Launch Template) deploy and evolve independently. This prevents the most common IaC anti-pattern: a single monolithic stack where updating an AMI forces recreation of a VPC.

**Policy-as-code in the delivery pipeline.** CDK-Nag runs on every synth in CI. Checkov scans CloudFormation templates. New stacks must pass both gates before merge. Security and compliance are not post-deployment audits — they are blocking PR checks.

**GitOps boundary.** CDK manages AWS-layer resources (IAM, RDS, ASGs, networking). ArgoCD manages Kubernetes-layer resources (Deployments, Services, Ingress, Secrets). New CDK stacks that provision AWS resources for a K8s workload follow this boundary: CDK creates the RDS instance and writes credentials to SSM, ArgoCD's ESO manifests (in `kubernetes-bootstrap`) read the SSM params and inject them into pods. CDK never manages pod specs; ArgoCD never manages RDS instances.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/factories/project-interfaces.ts (read on 2026-04-28)
- Source: infra/lib/factories/project-registry.ts (read on 2026-04-28)
- Source: infra/lib/config/projects.ts (read on 2026-04-28)
- Source: infra/lib/config/ssm-paths.ts (read on 2026-04-28)
- Source: infra/lib/constructs/ssm/ssm-parameter-store.ts (read on 2026-04-28)
- Source: infra/lib/projects/kubernetes/factory.ts (read on 2026-04-28)
- Source: .github/workflows/_deploy-kubernetes.yml (read on 2026-04-28)
-->
