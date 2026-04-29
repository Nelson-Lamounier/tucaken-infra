# Phase 1 — Platform RDS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a single PostgreSQL 16 + pgvector RDS instance in the SharedVpc, fronted by PgBouncer, with ESO credential sync — unblocking all subsequent migration phases.

**Architecture:** `PlatformRdsStack` in `cdk-monitoring` places RDS in the existing SharedVpc PUBLIC subnets (the only subnets available) with `publiclyAccessible: false` and a security group restricted to the VPC CIDR. PgBouncer runs as a K8s Deployment in the `platform` namespace and is the sole connection endpoint for all pods. ESO syncs credentials from Secrets Manager into K8s Secrets before PgBouncer or any consumer starts.

**Tech Stack:** AWS CDK (TypeScript), PostgreSQL 16, pgvector, PgBouncer (bitnami/pgbouncer), External Secrets Operator, ArgoCD PostSync hooks.

---

## Pre-flight Gaps Found (migration doc corrections)

These gaps were found by reading the actual codebase before writing any code. The migration doc (`tucaken-migration.md`) must be updated in Task 1 before any implementation begins.

| Gap | What the plan said | Reality |
|---|---|---|
| Subnet type | `PRIVATE_WITH_EGRESS` | SharedVpc has **PUBLIC subnets only**. Use `SubnetType.PUBLIC` + `publiclyAccessible: false`. |
| Secret IAM scope | Implicit — assumed existing grants cover it | `secretsManagerPathPattern: nextjs-development/*` does NOT cover `k8s-development/platform-rds/*`. AppIamStack needs a new grant. |
| SSM path prefix | `/${props.namePrefix}/platform-rds/` | cdk-monitoring k8s project uses `/k8s/${environment}/`. Use `/k8s/development/platform-rds/`. |
| VPC lookup name | `props.vpcName` (generic) | Exact name: `shared-vpc-${environment}` (set by SharedVpcStack line 117). |
| PgBouncer namespace | Not specified | Deploy in `platform` namespace alongside ESO secrets. All consumers reference `pgbouncer.platform.svc.cluster.local`. |
| ESO store names | Not specified | SSM → `aws-ssm`, Secrets Manager → `aws-secretsmanager` (confirmed from `kubernetes-platform/charts/external-secrets-config/`). |

---

## File Map

### New files (create)
| File | Responsibility |
|---|---|
| `cdk-monitoring/infra/lib/stacks/kubernetes/platform-rds-stack.ts` | CDK stack: RDS instance, security group, SSM exports |
| `cdk-monitoring/infra/tests/unit/stacks/kubernetes/platform-rds-stack.test.ts` | CDK unit tests |
| `kubernetes-platform/charts/platform-rds/Chart.yaml` | Helm chart metadata |
| `kubernetes-platform/charts/platform-rds/values.yaml` | Chart defaults |
| `kubernetes-platform/charts/platform-rds/external-secrets/rds-credentials.yaml` | ESO: SM → K8s Secret (password) |
| `kubernetes-platform/charts/platform-rds/external-secrets/rds-config.yaml` | ESO: SSM → K8s ConfigMap (host/port/db) |
| `kubernetes-platform/charts/platform-rds/templates/namespace.yaml` | `platform` namespace |
| `kubernetes-platform/charts/platform-rds/templates/pgbouncer-deployment.yaml` | PgBouncer Deployment |
| `kubernetes-platform/charts/platform-rds/templates/pgbouncer-service.yaml` | PgBouncer ClusterIP Service |
| `kubernetes-platform/charts/platform-rds/templates/bootstrap-job.yaml` | ArgoCD PostSync hook: DDL bootstrap |
| `kubernetes-platform/charts/platform-rds/templates/bootstrap-rbac.yaml` | ServiceAccount + RBAC for bootstrap Job |
| `kubernetes-platform/argocd-apps/platform-rds.yaml` | ArgoCD Application |

### Modified files
| File | Change |
|---|---|
| `cdk-monitoring/infra/lib/stacks/kubernetes/index.ts` | Export `PlatformRdsStack` |
| `cdk-monitoring/infra/lib/projects/kubernetes/factory.ts` | Instantiate `PlatformRdsStack`, add secret path to AppIamStack |
| `cdk-monitoring/tucaken-migration.md` | Correct subnet type + SSM paths + add gap notes |

---

## Task 1: Correct the migration doc

**Files:**
- Modify: `cdk-monitoring/tucaken-migration.md`

- [ ] **Step 1.1: Fix subnet type in Section 5.1**

In `tucaken-migration.md` Section 5.1, replace:
```typescript
vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
```
with:
```typescript
// SharedVpc has PUBLIC subnets only (natGateways: 0, no PRIVATE_WITH_EGRESS).
// publiclyAccessible defaults to false — security group IS the firewall.
vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
publiclyAccessible: false,
```

- [ ] **Step 1.2: Fix SSM path prefix in Section 5.1**

Replace `/${props.namePrefix}/platform-rds/` with `/k8s/${props.targetEnvironment}/platform-rds/` throughout Section 5.

- [ ] **Step 1.3: Fix ESO manifest paths in Sections 5.3 and 7.3**

Replace:
```yaml
key: tucaken-development/platform-rds/credentials
```
with:
```yaml
key: k8s-development/platform-rds/credentials
```

Replace SSM path references from `/tucaken-development/platform-rds/` to `/k8s/development/platform-rds/`.

- [ ] **Step 1.4: Add gap notes table at top of Section 5**

Add the pre-flight gaps table from this plan's header into Section 5 of the migration doc so future readers understand why the code differs from naive expectations.

