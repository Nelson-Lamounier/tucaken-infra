# EKS Resource Optimisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate 5 idle Karpenter workload nodes by moving monitoring onto system nodes, enable bin-packing via `WhenUnderutilized`, and add dev scheduled auto-start/stop with Ireland DST-safe EventBridge Scheduler.

**Architecture:** Monitoring Helm charts in `kubernetes-bootstrap` gain `dedicated=system:NoSchedule` tolerations + preferred system node affinity; Karpenter NodePool switches to `WhenUnderutilized` (both envs); new `EksSchedulerStack` deploys two inline-Python Lambdas behind EventBridge Scheduler crons with `scheduleExpressionTimezone: Europe/Dublin` (dev only); Justfile adds `dev-start` and `dev-shutdown` recipes for manual override.

**Tech Stack:** AWS CDK v2 TypeScript, Python 3.14 Lambda (inline), AWS EventBridge Scheduler (`aws-cdk-lib/aws-scheduler`), Karpenter v1 NodePool CRD, Helm values YAML (kubernetes-bootstrap)

**Spec:** `docs/superpowers/specs/2026-05-07-eks-resource-optimisation-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `infra/lib/config/eks/configurations.ts` | Prod system node `t3.large` |
| Modify | `infra/lib/stacks/kubernetes/eks-karpenter-stack.ts` | `WhenUnderutilized`, `1m` |
| **Create** | `infra/lib/stacks/kubernetes/eks-scheduler-stack.ts` | Lambda + EventBridge Scheduler (dev only) |
| **Create** | `infra/tests/unit/kubernetes/eks-scheduler-stack.test.ts` | CDK assertions for scheduler stack |
| Modify | `infra/lib/projects/kubernetes/factory.ts` | Register `EksSchedulerStack` (dev only) |
| Modify | `justfile` | `dev-start`, `dev-shutdown` recipes |
| Modify | `kubernetes-bootstrap` (separate repo) | Monitoring chart tolerations + node affinity |

---

## Task 1: Prod system node t3.large

**Files:**
- Modify: `infra/lib/config/eks/configurations.ts:127`

- [ ] **Step 1: Open the file and locate the PRODUCTION mng config**

```bash
grep -n "PRODUCTION" infra/lib/config/eks/configurations.ts
```

Expected output includes a line like:
```
124:    [Environment.PRODUCTION]: {
127:        mng: { instanceTypes: ['t3.medium'], desiredSize: 3, minSize: 3, maxSize: 6, diskSizeGib: 30 },
```

- [ ] **Step 2: Change prod instance type**

In `infra/lib/config/eks/configurations.ts`, find line 127 and change:
```typescript
        mng: { instanceTypes: ['t3.medium'], desiredSize: 3, minSize: 3, maxSize: 6, diskSizeGib: 30 },
```
to:
```typescript
        mng: { instanceTypes: ['t3.large'], desiredSize: 3, minSize: 3, maxSize: 6, diskSizeGib: 30 },
```

- [ ] **Step 3: Verify CDK synth for production**

```bash
just synth kubernetes production 2>&1 | grep -E "error|warning|EksSystemNg"
```

Expected: no errors. `EksSystemNg-production` stack in output.

- [ ] **Step 4: Run lint and tests**

```bash
cd infra && npm run lint && npm test -- --testPathPattern="config" 2>&1 | tail -10
```

Expected: lint passes, existing config tests pass.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/config/eks/configurations.ts
git commit -m "feat(eks): upsize prod system nodes to t3.large for monitoring headroom"
```

---

## Task 2: Karpenter WhenUnderutilized (all environments)

**Files:**
- Modify: `infra/lib/stacks/kubernetes/eks-karpenter-stack.ts:187`

- [ ] **Step 1: Locate consolidation policy line**

```bash
grep -n "consolidationPolicy\|consolidateAfter" infra/lib/stacks/kubernetes/eks-karpenter-stack.ts
```

Expected:
```
187:                        disruption: { consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s' },
```

- [ ] **Step 2: Change consolidation policy**

In `infra/lib/stacks/kubernetes/eks-karpenter-stack.ts:187`, change:
```typescript
                        disruption: { consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s' },
```
to:
```typescript
                        disruption: { consolidationPolicy: 'WhenUnderutilized', consolidateAfter: '1m' },
```

- [ ] **Step 3: Verify CDK synth for development**

```bash
just synth kubernetes development 2>&1 | grep -E "error|EksKarpenter"
```

Expected: no errors.

- [ ] **Step 4: Run lint**

```bash
cd infra && npm run lint 2>&1 | tail -5
```

Expected: no output (clean exit).

- [ ] **Step 5: Commit**

```bash
git add infra/lib/stacks/kubernetes/eks-karpenter-stack.ts
git commit -m "feat(eks): switch Karpenter to WhenUnderutilized for bin-packing"
```

---

## Task 3: EksSchedulerStack — CDK stack + unit test

**Files:**
- Create: `infra/lib/stacks/kubernetes/eks-scheduler-stack.ts`
- Create: `infra/tests/unit/kubernetes/eks-scheduler-stack.test.ts`

`★ Insight ─────────────────────────────────────`
`aws-cdk-lib/aws-scheduler` exports only L1 constructs (`CfnSchedule`, `CfnScheduleGroup`). The L2 constructs live in the alpha package `@aws-cdk/aws-scheduler-alpha` — do NOT add that package. Use `CfnSchedule` directly. The `scheduleExpressionTimezone` property on `CfnSchedule` is what makes DST-safe scheduling possible.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write the failing test first**

Create `infra/tests/unit/kubernetes/eks-scheduler-stack.test.ts`:

```typescript
/**
 * @format
 * EksSchedulerStack unit tests — CDK assertions.
 * Validates Lambda runtime, EventBridge Scheduler timezone, and IAM scope.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import { EksSchedulerStack } from '../../../lib/stacks/kubernetes/eks-scheduler-stack';

function buildStack(): Template {
    const app = new cdk.App();
    const env = { account: '123456789012', region: 'eu-west-1' };

    const clusterStack = new cdk.Stack(app, 'ClusterStack', { env });
    const cluster = eks.Cluster.fromClusterAttributes(clusterStack, 'Cluster', {
        clusterName: 'k8s-eks-development',
        clusterArn: `arn:aws:eks:eu-west-1:123456789012:cluster/k8s-eks-development`,
        kubectlRoleArn: `arn:aws:iam::123456789012:role/kubectl-role`,
    });

    const schedulerStack = new EksSchedulerStack(app, 'SchedulerStack', {
        env,
        cluster,
        nodeGroupName: 'system-ng',
    });

    return Template.fromStack(schedulerStack);
}

describe('EksSchedulerStack', () => {
    let template: Template;

    beforeAll(() => {
        template = buildStack();
    });

    it('creates two Lambda functions with PYTHON_3_14 runtime', () => {
        template.resourceCountIs('AWS::Lambda::Function', 2);
        template.allResourcesProperties('AWS::Lambda::Function', {
            Runtime: 'python3.14',
        });
    });

    it('creates scale-up schedule with Europe/Dublin timezone at 4am', () => {
        template.hasResourceProperties('AWS::Scheduler::Schedule', {
            ScheduleExpression: 'cron(0 4 * * ? *)',
            ScheduleExpressionTimezone: 'Europe/Dublin',
        });
    });

    it('creates scale-down schedule with Europe/Dublin timezone at 11pm', () => {
        template.hasResourceProperties('AWS::Scheduler::Schedule', {
            ScheduleExpression: 'cron(0 23 * * ? *)',
            ScheduleExpressionTimezone: 'Europe/Dublin',
        });
    });

    it('Lambda execution role has eks:UpdateNodegroupConfig', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: expect.arrayContaining([
                    expect.objectContaining({
                        Action: expect.arrayContaining(['eks:UpdateNodegroupConfig']),
                    }),
                ]),
            },
        });
    });

    it('Lambda execution role scopes ec2:TerminateInstances to workload tag', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: expect.arrayContaining([
                    expect.objectContaining({
                        Action: 'ec2:TerminateInstances',
                        Condition: {
                            StringEquals: {
                                'ec2:ResourceTag/eks-cluster-pool': 'workloads-default',
                            },
                        },
                    }),
                ]),
            },
        });
    });
});
```

- [ ] **Step 2: Run test — verify it fails with "Cannot find module"**

```bash
cd infra && npm test -- --testPathPattern="eks-scheduler-stack" 2>&1 | tail -10
```

Expected: `Cannot find module '../../../lib/stacks/kubernetes/eks-scheduler-stack'`

- [ ] **Step 3: Create the EksSchedulerStack**

Create `infra/lib/stacks/kubernetes/eks-scheduler-stack.ts`:

```typescript
/**
 * @format
 * EKS Scheduler Stack — dev-only EventBridge Scheduler for auto start/stop.
 *
 * Provisions two Lambda functions (scale-up, scale-down) invoked by
 * EventBridge Scheduler on Europe/Dublin cron schedules:
 *   - Scale-up:   04:00 daily  → MNG minSize=3, desiredSize=3
 *   - Scale-down: 23:00 daily  → MNG minSize=0, desiredSize=0 + terminate
 *                                 any Karpenter workload EC2 instances
 *
 * Only instantiated for Environment.DEVELOPMENT (factory gate).
 *
 * @see docs/superpowers/specs/2026-05-07-eks-resource-optimisation-design.md §§ 3.4, 3.5
 */
import { NagSuppressions } from 'cdk-nag';

import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export interface EksSchedulerStackProps extends cdk.StackProps {
    readonly cluster: eks.ICluster;
    /** CDK token for the system MNG node group name (from EksSystemNodeGroupStack.nodeGroup.nodegroupName). */
    readonly nodeGroupName: string;
}

export class EksSchedulerStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksSchedulerStackProps) {
        super(scope, id, props);

        const { cluster, nodeGroupName } = props;

        const lambdaRole = new iam.Role(this, 'SchedulerLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AWSLambdaBasicExecutionRole',
                ),
            ],
        });

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'eks:UpdateNodegroupConfig',
                    'eks:DescribeNodegroup',
                    'eks:ListNodegroups',
                ],
                resources: [
                    cluster.clusterArn,
                    `${cluster.clusterArn}/nodegroup/*`,
                ],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['ec2:DescribeInstances'],
                resources: ['*'],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['ec2:TerminateInstances'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'ec2:ResourceTag/eks-cluster-pool': 'workloads-default',
                    },
                },
            }),
        );

        // DescribeInstances requires * — no resource-level restriction exists for Describe APIs.
        NagSuppressions.addResourceSuppressions(lambdaRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'ec2:DescribeInstances has no resource-level restriction in IAM. ' +
                        'ec2:TerminateInstances is tag-conditioned to eks-cluster-pool=workloads-default.',
                appliesTo: ['Resource::*'],
            },
        ], true);

        const commonEnv = {
            CLUSTER_NAME: cluster.clusterName,
            NODEGROUP_NAME: nodeGroupName,
        };

        const scaleUpFn = new lambda.Function(this, 'ScaleUpFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(1),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, os, logging
log = logging.getLogger()
log.setLevel(logging.INFO)

def handler(event, context):
    region = os.environ['AWS_REGION']
    client = boto3.client('eks', region_name=region)
    client.update_nodegroup_config(
        clusterName=os.environ['CLUSTER_NAME'],
        nodegroupName=os.environ['NODEGROUP_NAME'],
        scalingConfig={'minSize': 3, 'desiredSize': 3, 'maxSize': 4},
    )
    log.info('Scaled MNG to 3')
    return {'status': 'scaled-up'}
`),
        });

        const scaleDownFn = new lambda.Function(this, 'ScaleDownFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, os, logging
log = logging.getLogger()
log.setLevel(logging.INFO)

def handler(event, context):
    region = os.environ['AWS_REGION']
    eks = boto3.client('eks', region_name=region)
    ec2 = boto3.client('ec2', region_name=region)
    eks.update_nodegroup_config(
        clusterName=os.environ['CLUSTER_NAME'],
        nodegroupName=os.environ['NODEGROUP_NAME'],
        scalingConfig={'minSize': 0, 'desiredSize': 0, 'maxSize': 4},
    )
    log.info('Scaled MNG to 0')
    resp = ec2.describe_instances(
        Filters=[
            {'Name': 'tag:eks-cluster-pool', 'Values': ['workloads-default']},
            {'Name': 'instance-state-name', 'Values': ['running']},
        ]
    )
    ids = [i['InstanceId'] for r in resp['Reservations'] for i in r['Instances']]
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        log.info('Terminated: %s', ids)
    return {'terminated': ids}
`),
        });

        const schedulerRole = new iam.Role(this, 'SchedulerRole', {
            assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
        });

        schedulerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['lambda:InvokeFunction'],
                resources: [scaleUpFn.functionArn, scaleDownFn.functionArn],
            }),
        );

        new scheduler.CfnSchedule(this, 'ScaleUpSchedule', {
            scheduleExpression: 'cron(0 4 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleUpFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });

        new scheduler.CfnSchedule(this, 'ScaleDownSchedule', {
            scheduleExpression: 'cron(0 23 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleDownFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });
    }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd infra && npm test -- --testPathPattern="eks-scheduler-stack" 2>&1 | tail -15
```

Expected: 5 passing tests, 0 failing.

- [ ] **Step 5: Run lint**

```bash
cd infra && npm run lint 2>&1 | tail -5
```

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/stacks/kubernetes/eks-scheduler-stack.ts \
        infra/tests/unit/kubernetes/eks-scheduler-stack.test.ts
git commit -m "feat(eks): add EksSchedulerStack with EventBridge auto start/stop for dev"
```

---

## Task 4: Register EksSchedulerStack in factory (dev only)

**Files:**
- Modify: `infra/lib/projects/kubernetes/factory.ts`

- [ ] **Step 1: Add import**

In `infra/lib/projects/kubernetes/factory.ts`, add to the existing import block (after the last EKS stack import):

```typescript
import { EksSchedulerStack } from '../stacks/kubernetes/eks-scheduler-stack';
```

- [ ] **Step 2: Instantiate EksSchedulerStack after eksKarp**

In `factory.ts`, locate the line `stacks.push(eksKarp); stackMap.eksKarpenter = eksKarp;` and add immediately after it:

```typescript
        if (environment === Environment.DEVELOPMENT) {
            const eksScheduler = new EksSchedulerStack(
                scope,
                stackId(this.namespace, 'EksScheduler', environment),
                {
                    env,
                    cluster: eksClusterStack.cluster,
                    nodeGroupName: eksSystemNg.nodeGroup.nodegroupName,
                },
            );
            eksScheduler.addDependency(eksSystemNg);
            stacks.push(eksScheduler); stackMap.eksScheduler = eksScheduler;
        }
```

- [ ] **Step 3: Verify CDK synth — dev includes scheduler, prod does not**

```bash
just synth kubernetes development 2>&1 | grep -E "EksScheduler|error"
```

Expected: `EksScheduler-development` in output, no errors.

```bash
just synth kubernetes production 2>&1 | grep -E "EksScheduler|error"
```

Expected: `EksScheduler` NOT in output.

- [ ] **Step 4: Run full test suite**

```bash
cd infra && npm test 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Run lint**

```bash
cd infra && npm run lint 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/projects/kubernetes/factory.ts
git commit -m "feat(eks): register EksSchedulerStack in factory for development only"
```

---

## Task 5: Justfile dev-start and dev-shutdown

**Files:**
- Modify: `justfile`

- [ ] **Step 1: Locate the end of the CDK section in justfile**

```bash
grep -n "^\[group\|^synth\|^deploy\|^diff\|^destroy" justfile | head -15
```

Note the last CDK-group recipe line number.

- [ ] **Step 2: Add dev-start and dev-shutdown recipes**

Add the following block after the existing `destroy` recipe (or at the end of the CDK group):

```just
# Scale dev EKS cluster up (manual override — auto-start runs at 04:00 Dublin time)
[group('eks')]
dev-start env='development':
    #!/usr/bin/env bash
    set -euo pipefail
    CLUSTER="k8s-eks-{{env}}"
    PROFILE=$(just _profile {{env}})
    NG=$(aws eks list-nodegroups --cluster-name "$CLUSTER" \
         --region eu-west-1 --profile "$PROFILE" \
         --query 'nodegroups[0]' --output text)
    aws eks update-nodegroup-config --cluster-name "$CLUSTER" \
         --nodegroup-name "$NG" \
         --scaling-config minSize=3,maxSize=4,desiredSize=3 \
         --region eu-west-1 --profile "$PROFILE"
    @echo "Cluster starting — system nodes ready in ~3 min"

# Scale dev EKS cluster down immediately (use before 23:00 Dublin backstop)
[group('eks')]
dev-shutdown env='development':
    #!/usr/bin/env bash
    set -euo pipefail
    CLUSTER="k8s-eks-{{env}}"
    PROFILE=$(just _profile {{env}})
    NG=$(aws eks list-nodegroups --cluster-name "$CLUSTER" \
         --region eu-west-1 --profile "$PROFILE" \
         --query 'nodegroups[0]' --output text)
    aws eks update-nodegroup-config --cluster-name "$CLUSTER" \
         --nodegroup-name "$NG" \
         --scaling-config minSize=0,maxSize=4,desiredSize=0 \
         --region eu-west-1 --profile "$PROFILE"
    INSTANCES=$(aws ec2 describe-instances \
         --filters "Name=tag:eks-cluster-pool,Values=workloads-default" \
                   "Name=instance-state-name,Values=running" \
         --query 'Reservations[].Instances[].InstanceId' \
         --output text --region eu-west-1 --profile "$PROFILE")
    if [ -n "$INSTANCES" ]; then
        aws ec2 terminate-instances --instance-ids $INSTANCES \
             --region eu-west-1 --profile "$PROFILE"
        @echo "Workload nodes terminated: $INSTANCES"
    fi
    @echo "Cluster shutting down"
```

- [ ] **Step 3: Verify just can parse the justfile**

```bash
just --list 2>&1 | grep -E "dev-start|dev-shutdown"
```

Expected:
```
dev-start   env='development'   Scale dev EKS cluster up ...
dev-shutdown env='development'  Scale dev EKS cluster down ...
```

- [ ] **Step 4: Dry-run syntax check (no AWS call)**

```bash
just --dry-run dev-shutdown 2>&1 | head -5
```

Expected: shows the bash commands without executing them.

- [ ] **Step 5: Run lint**

```bash
cd infra && npm run lint 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add justfile
git commit -m "feat(eks): add dev-start and dev-shutdown recipes for manual cluster control"
```

---

## Task 6: Monitoring tolerations in kubernetes-bootstrap

> **Repo:** `kubernetes-bootstrap` — this is a separate repository. Switch to it before this task.

**Files (in kubernetes-bootstrap):**
- Modify: Helm values file for each monitoring chart (Prometheus, Grafana, Loki, Tempo, Pyroscope)
- Charts are under `argocd-apps/eks/` — locate them with `find . -name "*.yaml" | xargs grep -l "kube-prometheus\|grafana\|loki\|tempo\|pyroscope" | grep -v _deprecated`

- [ ] **Step 1: Locate all monitoring chart values files**

```bash
find argocd-apps/eks -name "*.yaml" | xargs grep -l "kube-prometheus\|grafana\|loki\|tempo\|pyroscope" 2>/dev/null
```

Note the file paths. There will typically be one values file or ArgoCD Application manifest per chart.

- [ ] **Step 2: Add tolerations + node affinity to each chart**

For each chart's Helm values section, add the following under the chart's root key. The exact indentation depends on how each chart's values are structured (top-level `values:` in an ArgoCD Application, or a standalone values file).

**kube-prometheus-stack (Prometheus + Alertmanager):**
```yaml
prometheus:
  prometheusSpec:
    tolerations:
      - key: dedicated
        operator: Equal
        value: system
        effect: NoSchedule
    affinity:
      nodeAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
                - key: node-role
                  operator: In
                  values: [system]
alertmanager:
  alertmanagerSpec:
    tolerations:
      - key: dedicated
        operator: Equal
        value: system
        effect: NoSchedule
    affinity:
      nodeAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
                - key: node-role
                  operator: In
                  values: [system]
```

**Grafana (within kube-prometheus-stack or standalone):**
```yaml
grafana:
  tolerations:
    - key: dedicated
      operator: Equal
      value: system
      effect: NoSchedule
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: node-role
                operator: In
                values: [system]
```

**Loki:**
```yaml
tolerations:
  - key: dedicated
    operator: Equal
    value: system
    effect: NoSchedule
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
            - key: node-role
              operator: In
              values: [system]
```

**Tempo** (same pattern as Loki):
```yaml
tolerations:
  - key: dedicated
    operator: Equal
    value: system
    effect: NoSchedule
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
            - key: node-role
              operator: In
              values: [system]
```

**Pyroscope** (same pattern):
```yaml
tolerations:
  - key: dedicated
    operator: Equal
    value: system
    effect: NoSchedule
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
            - key: node-role
              operator: In
              values: [system]
```

- [ ] **Step 3: Validate YAML syntax for each changed file**

```bash
# Run for each modified file
python3 -c "import yaml, sys; yaml.safe_load(open(sys.argv[1]))" <path-to-file>
```

Expected: no output (no error).

- [ ] **Step 4: Commit in kubernetes-bootstrap**

```bash
git add <modified-values-files>
git commit -m "feat(monitoring): add system node tolerations and affinity to monitoring charts

Monitoring pods (Prometheus, Grafana, Loki, Tempo, Pyroscope) now prefer
system nodes (node-role=system, tolerates dedicated=system:NoSchedule).
Eliminates 5 idle Karpenter workload nodes that were kept alive by monitoring
pods. Affinity is preferred (not required) — falls back to workload nodes if
system nodes are at capacity."
```

---

## Verification: End-to-End Check

After deploying all CDK changes and ArgoCD syncing the monitoring charts:

- [ ] **Check node count drops to 3 (system only)**

```bash
kubectl get nodes --context <dev-context>
```

Expected: 3 nodes, all with label `node-role=system`.

- [ ] **Check monitoring pods land on system nodes**

```bash
kubectl get pods -n monitoring -o wide --context <dev-context>
```

Expected: all pods in `NODE` column show system node names.

- [ ] **Run dev-shutdown and confirm all nodes terminate**

```bash
just dev-shutdown development
sleep 120
kubectl get nodes --context <dev-context>
```

Expected: `The connection to the server was refused` (cluster is down).

- [ ] **Run dev-start and confirm cluster recovers**

```bash
just dev-start development
sleep 180
kubectl get nodes --context <dev-context>
```

Expected: 3 nodes in `Ready` state.
