---
title: Project Factory Pattern
type: pattern
tags: [aws-cdk, typescript, factory-pattern, infrastructure-as-code, multi-project]
sources:
  - infra/lib/factories/project-interfaces.ts
  - infra/lib/factories/project-registry.ts
  - infra/lib/projects/kubernetes/factory.ts
  - infra/lib/projects/shared/factory.ts
  - infra/lib/projects/org/factory.ts
  - infra/bin/app.ts
  - infra/lib/config/projects.ts
created: 2026-04-28
updated: 2026-04-28
---

# Project Factory Pattern

## Problem it solves

A CDK codebase that hosts multiple independent projects (Kubernetes platform, shared networking, org governance) against the same AWS account tree has a structural problem: a single `app.ts` that instantiates every stack for every project becomes a coupling point. Adding a Next.js stack forces a synth of the K8s cluster. A compliance aspect that touches one project risks drifting into another.

The naive alternatives are worse:

| Approach | Problem |
|---|---|
| One `app.ts` with all stacks hardcoded | Single `cdk synth` assembles everything — slow, leaks cross-project coupling |
| Separate CDK apps per project | Duplicated `app.ts` boilerplate, divergent aspect application, impossible to share the VPC cleanly |
| Context flags `if (project === 'kubernetes')` | Conditional spaghetti — the entry point starts accumulating project-specific logic |

The factory pattern addresses all three: `app.ts` stays at ~105 lines, each project is fully encapsulated, and cross-cutting concerns (CDK-Nag, tagging) apply uniformly to whatever stacks the factory returns.

## How it works

### 1. Entry point — slim orchestrator

`infra/bin/app.ts` parses two context values and nothing else:

```typescript
const factory = getProjectFactoryFromContext(projectContext, environment);
const { stacks } = factory.createAllStacks(app, { environment });
```

All config resolution (domain names, VPC lookups, email addresses, SSM paths) happens inside the factory. `app.ts` never reads `process.env.DOMAIN_NAME` — it delegates everything.

### 2. Registry — the routing table

`infra/lib/factories/project-registry.ts` maps each `Project` enum value to a constructor:

```typescript
const projectFactoryRegistry: Record<Project, ProjectFactoryConstructor> = {
    [Project.SHARED]:     SharedProjectFactory,
    [Project.ORG]:        OrgProjectFactory,
    [Project.KUBERNETES]: KubernetesProjectFactory,
};
```

`getProjectFactory(project, environment)` instantiates the correct class. `getProjectFactoryFromContext(str, str)` handles string parsing, short-name resolution (`dev` → `development`), and validation.

### 3. Interface contract

Every factory implements `IProjectFactory<TContext>`:

```typescript
export interface IProjectFactory<TContext extends ProjectFactoryContext = ProjectFactoryContext> {
    readonly project: Project;
    readonly environment: Environment;
    readonly namespace: string;
    createAllStacks(scope: cdk.App, context: TContext): ProjectStackFamily;
}
```

`ProjectStackFamily` returns `{ stacks: cdk.Stack[], stackMap: Record<string, cdk.Stack> }`. The `stackMap` is consumed by `app.ts` to apply cross-cutting aspects and by CI workflows to extract stack names programmatically.

### 4. Typed factory context

Each factory defines its own `TContext` extending `ProjectFactoryContext`:

```typescript
// infra/lib/projects/kubernetes/factory.ts
export interface KubernetesFactoryContext extends ProjectFactoryContext {
    readonly environment: Environment;
    readonly domainName?: string;
    readonly hostedZoneId?: string;
    readonly crossAccountRoleArn?: string;
    readonly subjectAlternativeNames?: string[];
    readonly notificationEmail?: string;
    // ...
}
```

Context overrides come from CDK context (`-c domainName=...`) or fall back to typed config objects that read from `process.env`. No raw `process.env` access in `app.ts` — only in the factory's config resolution layer.

### 5. Cross-cutting aspects — applied after factories