- [ ] **Step 1.5: Commit**

```bash
git add cdk-monitoring/tucaken-migration.md
git commit -m "docs: correct phase 1 gaps — subnet type, SSM paths, ESO secret refs"
```

---

## Task 2: CDK PlatformRdsStack — write test first

**Files:**
- Create: `cdk-monitoring/infra/tests/unit/stacks/kubernetes/platform-rds-stack.test.ts`

- [ ] **Step 2.1: Write the failing tests**

```typescript
/**
 * @format
 * PlatformRdsStack Unit Tests
 */
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { Environment } from '../../../../lib/config';
import { PlatformRdsStack } from '../../../../lib/stacks/kubernetes/platform-rds-stack';
import {
    TEST_ENV_EU,
    createTestApp,
    createMockVpc,
} from '../../../fixtures';

const TEST_ENV = Environment.DEVELOPMENT;

function createStack(overrides?: Partial<ConstructorParameters<typeof PlatformRdsStack>[2]>) {
    const app = createTestApp();
    // PlatformRdsStack needs a VPC — provide a mock to avoid context lookup
    const helperStack = new cdk.Stack(app, 'Helper', { env: TEST_ENV_EU });
    const vpc = createMockVpc(helperStack);

    const stack = new PlatformRdsStack(app, 'TestPlatformRdsStack', {
        targetEnvironment: TEST_ENV,
        vpc,
        namePrefix: 'k8s-development',
        databaseName: 'tucaken',
        env: TEST_ENV_EU,
        ...overrides,
    });
    return { stack, template: Template.fromStack(stack), app };
}

describe('PlatformRdsStack', () => {
    describe('RDS instance', () => {
        it('creates a PostgreSQL 16 instance', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                Engine: 'postgres',
                EngineVersion: Match.stringLikeRegexp('^16\\.'),
                DBInstanceClass: 'db.t4g.micro',
                DBName: 'tucaken',
                StorageEncrypted: true,
            });
        });

        it('is NOT publicly accessible', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                PubliclyAccessible: false,
            });
        });

        it('has deletion protection disabled in development', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::RDS::DBInstance', {
                DeletionProtection: false,
            });
        });
    });

    describe('Security group', () => {
        it('allows TCP 5432 inbound from VPC CIDR', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        IpProtocol: 'tcp',
                        FromPort: 5432,
                        ToPort: 5432,
                    }),
                ]),
            });
        });
    });

    describe('SSM parameters', () => {
        const ssmPaths = [
            '/k8s/development/platform-rds/host',
            '/k8s/development/platform-rds/port',
            '/k8s/development/platform-rds/database',
            '/k8s/development/platform-rds/user',
            '/k8s/development/platform-rds/secret-arn',
            '/k8s/development/platform-rds/sg-id',
        ];

        it.each(ssmPaths)('publishes SSM parameter %s', (path) => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: path,
                Type: 'String',
            });
        });
    });

    describe('Secrets Manager', () => {
        it('creates a generated secret for the RDS credentials', () => {
            const { template } = createStack();
            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Name: 'k8s-development/platform-rds/credentials',
            });
        });
    });
});
```

- [ ] **Step 2.2: Run tests and confirm they fail**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
yarn jest infra/tests/unit/stacks/kubernetes/platform-rds-stack.test.ts --no-coverage
```

Expected: `Cannot find module '../../../../lib/stacks/kubernetes/platform-rds-stack'`

---

## Task 3: CDK PlatformRdsStack — implement

**Files:**
- Create: `cdk-monitoring/infra/lib/stacks/kubernetes/platform-rds-stack.ts`

- [ ] **Step 3.1: Create the stack**

```typescript
/**
 * @format
 * Platform RDS Stack
 *
 * Single PostgreSQL 16 + pgvector instance in the SharedVpc.
 * Replaces RdsPgVectorStack from ai-applications.
 *
 * Placement: PUBLIC subnets (SharedVpc has no private subnets).
 * Access control: security group restricts port 5432 to VPC CIDR only.
 * publiclyAccessible: false (default) — not reachable from internet.
 *
 * All pods connect via PgBouncer (pgbouncer.platform.svc.cluster.local:5432).
 * PgBouncer maintains ≤20 server connections to RDS, multiplexed to 200 clients.
 */

import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

import { Environment, isProductionEnvironment, environmentRemovalPolicy } from '../config';

// =============================================================================
// PROPS
// =============================================================================

export interface PlatformRdsStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;
    /** VPC from BaseStack (SharedVpc) — passed directly to avoid cross-stack export */
    readonly vpc: ec2.IVpc;
    /** Name prefix for resources and SSM paths: e.g. 'k8s-development' */
    readonly namePrefix: string;
    /** PostgreSQL database name */
    readonly databaseName: string;
}

// =============================================================================
// STACK
// =============================================================================

export class PlatformRdsStack extends cdk.Stack {
    /** The RDS instance — used for dependency chaining */
    public readonly instance: rds.DatabaseInstance;
    /** Security group ID — published to SSM for consumer stacks */
    public readonly securityGroupId: string;

    constructor(scope: Construct, id: string, props: PlatformRdsStackProps) {
        super(scope, id, props);

        const { targetEnvironment, vpc, namePrefix, databaseName } = props;
        const isProduction = isProductionEnvironment(targetEnvironment);
        const removalPolicy = environmentRemovalPolicy(targetEnvironment);
        const ssmBase = `/k8s/${targetEnvironment}/platform-rds`;

        // =================================================================
        // SECURITY GROUP
        //
        // Restricts inbound 5432 to VPC CIDR only.
        // SharedVpc default CIDR: 10.0.0.0/16
        // No outbound restriction needed — RDS does not initiate connections.
        // =================================================================
        const dbSg = new ec2.SecurityGroup(this, 'PlatformRdsSg', {
            vpc,
            securityGroupName: `${namePrefix}-platform-rds`,
            description: 'Platform RDS — allow PostgreSQL from within VPC',
            allowAllOutbound: false,
        });

        dbSg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(5432),
            'PostgreSQL from VPC CIDR (K8s nodes + Lambda)',
        );

        this.securityGroupId = dbSg.securityGroupId;

        // =================================================================
        // RDS POSTGRESQL 16 + pgvector
        //
        // Subnet: PUBLIC (SharedVpc has no private subnets).
        // publiclyAccessible: false — not reachable from internet.
        //   The security group is the access boundary.
        //
        // Instance class:
        //   t4g.micro (1 vCPU, 1 GiB) → max_connections ≈ 85
        //   With PgBouncer in front, actual server connections ≤ 20.
        //   Upgrade to t4g.small only if PgBouncer is removed.
        //
        // pgvector extension is installed by the bootstrap Job (PostSync hook).
        // CDK cannot install extensions — they require a live DB connection.
        // =================================================================
        const credentials = rds.Credentials.fromGeneratedSecret('postgres', {
            secretName: `${namePrefix}/platform-rds/credentials`,
        });

        this.instance = new rds.DatabaseInstance(this, 'Instance', {
            instanceIdentifier: `${namePrefix}-platform-rds`,
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_16_3,
            }),
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.T4G,
                ec2.InstanceSize.MICRO,
            ),
            credentials,
            databaseName,
            vpc,
            // PUBLIC subnets — the only option in SharedVpc.
            // publiclyAccessible defaults to false for DB instances.
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            securityGroups: [dbSg],
            publiclyAccessible: false,
            storageEncrypted: true,
            multiAz: false,           // enable for production via override
            allocatedStorage: 20,
            maxAllocatedStorage: 100,
            backupRetention: cdk.Duration.days(isProduction ? 7 : 1),
            cloudwatchLogsExports: ['postgresql', 'upgrade'],
            deletionProtection: isProduction,
            removalPolicy,
        });

        // =================================================================
        // SSM PARAMETERS — consumed by pods via ESO
        //
        // Paths: /k8s/{environment}/platform-rds/{key}
        // ESO ClusterSecretStore 'aws-ssm' reads these.
        // =================================================================
        const ssmParams: Record<string, string> = {
            host:       this.instance.dbInstanceEndpointAddress,
            port:       this.instance.dbInstanceEndpointPort,
            database:   databaseName,
            user:       'postgres',
            'secret-arn': this.instance.secret!.secretArn,
            'sg-id':    dbSg.securityGroupId,
        };

        Object.entries(ssmParams).forEach(([key, value]) => {
            new ssm.StringParameter(this, `Ssm-${key}`, {
                parameterName: `${ssmBase}/${key}`,
                stringValue: value,
                tier: ssm.ParameterTier.STANDARD,
            });
        });

        // =================================================================
        // CDK-NAG SUPPRESSIONS
        // =================================================================
        NagSuppressions.addResourceSuppressions(this.instance, [
            {
                id: 'AwsSolutions-RDS3',
                reason: 'Multi-AZ disabled in non-production — enable in production config',
            },
            {
                id: 'AwsSolutions-RDS11',
                reason: 'Default PostgreSQL port 5432 — non-standard port adds no meaningful security',
            },
        ], true);

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/Instance/Secret/Resource`,
            [{
                id: 'AwsSolutions-SMG4',
                reason: 'Secret rotation deferred — schedule after Phase 2 migration is stable',
            }],
        );

        // =================================================================
        // CFN OUTPUTS (for visibility — no exportName to avoid cross-stack coupling)
        // =================================================================
        new cdk.CfnOutput(this, 'RdsEndpoint', {
            value: this.instance.dbInstanceEndpointAddress,
            description: 'Platform RDS endpoint — connect via PgBouncer, not directly',
        });

        new cdk.CfnOutput(this, 'SecretArn', {
            value: this.instance.secret!.secretArn,
            description: 'Platform RDS credentials secret ARN',
        });
    }
}
```

- [ ] **Step 3.2: Run tests — expect most to pass, debug any failures**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
yarn jest infra/tests/unit/stacks/kubernetes/platform-rds-stack.test.ts --no-coverage
```

Expected: all tests GREEN. If `createMockVpc` helper doesn't accept a plain `cdk.Stack`, adjust to use `createHelperStack` from fixtures.

- [ ] **Step 3.3: Commit**

```bash
git add infra/lib/stacks/kubernetes/platform-rds-stack.ts \
        infra/tests/unit/stacks/kubernetes/platform-rds-stack.test.ts