After `createAllStacks` returns, `app.ts` iterates over all stacks and applies aspects uniformly:

```typescript
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

`INFRA_VERSION` is intentionally stable (not a git SHA). Changing it mutates the `version` tag on Launch Templates, which creates a new LT version and triggers a rolling ASG instance replacement — only bump when intentionally releasing infra changes.

CDK-Nag compliance checks (`applyCdkNag`, `applyCommonSuppressions`) run on the assembled app, covering all stacks from all factories in one pass.

## Stack dependency management

Within a factory, stack dependencies are declared explicitly with `addDependency`:

```typescript
controlPlaneStack.addDependency(baseStack);
generalPoolStack.addDependency(controlPlaneStack);
appIamStack.addDependency(controlPlaneStack);
platformRdsStack.addDependency(baseStack);
```

This tells CloudFormation the deployment order. The factory's `createAllStacks` returns all stacks in creation order — `app.ts` receives them in that order but CDK resolves actual deploy sequencing from the declared dependencies.

## Adding a new project

### Step 1 — Extend the `Project` enum

`infra/lib/config/projects.ts`:

```typescript
export enum Project {
    SHARED     = 'shared',
    ORG        = 'org',
    KUBERNETES = 'kubernetes',
    MY_NEW     = 'my-new', // add here
}

export const PROJECT_CONFIGS: Record<Project, ProjectConfig> = {
    // ...existing entries...
    [Project.MY_NEW]: {
        displayName: 'My New Project',
        description: 'What this project does',
        namespace: 'MyNew',
        requiresSharedVpc: true,
    },
};
```

### Step 2 — Create the factory

`infra/lib/projects/my-new/factory.ts`:

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

        const myStack = new MyStack(scope, stackId(this.namespace, 'Main', context.environment), {
            targetEnvironment: context.environment,
            env: cdkEnvironment(context.environment),
        });
        stacks.push(myStack);
        stackMap.main = myStack;

        return { stacks, stackMap };
    }
}
```

### Step 3 — Register in the registry

`infra/lib/factories/project-registry.ts`:

```typescript
import { MyNewProjectFactory } from '../projects/my-new';

const projectFactoryRegistry: Record<Project, ProjectFactoryConstructor> = {
    // ...existing entries...
    [Project.MY_NEW]: MyNewProjectFactory,
};
```

### Step 4 — Add a deploy workflow

`.github/workflows/deploy-my-new.yml` using `_deploy-stack.yml` as the reusable caller:

```yaml
jobs:
  deploy-main:
    uses: ./.github/workflows/_deploy-stack.yml
    with:
      stack-name: MyNew-Main-development
      project: my-new
      environment: development
```

## Design gaps and open decisions

**No ADR for SSM-over-exports.** The decision to use SSM parameters instead of CloudFormation exports for cross-stack discovery is the most consequential architectural choice in the codebase, but has no formal ADR. See [SSM Cross-Stack Pattern](ssm-cross-stack-pattern.md).

**`KubernetesDataStack` still provisions DynamoDB** despite the Tucaken migration to Platform RDS. This is intentional — the DynamoDB table remains until Phase 5 decommission. The factory creates the stack in dependency order: Data → Base → ControlPlane.

**`desiredCapacity` intentionally absent** from worker ASG stacks. Setting it in CDK would reset the ASG to the CDK value on every `cdk deploy`, overriding Cluster Autoscaler decisions. The stacks set `minCapacity` and `maxCapacity` only; CA manages actual scaling.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/factories/project-interfaces.ts (read on 2026-04-28)
- Source: infra/lib/factories/project-registry.ts (read on 2026-04-28)
- Source: infra/lib/projects/kubernetes/factory.ts (read on 2026-04-28)
- Source: infra/lib/projects/shared/factory.ts (read on 2026-04-28)
- Source: infra/lib/projects/org/factory.ts (read on 2026-04-28)
- Source: infra/bin/app.ts (read on 2026-04-28)
- Source: infra/lib/config/projects.ts (read on 2026-04-28)
-->