git commit -m "feat(infra): add PlatformRdsStack — PostgreSQL 16 + pgvector in SharedVpc"
```

---

## Task 4: Export from stacks index + update factory

**Files:**
- Modify: `cdk-monitoring/infra/lib/stacks/kubernetes/index.ts`
- Modify: `cdk-monitoring/infra/lib/projects/kubernetes/factory.ts`

- [ ] **Step 4.1: Export from stacks index**

Open `cdk-monitoring/infra/lib/stacks/kubernetes/index.ts` and add:

```typescript
export { PlatformRdsStack } from './platform-rds-stack';
export type { PlatformRdsStackProps } from './platform-rds-stack';
```

- [ ] **Step 4.2: Import in factory**

At the top of `factory.ts`, add `PlatformRdsStack` to the existing stacks import:

```typescript
import {
    // ... existing imports ...
    PlatformRdsStack,
} from '../../stacks/kubernetes';
```

- [ ] **Step 4.3: Instantiate PlatformRdsStack in factory**

After the `appIamStack` block (around line 430 in factory.ts), add:

```typescript
// =================================================================
// Stack 4b: PLATFORM RDS STACK
//
// Single PostgreSQL 16 + pgvector instance in SharedVpc.
// All AI pipeline Jobs, admin-api, and public-api connect via
// PgBouncer (pgbouncer.platform.svc.cluster.local:5432).
//
// Deployed as a sibling to AppIamStack — same dependency (BaseStack).
// The AppIamStack and PlatformRdsStack are independent; neither
// imports from the other. Cross-stack sharing is via SSM paths.
// =================================================================
const platformRdsStack = new PlatformRdsStack(
    scope,
    stackId(this.namespace, 'PlatformRds', environment),
    {
        targetEnvironment: environment,
        vpc: baseStack.vpc,
        namePrefix,
        databaseName: 'tucaken',
        env,
        description: `Platform PostgreSQL 16 + pgvector — Tucaken unified data store - ${environment}`,
    },
);
platformRdsStack.addDependency(baseStack);
stacks.push(platformRdsStack);
stackMap.platformRds = platformRdsStack;
```

- [ ] **Step 4.4: Fix the TypeScript error — stackMap type**

Find the `stackMap` type definition near the top of the factory's `createStacks` method and add:

```typescript
const stackMap: {
    // ... existing keys ...
    platformRds?: PlatformRdsStack;
} = {};
```

- [ ] **Step 4.5: Update AppIamStack to allow the new secret path**

In the `appIamStack` instantiation block in `factory.ts`, find `bedrockSecretsManagerPath` and change from a single string to an approach that also covers platform-rds. The AppIamStack only accepts one `bedrockSecretsManagerPath`. We need to extend it.

First, check if `AppIamStack` accepts multiple secret patterns — if it only accepts one, add a new optional prop `platformRdsSecretArn` or a second pattern. The cleanest fix is to add a new prop to `KubernetesAppIamStack`:

In `app-iam-stack.ts`, add to props interface:
```typescript
/** Additional Secrets Manager ARN patterns to grant GetSecretValue on */
readonly additionalSecretArns?: string[];
```

In the IAM policy block, after the existing `bedrockSecretsManagerPath` grant:
```typescript
if (props.additionalSecretArns && props.additionalSecretArns.length > 0) {
    workerRole.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: props.additionalSecretArns.map(
            arn => `arn:aws:secretsmanager:${region}:${account}:secret:${arn}`,
        ),
    }));
}
```

Then in factory.ts, add to the `appIamStack` instantiation:
```typescript
additionalSecretArns: [
    // Platform RDS credentials — used by ESO aws-secretsmanager store
    // ESO runs on the control plane node and uses the instance profile.
    `${namePrefix}/platform-rds/credentials-??????`,
],
```

- [ ] **Step 4.6: Run the full unit test suite**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
yarn jest infra/tests/unit --no-coverage 2>&1 | tail -30
```

Expected: all existing tests pass + new platform-rds tests pass. If factory test snapshots fail, update them: `yarn jest --updateSnapshot`.

- [ ] **Step 4.7: Run CDK synth**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
npx cdk synth -c project=k8s -c environment=development 2>&1 | grep -E "error|Error|PlatformRds|WARN" | head -30
```

Expected: `Stack Monitoring-PlatformRds-development` appears in the list, no errors.

- [ ] **Step 4.8: Commit**

```bash
git add infra/lib/stacks/kubernetes/index.ts \
        infra/lib/stacks/kubernetes/app-iam-stack.ts \
        infra/lib/projects/kubernetes/factory.ts
git commit -m "feat(infra): wire PlatformRdsStack into K8s factory + extend AppIam secret grants"
```

---

## Task 5: K8s Helm chart — namespace + ESO manifests

**Files:**
- Create: all `kubernetes-platform/charts/platform-rds/` files

- [ ] **Step 5.1: Create Chart.yaml**

```yaml
# kubernetes-platform/charts/platform-rds/Chart.yaml
apiVersion: v2
name: platform-rds
description: Platform RDS bootstrap — ESO secrets, PgBouncer, DDL bootstrap Job
type: application
version: 0.1.0
appVersion: "16.3"
```

- [ ] **Step 5.2: Create values.yaml**

```yaml
# kubernetes-platform/charts/platform-rds/values.yaml
namespace: platform

pgbouncer:
  image:
    repository: bitnami/pgbouncer
    tag: "1.23.1"
  poolMode: transaction
  maxClientConn: 200
  defaultPoolSize: 20
  replicas: 1

bootstrap:
  image:
    repository: ""   # set in values-development.yaml: <account>.dkr.ecr.eu-west-1.amazonaws.com/platform-rds-bootstrap
    tag: latest
  serviceAccountName: platform-rds-bootstrap-sa
```

- [ ] **Step 5.3: Create namespace manifest**

```yaml
# kubernetes-platform/charts/platform-rds/templates/namespace.yaml
# @format
# Namespace: platform
#
# Hosts: PgBouncer (connection pooler), platform-rds ESO secrets,
#        and the bootstrap Job. Isolated from application workloads.
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/managed-by: argocd
```

- [ ] **Step 5.4: Create ESO credentials manifest (Secrets Manager → K8s Secret)**

```yaml
# kubernetes-platform/charts/platform-rds/external-secrets/rds-credentials.yaml
# @format
# ExternalSecret: platform-rds-credentials
#
# Extracts the auto-generated RDS password from the Secrets Manager secret
# created by CDK Credentials.fromGeneratedSecret.
# Secret JSON: { "username": "postgres", "password": "<auto>", ... }
#
# ESO store: aws-secretsmanager (ambient EC2 instance profile auth)
# Secret path: k8s-development/platform-rds/credentials
# Namespace: platform
#
# Consumers: PgBouncer Deployment (POSTGRESQL_PASSWORD env var)
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: platform-rds-credentials
  namespace: platform
  annotations:
    kubernetes.io/description: "Platform RDS password from Secrets Manager"
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: platform-rds-credentials
    creationPolicy: Owner
    deletionPolicy: Delete
  data:
    - secretKey: PGPASSWORD
      remoteRef:
        key: k8s-development/platform-rds/credentials
        property: password
    - secretKey: PGUSER
      remoteRef:
        key: k8s-development/platform-rds/credentials
        property: username
```

- [ ] **Step 5.5: Create ESO config manifest (SSM → K8s Secret)**

```yaml
# kubernetes-platform/charts/platform-rds/external-secrets/rds-config.yaml
# @format
# ExternalSecret: platform-rds-config
#
# Pulls non-sensitive RDS connection parameters from SSM Parameter Store.
# SSM paths set by PlatformRdsStack under /k8s/{env}/platform-rds/{key}.
#
# ESO store: aws-ssm (ambient EC2 instance profile auth)
# Namespace: platform
#
# Consumers: PgBouncer, bootstrap Job, all application pods
# Key: PGHOST — the PgBouncer deployment reads this to know where RDS is.
# Application pods use pgbouncer.platform.svc.cluster.local:5432, NOT PGHOST.
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: platform-rds-config
  namespace: platform
  annotations:
    kubernetes.io/description: "Platform RDS connection config from SSM — non-sensitive"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-ssm
    kind: ClusterSecretStore
  target:
    name: platform-rds-config
    creationPolicy: Owner
    deletionPolicy: Delete
    template:
      type: Opaque
      data:
        PGHOST: "{{ .host }}"
        PGPORT: "{{ .port }}"
        PGDATABASE: "{{ .database }}"
        PGUSER: "{{ .user }}"
  data:
    - secretKey: host
      remoteRef:
        key: /k8s/development/platform-rds/host
    - secretKey: port
      remoteRef:
        key: /k8s/development/platform-rds/port
    - secretKey: database
      remoteRef:
        key: /k8s/development/platform-rds/database
    - secretKey: user
      remoteRef:
        key: /k8s/development/platform-rds/user
```

- [ ] **Step 5.6: Commit**

```bash
git add kubernetes-platform/charts/platform-rds/
git commit -m "feat(k8s): add platform-rds chart — namespace, ESO credentials + config manifests"
```

---

## Task 6: K8s PgBouncer

**Files:**
- Create: `kubernetes-platform/charts/platform-rds/templates/pgbouncer-deployment.yaml`
- Create: `kubernetes-platform/charts/platform-rds/templates/pgbouncer-service.yaml`

- [ ] **Step 6.1: Create PgBouncer Deployment**

```yaml
# kubernetes-platform/charts/platform-rds/templates/pgbouncer-deployment.yaml
# @format
# PgBouncer Deployment
#
# Connection pooler in front of Platform RDS.
# All pods in the cluster connect to pgbouncer.platform.svc.cluster.local:5432
# — NEVER directly to RDS.
#
# Pool mode: transaction (correct for stateless HTTP handlers)
# Max server connections: 20 (well under RDS t4g.micro limit of ~85)
# Max client connections: 200 (multiplexes all K8s pods)
#
# Credentials read from ESO-synced secrets — no hardcoded values.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbouncer
  namespace: {{ .Values.namespace }}
  labels:
    app: pgbouncer
    app.kubernetes.io/name: pgbouncer
    app.kubernetes.io/component: connection-pooler
spec:
  replicas: {{ .Values.pgbouncer.replicas }}
  selector:
    matchLabels:
      app: pgbouncer
  template:
    metadata:
      labels:
        app: pgbouncer
    spec:
      # PgBouncer must start AFTER ESO syncs both secrets
      initContainers:
      - name: wait-for-secrets
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          until kubectl get secret platform-rds-credentials -n platform 2>/dev/null && \
                kubectl get secret platform-rds-config -n platform 2>/dev/null; do
            echo "waiting for ESO secrets..."; sleep 5;
          done
      containers:
      - name: pgbouncer
        image: {{ .Values.pgbouncer.image.repository }}:{{ .Values.pgbouncer.image.tag }}
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRESQL_HOST
          valueFrom:
            secretKeyRef:
              name: platform-rds-config
              key: PGHOST
        - name: POSTGRESQL_PORT
          value: "5432"
        - name: POSTGRESQL_DATABASE
          valueFrom:
            secretKeyRef:
              name: platform-rds-config
              key: PGDATABASE
        - name: POSTGRESQL_USERNAME
          valueFrom:
            secretKeyRef:
              name: platform-rds-credentials
              key: PGUSER
        - name: POSTGRESQL_PASSWORD
          valueFrom:
            secretKeyRef:
              name: platform-rds-credentials
              key: PGPASSWORD
        - name: PGBOUNCER_POOL_MODE
          value: {{ .Values.pgbouncer.poolMode }}
        - name: PGBOUNCER_MAX_CLIENT_CONN
          value: {{ .Values.pgbouncer.maxClientConn | quote }}
        - name: PGBOUNCER_DEFAULT_POOL_SIZE
          value: {{ .Values.pgbouncer.defaultPoolSize | quote }}
        resources:
          requests:
            cpu: 10m
            memory: 32Mi
          limits:
            cpu: 100m
            memory: 64Mi
        livenessProbe:
          tcpSocket:
            port: 5432
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          tcpSocket:
            port: 5432
          initialDelaySeconds: 5
          periodSeconds: 5
```

> **Note:** The `wait-for-secrets` initContainer uses `kubectl` which requires RBAC. Replace with a simpler approach — polling for the secret file to exist in a projected volume, OR use `secretRef` with `optional: false` (K8s will not start the pod until the secret exists). The `optional: false` approach is simpler:

Replace the initContainer block with nothing — instead, add to each `secretKeyRef`:
```yaml
secretKeyRef:
  name: platform-rds-credentials
  key: PGPASSWORD
  optional: false   # pod will not start until ESO creates this secret
```

`optional: false` is the K8s-native "wait for secret" mechanism. Remove the initContainer entirely.

- [ ] **Step 6.2: Create PgBouncer Service**

```yaml
# kubernetes-platform/charts/platform-rds/templates/pgbouncer-service.yaml
# @format
# Service: pgbouncer
#
# ClusterIP service exposing PgBouncer as the single database endpoint
# for all pods in the cluster.
#
# All application pods connect to:
#   pgbouncer.platform.svc.cluster.local:5432
#
# NEVER connect directly to the RDS endpoint.
apiVersion: v1
kind: Service
metadata:
  name: pgbouncer
  namespace: {{ .Values.namespace }}
  labels:
    app: pgbouncer
spec:
  type: ClusterIP
  selector:
    app: pgbouncer
  ports:
  - name: postgres
    port: 5432
    targetPort: 5432
    protocol: TCP
```

- [ ] **Step 6.3: Commit**

```bash
git add kubernetes-platform/charts/platform-rds/templates/pgbouncer-deployment.yaml \
        kubernetes-platform/charts/platform-rds/templates/pgbouncer-service.yaml
git commit -m "feat(k8s): add PgBouncer deployment + ClusterIP service in platform namespace"
```

---

## Task 7: K8s Bootstrap Job (DDL)

**Files:**
- Create: `kubernetes-platform/charts/platform-rds/templates/bootstrap-job.yaml`
- Create: `kubernetes-platform/charts/platform-rds/templates/bootstrap-rbac.yaml`

The bootstrap Job runs `CREATE EXTENSION IF NOT EXISTS vector` and the full DDL from migration doc Section 11. It runs as an ArgoCD PostSync hook so it fires after every ArgoCD sync — idempotent DDL means re-runs are safe.

The bootstrap image is a Node.js container with `pg` and the DDL script. Building this image is covered in Task 8 (bootstrap image).

- [ ] **Step 7.1: Create bootstrap RBAC**

```yaml
# kubernetes-platform/charts/platform-rds/templates/bootstrap-rbac.yaml
# @format
# ServiceAccount + ClusterRoleBinding for the bootstrap Job.
# Needs no cluster permissions — only needs the ESO-synced secrets
# in the platform namespace, which it gets via envFrom.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Values.bootstrap.serviceAccountName }}
  namespace: {{ .Values.namespace }}
  labels:
    app: platform-rds-bootstrap
```

- [ ] **Step 7.2: Create bootstrap Job**

```yaml
# kubernetes-platform/charts/platform-rds/templates/bootstrap-job.yaml
# @format
# Bootstrap Job — Platform RDS DDL
#
# Runs as ArgoCD PostSync hook:
#   argocd.argoproj.io/hook: PostSync
#   argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
#
# Idempotent DDL (CREATE TABLE IF NOT EXISTS, CREATE EXTENSION IF NOT EXISTS).
# Safe to re-run on every ArgoCD sync.
#
# Connects directly to RDS (not via PgBouncer) — PgBouncer may not be
# ready yet on first deploy. Uses platform-rds-config + platform-rds-credentials.
apiVersion: batch/v1
kind: Job
metadata:
  name: platform-rds-bootstrap
  namespace: {{ .Values.namespace }}
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
  labels:
    app: platform-rds-bootstrap
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 3
  activeDeadlineSeconds: 300
  template:
    metadata:
      labels:
        app: platform-rds-bootstrap
    spec:
      restartPolicy: OnFailure
      serviceAccountName: {{ .Values.bootstrap.serviceAccountName }}
      containers:
      - name: bootstrap
        image: {{ .Values.bootstrap.image.repository }}:{{ .Values.bootstrap.image.tag }}
        envFrom:
        - secretRef:
            name: platform-rds-credentials
            optional: false
        - secretRef:
            name: platform-rds-config
            optional: false
        resources:
          requests:
            cpu: 50m
            memory: 128Mi
          limits:
            cpu: 200m
            memory: 256Mi
```

- [ ] **Step 7.3: Create the bootstrap image source**

The bootstrap job needs a Docker image. Create a minimal Node.js script:

File: `ai-applications/applications/platform-rds-bootstrap/index.ts`

```typescript
/**
 * @format
 * Platform RDS Bootstrap — DDL runner
 *
 * Runs idempotent DDL: extensions, tables, indexes.
 * Exits 0 on success, 1 on error (K8s Job backoffLimit handles retries).
 *
 * Env vars (from ESO-synced secrets):
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 */
import { Pool } from 'pg';

const pool = new Pool({
    host:     process.env.PGHOST,
    port:     parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE,
    user:     process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl:      { rejectUnauthorized: false },
    max:      1,
    connectionTimeoutMillis: 10_000,
});

const DDL = `
-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Identity domain
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        UNIQUE NOT NULL,
  full_name         TEXT,
  avatar_url        TEXT,
  plan              TEXT        NOT NULL DEFAULT 'free',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_connections (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  provider_user_id  TEXT        NOT NULL,
  username          TEXT        NOT NULL,
  access_token_enc  TEXT        NOT NULL,
  scopes            TEXT[],
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- Knowledge domain
CREATE TABLE IF NOT EXISTS repositories (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  full_name         TEXT        NOT NULL,
  description       TEXT,
  primary_language  TEXT,
  topics            TEXT[],
  is_private        BOOLEAN     NOT NULL DEFAULT false,
  index_status      TEXT        NOT NULL DEFAULT 'pending',
  indexed_at        TIMESTAMPTZ,
  error_message     TEXT,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, full_name)
);

CREATE TABLE IF NOT EXISTS document_embeddings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT        NOT NULL,
  repo_full_name    TEXT        NOT NULL,
  file_path         TEXT        NOT NULL,
  heading           TEXT,
  content           TEXT        NOT NULL,
  content_tsv       TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  file_type         TEXT,
  tags              TEXT[],
  chunk_index       INTEGER     NOT NULL,
  total_chunks      INTEGER     NOT NULL,
  content_hash      TEXT        NOT NULL,
  embedding         vector(1024) NOT NULL,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repo_sync_state (
  user_id           TEXT        NOT NULL,
  repo_full_name    TEXT        NOT NULL,
  sync_status       TEXT        NOT NULL DEFAULT 'pending',
  last_synced_at    TIMESTAMPTZ,
  file_count        INTEGER     NOT NULL DEFAULT 0,
  chunk_count       INTEGER     NOT NULL DEFAULT 0,
  error_message     TEXT,
  PRIMARY KEY (user_id, repo_full_name)
);

-- Career domain
CREATE TABLE IF NOT EXISTS job_applications (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company           TEXT        NOT NULL,
  role              TEXT        NOT NULL,
  job_url           TEXT,
  job_description   TEXT        NOT NULL,
  job_description_tsv TSVECTOR  GENERATED ALWAYS AS (
    to_tsvector('english', company || ' ' || role || ' ' || job_description)
  ) STORED,
  kanban_status     TEXT        NOT NULL DEFAULT 'saved',
  applied_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resumes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_application_id UUID       REFERENCES job_applications(id) ON DELETE SET NULL,
  version           INTEGER     NOT NULL DEFAULT 1,
  content_json      JSONB       NOT NULL,
  rendered_html     TEXT,
  source_chunk_ids  UUID[],
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interview_stages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID       NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_type        TEXT        NOT NULL,
  scheduled_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  outcome           TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coaching_content (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID       NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_type        TEXT        NOT NULL,
  topics_to_study   JSONB,
  expected_questions JSONB,
  personal_highlights JSONB,
  source_chunk_ids  UUID[],
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_application_id, stage_type)
);

-- Content domain
CREATE TABLE IF NOT EXISTS articles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT        UNIQUE NOT NULL,
  title             TEXT        NOT NULL,
  excerpt           TEXT,
  content_md        TEXT        NOT NULL,
  content_tsv       TSVECTOR    GENERATED ALWAYS AS (
    to_tsvector('english', title || ' ' || COALESCE(excerpt,'') || ' ' || content_md)
  ) STORED,
  tags              TEXT[],
  author_id         UUID        REFERENCES users(id),
  status            TEXT        NOT NULL DEFAULT 'draft',
  ai_generated      BOOLEAN     NOT NULL DEFAULT false,
  ai_model          TEXT,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Platform domain
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id),
  pipeline_type     TEXT        NOT NULL,
  reference_id      TEXT,
  status            TEXT        NOT NULL DEFAULT 'queued',
  error_message     TEXT,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  key_hash          TEXT        NOT NULL UNIQUE,
  key_prefix        TEXT        NOT NULL,
  scopes            TEXT[],
  last_used_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_config (
  key               TEXT        PRIMARY KEY,
  value             JSONB       NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_audit_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id),
  repo_full_name    TEXT        NOT NULL,
  triggered_by      TEXT,
  status            TEXT        NOT NULL,
  duration_ms       INTEGER,
  chunks_embedded   INTEGER,
  chunks_skipped    INTEGER,
  chunks_pruned     INTEGER,
  error_message     TEXT,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_natural_key
  ON document_embeddings (user_id, repo_full_name, file_path, chunk_index);
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
  ON document_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_embeddings_content_tsv
  ON document_embeddings USING GIN (content_tsv);
CREATE INDEX IF NOT EXISTS idx_articles_slug   ON articles (slug);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_tags   ON articles USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_articles_tsv    ON articles USING GIN (content_tsv);
CREATE INDEX IF NOT EXISTS idx_job_apps_user   ON job_applications (user_id, kanban_status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs   ON pipeline_runs (user_id, pipeline_type, status);
`;

async function main() {
    console.log('Connecting to RDS...');
    const client = await pool.connect();
    try {
        console.log('Running DDL bootstrap...');
        await client.query(DDL);
        console.log('Bootstrap complete.');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
```

File: `ai-applications/applications/platform-rds-bootstrap/Dockerfile`

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production
COPY index.js ./
CMD ["node", "index.js"]
```

> **Note:** The TypeScript file needs to be compiled to `index.js` before building the Docker image. Add a `build` script to the package.json. This image is built and pushed to the `platform-rds-bootstrap` ECR repository (create in SharedVpcStack or use the existing admin-api ECR with a different image tag pattern).

- [ ] **Step 7.4: Commit**

```bash
git add kubernetes-platform/charts/platform-rds/templates/bootstrap-job.yaml \
        kubernetes-platform/charts/platform-rds/templates/bootstrap-rbac.yaml \
        ai-applications/applications/platform-rds-bootstrap/
git commit -m "feat(k8s): add bootstrap Job (ArgoCD PostSync) + DDL bootstrap image source"
```

---

## Task 8: ArgoCD Application

**Files:**
- Create: `kubernetes-platform/argocd-apps/platform-rds.yaml`

- [ ] **Step 8.1: Create ArgoCD Application**

```yaml
# kubernetes-platform/argocd-apps/platform-rds.yaml
# @format
# ArgoCD Application: platform-rds
#
# Deploys: namespace, ESO secrets, PgBouncer, bootstrap Job
# Sync wave: 0 — must be up before application workloads (wave 1+)
#
# The bootstrap Job runs as a PostSync hook after each sync.
# Idempotent DDL — safe on re-run.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: platform-rds
  namespace: argocd
  annotations:
    kubernetes.io/description: "Platform RDS — PgBouncer + ESO + DDL bootstrap"
    argocd.argoproj.io/sync-wave: "0"
  labels:
    app.kubernetes.io/part-of: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default

  source:
    repoURL: <YOUR_GITHUB_REPO_URL>
    targetRevision: HEAD
    path: charts/platform-rds

  destination:
    server: https://kubernetes.default.svc
    namespace: platform

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=true
      - PruneLast=true
      - ServerSideApply=true
    retry:
      limit: 3
      backoff:
        duration: 10s
        factor: 2
        maxDuration: 3m
```

- [ ] **Step 8.2: Commit**

```bash
git add kubernetes-platform/argocd-apps/platform-rds.yaml
git commit -m "feat(k8s): add ArgoCD Application for platform-rds chart"
```

---

## Task 9: Deploy and verify

- [ ] **Step 9.1: Deploy the CDK stack**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
npx cdk deploy Monitoring-PlatformRds-development \
  -c project=k8s -c environment=development \
  --require-approval broadening
```

Expected: Stack creates with ~6 resources (RDS, SG, SubnetGroup, Secret, 6x SSM params).

- [ ] **Step 9.2: Verify SSM parameters created**

```bash
aws ssm get-parameters-by-path \
  --path /k8s/development/platform-rds \
  --region eu-west-1 \
  --query 'Parameters[*].{Name:Name,Value:Value}' \
  --output table
```

Expected: host, port, database, user, secret-arn, sg-id all present.

- [ ] **Step 9.3: Verify RDS is not publicly accessible**

```bash
aws rds describe-db-instances \
  --db-instance-identifier k8s-development-platform-rds \
  --region eu-west-1 \
  --query 'DBInstances[0].{Status:DBInstanceStatus,Public:PubliclyAccessible,Endpoint:Endpoint.Address}' \
  --output table
```

Expected: `PubliclyAccessible: false`, `Status: available`.

- [ ] **Step 9.4: Deploy AppIamStack (secret grant update)**

```bash
npx cdk deploy Monitoring-AppIam-development \
  -c project=k8s -c environment=development \
  --require-approval broadening
```

- [ ] **Step 9.5: Push ArgoCD app + chart via git**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-platform
git add argocd-apps/platform-rds.yaml charts/platform-rds/
git commit -m "feat(k8s): platform-rds ArgoCD app + Helm chart"
git push
```

- [ ] **Step 9.6: Wait for ArgoCD sync and verify**

```bash
# Watch sync status
kubectl get applications -n argocd platform-rds -w

# After sync: confirm namespace exists
kubectl get ns platform

# Confirm ESO synced secrets
kubectl get secrets -n platform

# Confirm PgBouncer is running
kubectl get pods -n platform -l app=pgbouncer

# Confirm bootstrap Job completed
kubectl get jobs -n platform
kubectl logs -n platform job/platform-rds-bootstrap
```

Expected:
- `platform-rds-credentials` and `platform-rds-config` secrets exist
- PgBouncer pod is Running
- Bootstrap Job completed (status: Complete)

- [ ] **Step 9.7: Connectivity test from a debug pod**

```bash
kubectl run pg-debug --rm -it --restart=Never \
  --image=postgres:16-alpine \
  --env="PGPASSWORD=$(kubectl get secret platform-rds-credentials -n platform -o jsonpath='{.data.PGPASSWORD}' | base64 -d)" \
  -- psql -h pgbouncer.platform.svc.cluster.local -U postgres -d tucaken -c '\dt'
```

Expected: all tables listed (users, articles, job_applications, etc.).

- [ ] **Step 9.8: Verify pgvector extension**

```bash
kubectl run pg-debug --rm -it --restart=Never \
  --image=postgres:16-alpine \
  --env="PGPASSWORD=$(kubectl get secret platform-rds-credentials -n platform -o jsonpath='{.data.PGPASSWORD}' | base64 -d)" \
  -- psql -h pgbouncer.platform.svc.cluster.local -U postgres -d tucaken -c '\dx'
```

Expected: `vector` extension listed.

---

## Phase 1 Complete Checklist

```
☐ Migration doc gaps corrected (Task 1)
☐ PlatformRdsStack CDK written + tests green (Tasks 2-3)
☐ Factory wired + AppIam secret grant added (Task 4)
☐ K8s chart: namespace, ESO, PgBouncer, bootstrap Job (Tasks 5-7)
☐ ArgoCD Application created (Task 8)
☐ CDK deployed: RDS available, SSM params present (Task 9)
☐ ESO secrets synced in platform namespace
☐ PgBouncer pod running, service reachable
☐ Bootstrap Job completed, all tables + pgvector extension present
☐ Connectivity test from debug pod passes
```

**After all boxes checked:** Phase 2 (content migration) is unblocked.
