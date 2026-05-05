# EKS Migration — Plan 2 / 6: Cluster Bootstrap (CDK Side)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision a fully functional EKS cluster in `development` via 6 new CDK stacks (Cluster, SystemNodeGroup, PodIdentity, Addons, Karpenter, Access) plus a subnet-retag update to `KubernetesBaseStack`. Acceptance: `cdk deploy` of the 6 stacks completes cleanly; system MNG joins the cluster; Pod Identity associations exist; Helm-installed addons (Karpenter, ESO, EBS CSI, ALB controller, external-dns, VPC CNI) reach `Healthy`; Karpenter provisions a `t3.large` node within 60s of a Pending pod.

**Architecture:** Six cohesive failure-isolated stacks (one CFN stream each). Cluster control plane is EKS-managed; system MNG of 3× t3.medium spread across 3 AZs hosts cluster-critical pods; workload nodes come from a single Karpenter `NodePool` (on-demand only, V1). Pod Identity Associations replace IRSA. VPC is the existing `Shared` VPC retagged for EKS subnet discovery (`kubernetes.io/role/{elb,internal-elb}`, `kubernetes.io/cluster/<name>: shared`). The kubeadm cluster keeps running in parallel — both clusters share the VPC during the cutover window.

**Tech Stack:** TypeScript, AWS CDK v2 (`aws-cdk-lib/aws-eks`), Helm via `eks.HelmChart`, Karpenter v1 CRDs, AWS Load Balancer Controller v2, AWS EKS Pod Identity (Nov 2023 GA).

**Parent spec:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md` §§ 3, 4, 5.1, 5.3, 7.1.

**Dependencies:** Plan 1 (account-id consolidation) must be complete — `process.env.AWS_ACCOUNT_ID` is the single source of truth.

---

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `infra/lib/config/eks/configurations.ts` | Per-env EKS config: cluster version, node instance types, Karpenter NodePool requirements, addon versions |
| `infra/lib/config/eks/index.ts` | Re-exports |
| `infra/lib/stacks/kubernetes/eks-cluster-stack.ts` | EKS cluster + cluster IAM role + KMS envelope key + log group |
| `infra/lib/stacks/kubernetes/eks-system-node-group-stack.ts` | Managed node group (3× t3.medium, AZ-spread, system taint) |
| `infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts` | `CfnPodIdentityAssociation` × N for kube-system service accounts |
| `infra/lib/stacks/kubernetes/eks-addons-stack.ts` | Helm charts: karpenter, aws-load-balancer-controller, external-dns, external-secrets, aws-ebs-csi-driver, vpc-cni (managed addon) |
| `infra/lib/stacks/kubernetes/eks-karpenter-stack.ts` | Karpenter `NodePool` + `EC2NodeClass` (CRDs as `KubernetesManifest`) + SQS interruption queue + EventBridge rules |
| `infra/lib/stacks/kubernetes/eks-access-stack.ts` | EKS Access Entries for GH OIDC role + admin role |
| `infra/tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts` | Cluster stack assertions |
| `infra/tests/unit/stacks/kubernetes/eks-system-node-group-stack.test.ts` | MNG stack assertions |
| `infra/tests/unit/stacks/kubernetes/eks-pod-identity-stack.test.ts` | PodId assertions |
| `infra/tests/unit/stacks/kubernetes/eks-addons-stack.test.ts` | Helm chart presence assertions |
| `infra/tests/unit/stacks/kubernetes/eks-karpenter-stack.test.ts` | NodePool / SQS assertions |
| `infra/tests/unit/stacks/kubernetes/eks-access-stack.test.ts` | Access entry assertions |

**Files to modify:**

| Path | Change |
|---|---|
| `infra/lib/stacks/kubernetes/base-stack.ts` | Add EKS subnet tags (`kubernetes.io/role/{elb,internal-elb}` + `kubernetes.io/cluster/<eksClusterName>: shared`) on existing public/private subnets. Add new `eks-workers-<env>` security group. |
| `infra/lib/stacks/kubernetes/index.ts` | Re-export the six new stacks |
| `infra/lib/projects/kubernetes/factory.ts` | Wire the six new stacks in dependency order; instantiate after `controlPlaneStack` so kubeadm cluster keeps working |
| `infra/lib/config/kubernetes/configurations.ts` | Add `eksClusterName` to `K8sConfigs` (e.g. `k8s-eks-development`) — distinct from the kubeadm cluster name |

---

## Task 1: Add EKS configuration module

**Files:**
- Create: `infra/lib/config/eks/configurations.ts`, `infra/lib/config/eks/index.ts`
- Modify: `infra/lib/config/kubernetes/configurations.ts` (add `eksClusterName`)

- [ ] **Step 1: Read current K8sConfigs to find insertion point**

```bash
grep -n "eksClusterName\|clusterName" infra/lib/config/kubernetes/configurations.ts | head
```

If `eksClusterName` already exists, skip Step 4 below.

- [ ] **Step 2: Create `infra/lib/config/eks/configurations.ts`**

```typescript
/**
 * @format
 * EKS configuration — per-environment cluster, MNG, addon, and Karpenter
 * settings. Distinct from kubeadm K8sConfigs because EKS introduces a managed
 * control plane and Karpenter-driven workload compute.
 */
import { type DeployableEnvironment, Environment } from '../environments';

/** EKS Kubernetes minor version. Pin once per env; bump as a deliberate task. */
export const EKS_VERSION = '1.30';

/** Karpenter chart version (matches EKS minor + Karpenter compatibility table). */
export const KARPENTER_VERSION = '1.0.6';

/** AWS Load Balancer Controller chart version. */
export const ALB_CONTROLLER_VERSION = '1.8.4';

/** External DNS chart version. */
export const EXTERNAL_DNS_VERSION = '1.15.0';

/** External Secrets Operator chart version. */
export const EXTERNAL_SECRETS_VERSION = '0.10.4';

/** EBS CSI driver chart version (when not using the EKS managed addon). */
export const EBS_CSI_VERSION = '2.35.0';

/**
 * Workload service accounts that need IAM via Pod Identity.
 * Each entry pairs a namespace+SA with a permission scope keyword
 * resolved by the PodIdentity stack.
 */
export interface PodIdentityBinding {
    readonly namespace: string;
    readonly serviceAccount: string;
    readonly purpose:
        | 'karpenter'
        | 'alb-controller'
        | 'external-dns'
        | 'external-secrets'
        | 'ebs-csi';
}

export interface EksMngConfig {
    readonly instanceTypes: readonly string[];
    readonly desiredSize: number;
    readonly minSize: number;
    readonly maxSize: number;
    readonly diskSizeGib: number;
}

export interface EksKarpenterNodePoolConfig {
    readonly instanceCategory: readonly string[]; // e.g. ['t']
    readonly instanceFamily: readonly string[];   // e.g. ['t3']
    readonly capacityType: readonly ('on-demand' | 'spot')[];
    readonly architectures: readonly string[];    // e.g. ['amd64']
    readonly cpuMin: number;
    readonly cpuMax: number;
}

export interface EksConfig {
    readonly clusterName: string;
    readonly version: string;
    readonly mng: EksMngConfig;
    readonly podIdentityBindings: readonly PodIdentityBinding[];
    readonly karpenter: EksKarpenterNodePoolConfig;
    readonly versions: {
        readonly karpenter: string;
        readonly albController: string;
        readonly externalDns: string;
        readonly externalSecrets: string;
        readonly ebsCsi: string;
    };
}

const COMMON_BINDINGS: readonly PodIdentityBinding[] = [
    { namespace: 'karpenter', serviceAccount: 'karpenter', purpose: 'karpenter' },
    { namespace: 'kube-system', serviceAccount: 'aws-load-balancer-controller', purpose: 'alb-controller' },
    { namespace: 'kube-system', serviceAccount: 'external-dns', purpose: 'external-dns' },
    { namespace: 'external-secrets', serviceAccount: 'external-secrets', purpose: 'external-secrets' },
    { namespace: 'kube-system', serviceAccount: 'ebs-csi-controller-sa', purpose: 'ebs-csi' },
] as const;

const COMMON_VERSIONS = {
    karpenter: KARPENTER_VERSION,
    albController: ALB_CONTROLLER_VERSION,
    externalDns: EXTERNAL_DNS_VERSION,
    externalSecrets: EXTERNAL_SECRETS_VERSION,
    ebsCsi: EBS_CSI_VERSION,
} as const;

const COMMON_KARPENTER: EksKarpenterNodePoolConfig = {
    instanceCategory: ['t'],
    instanceFamily: ['t3'],
    capacityType: ['on-demand'], // V1: on-demand only
    architectures: ['amd64'],
    cpuMin: 2,
    cpuMax: 8,
} as const;

export const EKS_CONFIGS: Record<DeployableEnvironment, EksConfig> = {
    [Environment.DEVELOPMENT]: {
        clusterName: 'k8s-eks-development',
        version: EKS_VERSION,
        mng: { instanceTypes: ['t3.medium'], desiredSize: 3, minSize: 3, maxSize: 4, diskSizeGib: 30 },
        podIdentityBindings: COMMON_BINDINGS,
        karpenter: COMMON_KARPENTER,
        versions: COMMON_VERSIONS,
    },
    [Environment.STAGING]: {
        clusterName: 'k8s-eks-staging',
        version: EKS_VERSION,
        mng: { instanceTypes: ['t3.medium'], desiredSize: 3, minSize: 3, maxSize: 4, diskSizeGib: 30 },
        podIdentityBindings: COMMON_BINDINGS,
        karpenter: COMMON_KARPENTER,
        versions: COMMON_VERSIONS,
    },
    [Environment.PRODUCTION]: {
        clusterName: 'k8s-eks-production',
        version: EKS_VERSION,
        mng: { instanceTypes: ['t3.medium'], desiredSize: 3, minSize: 3, maxSize: 6, diskSizeGib: 30 },
        podIdentityBindings: COMMON_BINDINGS,
        karpenter: COMMON_KARPENTER,
        versions: COMMON_VERSIONS,
    },
};

export function getEksConfig(env: Environment): EksConfig {
    if (env === Environment.MANAGEMENT) {
        throw new Error('EKS not deployed to management env');
    }
    return EKS_CONFIGS[env as DeployableEnvironment];
}
```

- [ ] **Step 3: Create `infra/lib/config/eks/index.ts`**

```typescript
export * from './configurations';
```

- [ ] **Step 4: Add `eksClusterName` to `K8sConfigs`** (only if missing)

In `infra/lib/config/kubernetes/configurations.ts`, find `interface K8sConfigs` (around line 366) and add a field:

```typescript
    /** Concrete EKS cluster name — used for subnet tagging on the shared VPC. */
    readonly eksClusterName: string;
```

Then in each entry of `K8S_CONFIGS` (line 467), add `eksClusterName: 'k8s-eks-<env>'` matching the value in `EKS_CONFIGS`.

- [ ] **Step 5: Typecheck**

```bash
cd infra && yarn typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/config/
git commit -m "feat(config): add EKS configuration module"
```

---

## Task 2: Subnet retag + workers SG in `KubernetesBaseStack`

**Files:**
- Modify: `infra/lib/stacks/kubernetes/base-stack.ts`
- Test: `infra/tests/unit/stacks/kubernetes/base-stack.test.ts` (extend existing)

- [ ] **Step 1: Locate VPC subnet handling in BaseStack**

```bash
grep -n "Vpc.fromLookup\|publicSubnets\|privateSubnets\|cdk.Tags.of" infra/lib/stacks/kubernetes/base-stack.ts | head -20
```

Expected: shows where subnets are referenced.

- [ ] **Step 2: Add EKS subnet tags after VPC lookup**

Insert after the VPC lookup (and before any SG construction). Use `props.configs.eksClusterName`:

```typescript
// EKS subnet discovery tags. `shared` (NOT `owned`) — VPC outlives any
// single cluster; `owned` would let EKS delete the subnet on cluster destroy.
// See spec § 5.1.
const eksClusterTagKey = `kubernetes.io/cluster/${props.configs.eksClusterName}`;
for (const subnet of this.vpc.publicSubnets) {
    cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    cdk.Tags.of(subnet).add(eksClusterTagKey, 'shared');
}
for (const subnet of this.vpc.privateSubnets) {
    cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    cdk.Tags.of(subnet).add(eksClusterTagKey, 'shared');
}
```

- [ ] **Step 3: Add EKS workers security group**

After the existing SG block, add:

```typescript
this.eksWorkersSg = new ec2.SecurityGroup(this, 'EksWorkersSg', {
    vpc: this.vpc,
    securityGroupName: `eks-workers-${props.targetEnvironment}`,
    description: 'EKS Karpenter-launched worker nodes — node-to-node + ELB ingress',
    allowAllOutbound: true,
});
this.eksWorkersSg.addIngressRule(
    this.eksWorkersSg,
    ec2.Port.allTraffic(),
    'Node-to-node communication',
);
new ssm.StringParameter(this, 'EksWorkersSgIdParam', {
    parameterName: `${props.ssmPrefix}/eks/workers-sg-id`,
    stringValue: this.eksWorkersSg.securityGroupId,
});
```

Add `public readonly eksWorkersSg: ec2.SecurityGroup;` to the class fields.

- [ ] **Step 4: Run typecheck**

```bash
cd infra && yarn typecheck
```

Expected: exit 0.

- [ ] **Step 5: Synth dev to confirm tags appear**

```bash
cd infra && AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=development Base-development 2>&1 \
  | grep -A1 "kubernetes.io/cluster" | head
```

Expected: tag entries `kubernetes.io/cluster/k8s-eks-development` with value `shared` appear in the template.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/stacks/kubernetes/base-stack.ts \
        infra/lib/config/kubernetes/configurations.ts
git commit -m "feat(k8s-cdk): tag VPC subnets for EKS discovery + add eks-workers SG"
```

---

## Task 3: `EksClusterStack`

**Files:**
- Create: `infra/lib/stacks/kubernetes/eks-cluster-stack.ts`
- Test: `infra/tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * @format
 * Unit tests for EksClusterStack.
 */
process.env.AWS_ACCOUNT_ID = '123456789012';

import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { Environment } from '../../../../lib/config/environments';
import { EksClusterStack } from '../../../../lib/stacks/kubernetes/eks-cluster-stack';

describe('EksClusterStack', () => {
    let app: cdk.App;
    let stack: EksClusterStack;
    let template: Template;

    beforeEach(() => {
        app = new cdk.App();
        const vpcStack = new cdk.Stack(app, 'VpcStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const vpc = new ec2.Vpc(vpcStack, 'Vpc', { maxAzs: 3 });
        stack = new EksClusterStack(app, 'EksCluster', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            vpc,
            clusterName: 'k8s-eks-development',
            version: '1.30',
        });
        template = Template.fromStack(stack);
    });

    it('should create an EKS Cluster', () => {
        template.resourceCountIs('AWS::EKS::Cluster', 1);
    });

    it('should set cluster name', () => {
        template.hasResourceProperties('AWS::EKS::Cluster', {
            Name: 'k8s-eks-development',
        });
    });

    it('should enable secrets envelope encryption with KMS', () => {
        template.resourceCountIs('AWS::KMS::Key', 1);
        template.hasResourceProperties('AWS::EKS::Cluster', {
            EncryptionConfig: [
                { Provider: { KeyArn: { 'Fn::GetAtt': [expect.stringMatching(/.*Kms.*/), 'Arn'] } }, Resources: ['secrets'] },
            ],
        });
    });

    it('should set the configured Kubernetes version', () => {
        template.hasResourceProperties('AWS::EKS::Cluster', { Version: '1.30' });
    });
});
```

- [ ] **Step 2: Run test — expect file-not-found error**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts --no-coverage
```

Expected: FAIL with module-not-found for `eks-cluster-stack`.

- [ ] **Step 3: Implement the stack**

Create `infra/lib/stacks/kubernetes/eks-cluster-stack.ts`:

```typescript
/**
 * @format
 * EKS Cluster Stack — managed control plane.
 *
 * Creates the EKS cluster, the cluster IAM role (separate from node role),
 * a KMS envelope key for Kubernetes Secrets, and the CloudWatch log group
 * for control-plane logs. Does NOT create any node group; that is owned by
 * `EksSystemNodeGroupStack`.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 3
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksClusterStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly vpc: ec2.IVpc;
    readonly clusterName: string;
    readonly version: string;
}

export class EksClusterStack extends cdk.Stack {
    public readonly cluster: eks.Cluster;
    public readonly secretsKmsKey: kms.Key;

    constructor(scope: Construct, id: string, props: EksClusterStackProps) {
        super(scope, id, props);

        this.secretsKmsKey = new kms.Key(this, 'SecretsKms', {
            alias: `alias/${props.clusterName}-secrets`,
            description: `EKS secrets envelope encryption — ${props.clusterName}`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.cluster = new eks.Cluster(this, 'Cluster', {
            clusterName: props.clusterName,
            version: eks.KubernetesVersion.of(props.version),
            vpc: props.vpc,
            vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
            defaultCapacity: 0, // System MNG provisioned by sibling stack
            secretsEncryptionKey: this.secretsKmsKey,
            clusterLogging: [
                eks.ClusterLoggingTypes.API,
                eks.ClusterLoggingTypes.AUDIT,
                eks.ClusterLoggingTypes.AUTHENTICATOR,
                eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
                eks.ClusterLoggingTypes.SCHEDULER,
            ],
            kubectlLayer: undefined, // CDK auto-provisions
            outputClusterName: true,
            outputConfigCommand: true,
        });

        new logs.LogGroup(this, 'ControlPlaneLogs', {
            logGroupName: `/aws/eks/${props.clusterName}/cluster`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        cdk.Tags.of(this).add('eks-cluster', props.clusterName);
    }
}
```

- [ ] **Step 4: Run test — expect pass on cluster + version + KMS; the EncryptionConfig matcher may need relaxing**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts --no-coverage
```

Expected: 4 passed. If the `EncryptionConfig` matcher fails because the GetAtt key shape differs, replace it with:

```typescript
template.hasResourceProperties('AWS::EKS::Cluster', {
    EncryptionConfig: [{ Resources: ['secrets'] }],
});
```

- [ ] **Step 5: Re-export from index**

In `infra/lib/stacks/kubernetes/index.ts`, add:

```typescript
export * from './eks-cluster-stack';
```

- [ ] **Step 6: Commit**

```bash
git add infra/lib/stacks/kubernetes/eks-cluster-stack.ts \
        infra/lib/stacks/kubernetes/index.ts \
        infra/tests/unit/stacks/kubernetes/eks-cluster-stack.test.ts
git commit -m "feat(eks): add EksClusterStack with KMS-encrypted secrets"
```

---

## Task 4: `EksSystemNodeGroupStack`

**Files:**
- Create: `infra/lib/stacks/kubernetes/eks-system-node-group-stack.ts`
- Test: `infra/tests/unit/stacks/kubernetes/eks-system-node-group-stack.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
/**
 * @format
 */
process.env.AWS_ACCOUNT_ID = '123456789012';

import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';

import { Environment } from '../../../../lib/config/environments';
import { EksSystemNodeGroupStack } from '../../../../lib/stacks/kubernetes/eks-system-node-group-stack';

describe('EksSystemNodeGroupStack', () => {
    let template: Template;

    beforeEach(() => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const vpc = new ec2.Vpc(clusterStack, 'Vpc', { maxAzs: 3 });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_30,
            vpc,
            defaultCapacity: 0,
        });
        const stack = new EksSystemNodeGroupStack(app, 'Mng', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            instanceTypes: ['t3.medium'],
            desiredSize: 3,
            minSize: 3,
            maxSize: 4,
            diskSizeGib: 30,
        });
        template = Template.fromStack(stack);
    });

    it('should create one Nodegroup', () => {
        template.resourceCountIs('AWS::EKS::Nodegroup', 1);
    });

    it('should taint the nodegroup with dedicated=system:NoSchedule', () => {
        template.hasResourceProperties('AWS::EKS::Nodegroup', {
            Taints: Match.arrayWith([
                Match.objectLike({ Key: 'dedicated', Value: 'system', Effect: 'NO_SCHEDULE' }),
            ]),
        });
    });

    it('should set instance type t3.medium and disk 30 GiB', () => {
        template.hasResourceProperties('AWS::EKS::Nodegroup', {
            InstanceTypes: ['t3.medium'],
            DiskSize: 30,
        });
    });

    it('should set desired/min/max scaling', () => {
        template.hasResourceProperties('AWS::EKS::Nodegroup', {
            ScalingConfig: { DesiredSize: 3, MinSize: 3, MaxSize: 4 },
        });
    });
});
```

- [ ] **Step 2: Implement the stack**

Create `infra/lib/stacks/kubernetes/eks-system-node-group-stack.ts`:

```typescript
/**
 * @format
 * EKS System Node Group Stack — Karpenter / CoreDNS landing zone.
 *
 * Provides 3× t3.medium nodes spread across 3 AZs to host cluster-critical
 * pods (Karpenter controller, CoreDNS, kube-proxy, addon controllers,
 * monitoring stack). Tainted `dedicated=system:NoSchedule`; workload pods
 * land on Karpenter-managed nodes.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 3.1
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksSystemNodeGroupStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly instanceTypes: readonly string[];
    readonly desiredSize: number;
    readonly minSize: number;
    readonly maxSize: number;
    readonly diskSizeGib: number;
}

export class EksSystemNodeGroupStack extends cdk.Stack {
    public readonly nodeGroup: eks.Nodegroup;
    public readonly nodeRole: iam.Role;

    constructor(scope: Construct, id: string, props: EksSystemNodeGroupStackProps) {
        super(scope, id, props);

        this.nodeRole = new iam.Role(this, 'NodeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        this.nodeGroup = props.cluster.addNodegroupCapacity('SystemMng', {
            instanceTypes: props.instanceTypes.map((t) => new ec2.InstanceType(t)),
            desiredSize: props.desiredSize,
            minSize: props.minSize,
            maxSize: props.maxSize,
            diskSize: props.diskSizeGib,
            amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
            capacityType: eks.CapacityType.ON_DEMAND,
            nodeRole: this.nodeRole,
            taints: [
                { key: 'dedicated', value: 'system', effect: eks.TaintEffect.NO_SCHEDULE },
            ],
            labels: { 'node-role': 'system' },
            subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            tags: { 'eks-cluster-pool': 'system' },
        });
    }
}
```

- [ ] **Step 3: Test passes**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/stacks/kubernetes/eks-system-node-group-stack.test.ts --no-coverage
```

Expected: 4 passed.

- [ ] **Step 4: Re-export + commit**

```bash
echo "export * from './eks-system-node-group-stack';" >> infra/lib/stacks/kubernetes/index.ts
git add infra/lib/stacks/kubernetes/eks-system-node-group-stack.ts \
        infra/lib/stacks/kubernetes/index.ts \
        infra/tests/unit/stacks/kubernetes/eks-system-node-group-stack.test.ts
git commit -m "feat(eks): add EksSystemNodeGroupStack — 3× t3.medium MNG with system taint"
```

---

## Task 5: `EksAccessStack`

**Files:**
- Create: `infra/lib/stacks/kubernetes/eks-access-stack.ts`
- Test: `infra/tests/unit/stacks/kubernetes/eks-access-stack.test.ts`

EKS Access Entries are the Nov-2023 replacement for `aws-auth` ConfigMap. We add two:
- The GitHub OIDC role used by `_deploy-eks.yml` — needs `cluster-admin` for `kubectl wait` etc.
- The portfolio-admin IAM role (for human kubectl access from local).

- [ ] **Step 1: Write failing test**

```typescript
process.env.AWS_ACCOUNT_ID = '123456789012';

import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Environment } from '../../../../lib/config/environments';
import { EksAccessStack } from '../../../../lib/stacks/kubernetes/eks-access-stack';

describe('EksAccessStack', () => {
    it('should create access entries for the configured principals', () => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_30,
            defaultCapacity: 0,
        });
        const stack = new EksAccessStack(app, 'Access', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            principalArns: [
                'arn:aws:iam::123456789012:role/gh-oidc-cdk-deployer',
                'arn:aws:iam::123456789012:role/PortfolioAdmin',
            ],
        });
        const template = Template.fromStack(stack);
        template.resourceCountIs('AWS::EKS::AccessEntry', 2);
        template.hasResourceProperties('AWS::EKS::AccessEntry', {
            PrincipalArn: 'arn:aws:iam::123456789012:role/gh-oidc-cdk-deployer',
        });
    });
});
```

- [ ] **Step 2: Implement the stack**

```typescript
/**
 * @format
 * EKS Access Stack — IAM principal-to-Kubernetes-RBAC bindings.
 * Replaces the legacy aws-auth ConfigMap pattern with EKS Access Entries.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 7.1
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '../../config/environments';

export interface EksAccessStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly principalArns: readonly string[];
}

export class EksAccessStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksAccessStackProps) {
        super(scope, id, props);

        for (const arn of props.principalArns) {
            const slug = arn.split('/').pop()!.replace(/[^a-zA-Z0-9]/g, '');
            new eks.AccessEntry(this, `Entry${slug}`, {
                cluster: props.cluster,
                principal: arn,
                accessPolicies: [
                    eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
                        accessScopeType: eks.AccessScopeType.CLUSTER,
                    }),
                ],
            });
        }
    }
}
```

- [ ] **Step 3: Test + re-export + commit**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/stacks/kubernetes/eks-access-stack.test.ts --no-coverage
echo "export * from './eks-access-stack';" >> infra/lib/stacks/kubernetes/index.ts
git add infra/lib/stacks/kubernetes/eks-access-stack.ts \
        infra/lib/stacks/kubernetes/index.ts \
        infra/tests/unit/stacks/kubernetes/eks-access-stack.test.ts
git commit -m "feat(eks): add EksAccessStack — Access Entries for GH OIDC + admin"
```

---

## Task 6: `EksPodIdentityStack`

**Files:**
- Create: `infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts`
- Test: `infra/tests/unit/stacks/kubernetes/eks-pod-identity-stack.test.ts`

For each binding we create a per-purpose IAM role with least-privilege and a `CfnPodIdentityAssociation` linking it to the namespaced ServiceAccount.

- [ ] **Step 1: Write the failing test**

```typescript
process.env.AWS_ACCOUNT_ID = '123456789012';
import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Environment } from '../../../../lib/config/environments';
import { EksPodIdentityStack } from '../../../../lib/stacks/kubernetes/eks-pod-identity-stack';

describe('EksPodIdentityStack', () => {
    it('should create one PodIdentityAssociation per binding', () => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_30,
            defaultCapacity: 0,
        });
        const stack = new EksPodIdentityStack(app, 'PodId', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            bindings: [
                { namespace: 'karpenter', serviceAccount: 'karpenter', purpose: 'karpenter' },
                { namespace: 'kube-system', serviceAccount: 'aws-load-balancer-controller', purpose: 'alb-controller' },
            ],
            karpenterInterruptionQueueArn: 'arn:aws:sqs:eu-west-1:123456789012:karpenter',
            workerNodeRoleArn: 'arn:aws:iam::123456789012:role/KarpenterNodeRole',
            hostedZoneIds: ['Z1234567890ABC'],
        });
        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::EKS::PodIdentityAssociation', 2);
        t.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
            Namespace: 'karpenter',
            ServiceAccount: 'karpenter',
        });
    });
});
```

- [ ] **Step 2: Implement**

```typescript
/**
 * @format
 * EKS Pod Identity Stack — IAM-to-ServiceAccount associations.
 *
 * Replaces IRSA. Each binding gets:
 *   - A least-privilege IAM role (per purpose)
 *   - A `CfnPodIdentityAssociation` linking the role to a SA in a namespace
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 4
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { PodIdentityBinding } from '../../config/eks';

export interface EksPodIdentityStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly bindings: readonly PodIdentityBinding[];
    readonly karpenterInterruptionQueueArn: string;
    readonly workerNodeRoleArn: string;
    readonly hostedZoneIds: readonly string[];
}

export class EksPodIdentityStack extends cdk.Stack {
    public readonly roles: Record<string, iam.Role> = {};

    constructor(scope: Construct, id: string, props: EksPodIdentityStackProps) {
        super(scope, id, props);

        const podIdentityPrincipal = new iam.ServicePrincipal('pods.eks.amazonaws.com');

        for (const b of props.bindings) {
            const role = new iam.Role(this, `Role${b.purpose}`, {
                assumedBy: podIdentityPrincipal,
                description: `Pod Identity role for ${b.namespace}/${b.serviceAccount}`,
            });
            this.attachPurposePolicies(role, b.purpose, props);
            this.roles[b.purpose] = role;

            new eks.CfnPodIdentityAssociation(this, `Assoc${b.purpose}`, {
                clusterName: props.cluster.clusterName,
                namespace: b.namespace,
                serviceAccount: b.serviceAccount,
                roleArn: role.roleArn,
            });
        }
    }

    private attachPurposePolicies(
        role: iam.Role,
        purpose: PodIdentityBinding['purpose'],
        props: EksPodIdentityStackProps,
    ): void {
        switch (purpose) {
            case 'karpenter':
                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
                    resources: [props.karpenterInterruptionQueueArn],
                }));
                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['ec2:RunInstances', 'ec2:CreateTags', 'ec2:CreateLaunchTemplate',
                             'ec2:DescribeInstances', 'ec2:DescribeImages', 'ec2:DescribeInstanceTypes',
                             'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups', 'ec2:DescribeAvailabilityZones',
                             'ec2:DescribeSpotPriceHistory', 'ec2:DescribeLaunchTemplates',
                             'ec2:TerminateInstances', 'pricing:GetProducts'],
                    resources: ['*'],
                }));
                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['iam:PassRole'],
                    resources: [props.workerNodeRoleArn],
                }));
                break;
            case 'alb-controller':
                role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AmazonAPIGatewayPushToCloudWatchLogs')); // placeholder; real policy via inline
                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['elasticloadbalancing:*', 'ec2:Describe*', 'acm:DescribeCertificate',
                             'iam:CreateServiceLinkedRole', 'wafv2:GetWebACL', 'wafv2:AssociateWebACL'],
                    resources: ['*'],
                }));
                break;
            case 'external-dns':
                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['route53:ChangeResourceRecordSets'],
                    resources: props.hostedZoneIds.map((z) => `arn:aws:route53:::hostedzone/${z}`),
                }));
                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['route53:ListHostedZones', 'route53:ListResourceRecordSets'],
                    resources: ['*'],
                }));
                break;
            case 'external-secrets':
                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath',
                             'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret',
                             'kms:Decrypt'],
                    resources: ['*'],
                }));
                break;
            case 'ebs-csi':
                role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy'));
                break;
        }
    }
}
```

> **Note on alb-controller policy:** the AWS-published JSON policy has 100+ statements — best practice is to vendor it as a JSON file (`infra/lib/stacks/kubernetes/policies/alb-controller-iam-policy.json`) and load via `iam.PolicyDocument.fromJson`. For brevity above we use a coarse statement; replace before production cutover. Track in spec § 10 risks.

- [ ] **Step 3: Test + commit**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/stacks/kubernetes/eks-pod-identity-stack.test.ts --no-coverage
echo "export * from './eks-pod-identity-stack';" >> infra/lib/stacks/kubernetes/index.ts
git add infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts \
        infra/lib/stacks/kubernetes/index.ts \
        infra/tests/unit/stacks/kubernetes/eks-pod-identity-stack.test.ts
git commit -m "feat(eks): add EksPodIdentityStack — Pod ID associations replacing IRSA"
```

---

## Task 7: `EksKarpenterStack`

**Files:**
- Create: `infra/lib/stacks/kubernetes/eks-karpenter-stack.ts`
- Test: `infra/tests/unit/stacks/kubernetes/eks-karpenter-stack.test.ts`

This stack provisions the SQS interruption queue + EventBridge rules. The Karpenter controller itself is installed by `EksAddonsStack` (Helm). The `NodePool` + `EC2NodeClass` are CRDs; we apply them as `KubernetesManifest` so they exist before any workload pod is scheduled.

- [ ] **Step 1: Write the failing test (SQS + 4 EventBridge rules)**

```typescript
process.env.AWS_ACCOUNT_ID = '123456789012';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Environment } from '../../../../lib/config/environments';
import { EksKarpenterStack } from '../../../../lib/stacks/kubernetes/eks-karpenter-stack';

describe('EksKarpenterStack', () => {
    it('should create SQS interruption queue and 4 EventBridge rules', () => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_30,
            defaultCapacity: 0,
        });
        const nodeRole = new iam.Role(clusterStack, 'NodeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });
        const stack = new EksKarpenterStack(app, 'Karp', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            workerNodeRole: nodeRole,
            workerSecurityGroupId: 'sg-aaa',
            subnetTagKey: 'kubernetes.io/cluster/k8s-eks-development',
            karpenter: {
                instanceCategory: ['t'], instanceFamily: ['t3'],
                capacityType: ['on-demand'], architectures: ['amd64'],
                cpuMin: 2, cpuMax: 8,
            },
        });
        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::SQS::Queue', 1);
        t.resourceCountIs('AWS::Events::Rule', 4);
    });
});
```

- [ ] **Step 2: Implement**

```typescript
/**
 * @format
 * EKS Karpenter Stack — SQS interruption queue + EventBridge wiring +
 * NodePool/EC2NodeClass CRDs.
 *
 * The Karpenter Helm chart is installed by EksAddonsStack; this stack
 * supplies the runtime data plane (queue, CRDs).
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md §§ 3.2, 3.3
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { EksKarpenterNodePoolConfig } from '../../config/eks';

export interface EksKarpenterStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly workerNodeRole: iam.IRole;
    readonly workerSecurityGroupId: string;
    readonly subnetTagKey: string;
    readonly karpenter: EksKarpenterNodePoolConfig;
}

export class EksKarpenterStack extends cdk.Stack {
    public readonly interruptionQueue: sqs.Queue;

    constructor(scope: Construct, id: string, props: EksKarpenterStackProps) {
        super(scope, id, props);

        this.interruptionQueue = new sqs.Queue(this, 'InterruptionQueue', {
            queueName: `${props.cluster.clusterName}-karpenter`,
            retentionPeriod: cdk.Duration.minutes(5),
        });
        this.interruptionQueue.addToResourcePolicy(new iam.PolicyStatement({
            principals: [
                new iam.ServicePrincipal('events.amazonaws.com'),
                new iam.ServicePrincipal('sqs.amazonaws.com'),
            ],
            actions: ['sqs:SendMessage'],
            resources: [this.interruptionQueue.queueArn],
        }));

        const ruleSpecs: { id: string; source: string; detailType: string }[] = [
            { id: 'SpotInterruption', source: 'aws.ec2', detailType: 'EC2 Spot Instance Interruption Warning' },
            { id: 'ScheduledChange', source: 'aws.health', detailType: 'AWS Health Event' },
            { id: 'InstanceTerminating', source: 'aws.ec2', detailType: 'EC2 Instance State-change Notification' },
            { id: 'RebalanceRecommendation', source: 'aws.ec2', detailType: 'EC2 Instance Rebalance Recommendation' },
        ];
        for (const r of ruleSpecs) {
            new events.Rule(this, `Rule${r.id}`, {
                eventPattern: { source: [r.source], detailType: [r.detailType] },
                targets: [new eventsTargets.SqsQueue(this.interruptionQueue)],
            });
        }

        // Karpenter NodePool + EC2NodeClass as Kubernetes manifests.
        // Applied after the Karpenter chart is installed (sync order managed
        // by the addons stack). EC2NodeClass references the system MNG's
        // private subnets via the shared cluster-tag.
        new eks.KubernetesManifest(this, 'EC2NodeClass', {
            cluster: props.cluster,
            manifest: [{
                apiVersion: 'karpenter.k8s.aws/v1',
                kind: 'EC2NodeClass',
                metadata: { name: 'workloads-default-class' },
                spec: {
                    amiFamily: 'AL2023',
                    role: cdk.Fn.select(1, cdk.Fn.split('/', props.workerNodeRole.roleArn)),
                    subnetSelectorTerms: [{ tags: { [props.subnetTagKey]: 'shared' } }],
                    securityGroupSelectorTerms: [{ id: props.workerSecurityGroupId }],
                    tags: { 'eks-cluster-pool': 'workloads-default' },
                },
            }],
        });

        new eks.KubernetesManifest(this, 'NodePool', {
            cluster: props.cluster,
            manifest: [{
                apiVersion: 'karpenter.sh/v1',
                kind: 'NodePool',
                metadata: { name: 'workloads-default' },
                spec: {
                    template: {
                        spec: {
                            nodeClassRef: { group: 'karpenter.k8s.aws', kind: 'EC2NodeClass', name: 'workloads-default-class' },
                            requirements: [
                                { key: 'karpenter.k8s.aws/instance-category', operator: 'In', values: [...props.karpenter.instanceCategory] },
                                { key: 'karpenter.k8s.aws/instance-family', operator: 'In', values: [...props.karpenter.instanceFamily] },
                                { key: 'karpenter.sh/capacity-type', operator: 'In', values: [...props.karpenter.capacityType] },
                                { key: 'kubernetes.io/arch', operator: 'In', values: [...props.karpenter.architectures] },
                                { key: 'karpenter.k8s.aws/instance-cpu', operator: 'Gt', values: [String(props.karpenter.cpuMin - 1)] },
                                { key: 'karpenter.k8s.aws/instance-cpu', operator: 'Lt', values: [String(props.karpenter.cpuMax + 1)] },
                            ],
                            expireAfter: '720h',
                        },
                    },
                    disruption: { consolidationPolicy: 'WhenEmpty', consolidateAfter: '30s' },
                    limits: { cpu: 100 },
                },
            }],
        });
    }
}
```

- [ ] **Step 3: Test + commit**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/stacks/kubernetes/eks-karpenter-stack.test.ts --no-coverage
echo "export * from './eks-karpenter-stack';" >> infra/lib/stacks/kubernetes/index.ts
git add infra/lib/stacks/kubernetes/eks-karpenter-stack.ts \
        infra/lib/stacks/kubernetes/index.ts \
        infra/tests/unit/stacks/kubernetes/eks-karpenter-stack.test.ts
git commit -m "feat(eks): add EksKarpenterStack — SQS, EventBridge, NodePool"
```

---

## Task 8: `EksAddonsStack`

**Files:**
- Create: `infra/lib/stacks/kubernetes/eks-addons-stack.ts`
- Test: `infra/tests/unit/stacks/kubernetes/eks-addons-stack.test.ts`

Installs Helm charts via `eks.HelmChart`. Each chart's ServiceAccount references the Pod Identity-bound role (no IRSA annotation needed — Pod ID resolves at pod start).

- [ ] **Step 1: Write a minimal failing test**

```typescript
process.env.AWS_ACCOUNT_ID = '123456789012';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Environment } from '../../../../lib/config/environments';
import { EksAddonsStack } from '../../../../lib/stacks/kubernetes/eks-addons-stack';

describe('EksAddonsStack', () => {
    it('should add VPC CNI managed addon', () => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_30,
            defaultCapacity: 0,
        });
        const stack = new EksAddonsStack(app, 'Addons', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            karpenterInterruptionQueueName: 'k8s-eks-development-karpenter',
            workerNodeRoleArn: 'arn:aws:iam::123456789012:role/Worker',
            hostedZoneDomain: 'nelsonlamounier.com',
            versions: {
                karpenter: '1.0.6', albController: '1.8.4',
                externalDns: '1.15.0', externalSecrets: '0.10.4', ebsCsi: '2.35.0',
            },
        });
        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::EKS::Addon', 1); // vpc-cni
    });
});
```

- [ ] **Step 2: Implement**

```typescript
/**
 * @format
 * EKS Addons Stack — Helm-installed cluster addons.
 *
 * Order: VPC CNI (managed) → external-secrets → ALB controller → external-dns
 * → karpenter → EBS CSI. Each chart's SA is referenced by a Pod Identity
 * Association in `EksPodIdentityStack`; we don't annotate IRSA roles here.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 3.3 sequencing
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Environment } from '../../config/environments';

export interface EksAddonsStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly karpenterInterruptionQueueName: string;
    readonly workerNodeRoleArn: string;
    readonly hostedZoneDomain: string;
    readonly versions: {
        readonly karpenter: string;
        readonly albController: string;
        readonly externalDns: string;
        readonly externalSecrets: string;
        readonly ebsCsi: string;
    };
}

export class EksAddonsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksAddonsStackProps) {
        super(scope, id, props);

        new eks.CfnAddon(this, 'VpcCni', {
            clusterName: props.cluster.clusterName,
            addonName: 'vpc-cni',
            resolveConflicts: 'OVERWRITE',
        });

        new eks.HelmChart(this, 'ExternalSecrets', {
            cluster: props.cluster,
            chart: 'external-secrets',
            release: 'external-secrets',
            repository: 'https://charts.external-secrets.io',
            namespace: 'external-secrets',
            createNamespace: true,
            version: props.versions.externalSecrets,
            values: { serviceAccount: { name: 'external-secrets', create: true } },
        });

        new eks.HelmChart(this, 'AlbController', {
            cluster: props.cluster,
            chart: 'aws-load-balancer-controller',
            release: 'aws-load-balancer-controller',
            repository: 'https://aws.github.io/eks-charts',
            namespace: 'kube-system',
            version: props.versions.albController,
            values: {
                clusterName: props.cluster.clusterName,
                serviceAccount: { name: 'aws-load-balancer-controller', create: true },
            },
        });

        new eks.HelmChart(this, 'ExternalDns', {
            cluster: props.cluster,
            chart: 'external-dns',
            release: 'external-dns',
            repository: 'https://kubernetes-sigs.github.io/external-dns/',
            namespace: 'kube-system',
            version: props.versions.externalDns,
            values: {
                provider: 'aws',
                domainFilters: [props.hostedZoneDomain],
                policy: 'upsert-only',
                txtOwnerId: `eks-${props.targetEnvironment}`,
                serviceAccount: { name: 'external-dns', create: true },
            },
        });

        new eks.HelmChart(this, 'Karpenter', {
            cluster: props.cluster,
            chart: 'karpenter',
            release: 'karpenter',
            repository: 'oci://public.ecr.aws/karpenter',
            namespace: 'karpenter',
            createNamespace: true,
            version: props.versions.karpenter,
            values: {
                settings: {
                    clusterName: props.cluster.clusterName,
                    interruptionQueue: props.karpenterInterruptionQueueName,
                },
                serviceAccount: { name: 'karpenter', create: true },
                tolerations: [{ key: 'dedicated', value: 'system', effect: 'NoSchedule' }],
            },
        });

        new eks.HelmChart(this, 'EbsCsi', {
            cluster: props.cluster,
            chart: 'aws-ebs-csi-driver',
            release: 'aws-ebs-csi-driver',
            repository: 'https://kubernetes-sigs.github.io/aws-ebs-csi-driver',
            namespace: 'kube-system',
            version: props.versions.ebsCsi,
            values: { controller: { serviceAccount: { name: 'ebs-csi-controller-sa', create: true } } },
        });
    }
}
```

- [ ] **Step 3: Test + commit**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/stacks/kubernetes/eks-addons-stack.test.ts --no-coverage
echo "export * from './eks-addons-stack';" >> infra/lib/stacks/kubernetes/index.ts
git add infra/lib/stacks/kubernetes/eks-addons-stack.ts \
        infra/lib/stacks/kubernetes/index.ts \
        infra/tests/unit/stacks/kubernetes/eks-addons-stack.test.ts
git commit -m "feat(eks): add EksAddonsStack — Helm charts for cluster addons"
```

---

## Task 9: Wire all six stacks into `KubernetesProjectFactory`

**Files:**
- Modify: `infra/lib/projects/kubernetes/factory.ts`
- Test: `infra/tests/unit/projects/kubernetes/factory.test.ts` (extend stack count)

- [ ] **Step 1: Add imports to factory.ts**

```typescript
import {
    EksClusterStack,
    EksSystemNodeGroupStack,
    EksPodIdentityStack,
    EksAddonsStack,
    EksKarpenterStack,
    EksAccessStack,
} from '../../stacks/kubernetes';
import { getEksConfig } from '../../config/eks';
```

- [ ] **Step 2: Add wiring after `controlPlaneStack` block**

```typescript
const eksConfig = getEksConfig(environment);

const eksClusterStack = new EksClusterStack(scope, stackId(this.namespace, 'EksCluster', environment), {
    env, targetEnvironment: environment,
    vpc: baseStack.vpc,
    clusterName: eksConfig.clusterName,
    version: eksConfig.version,
});
eksClusterStack.addDependency(baseStack);
stacks.push(eksClusterStack); stackMap.eksCluster = eksClusterStack;

const eksSystemNg = new EksSystemNodeGroupStack(scope, stackId(this.namespace, 'EksSystemNg', environment), {
    env, targetEnvironment: environment,
    cluster: eksClusterStack.cluster,
    instanceTypes: eksConfig.mng.instanceTypes,
    desiredSize: eksConfig.mng.desiredSize,
    minSize: eksConfig.mng.minSize,
    maxSize: eksConfig.mng.maxSize,
    diskSizeGib: eksConfig.mng.diskSizeGib,
});
eksSystemNg.addDependency(eksClusterStack);
stacks.push(eksSystemNg); stackMap.eksSystemNg = eksSystemNg;

const karpenterQueueArn = `arn:aws:sqs:${env.region}:${env.account}:${eksConfig.clusterName}-karpenter`;

const eksPodId = new EksPodIdentityStack(scope, stackId(this.namespace, 'EksPodIdentity', environment), {
    env, targetEnvironment: environment,
    cluster: eksClusterStack.cluster,
    bindings: eksConfig.podIdentityBindings,
    karpenterInterruptionQueueArn: karpenterQueueArn,
    workerNodeRoleArn: eksSystemNg.nodeRole.roleArn,
    hostedZoneIds: edgeConfig.hostedZoneId ? [edgeConfig.hostedZoneId] : [],
});
eksPodId.addDependency(eksSystemNg);
stacks.push(eksPodId); stackMap.eksPodIdentity = eksPodId;

const eksAddons = new EksAddonsStack(scope, stackId(this.namespace, 'EksAddons', environment), {
    env, targetEnvironment: environment,
    cluster: eksClusterStack.cluster,
    karpenterInterruptionQueueName: `${eksConfig.clusterName}-karpenter`,
    workerNodeRoleArn: eksSystemNg.nodeRole.roleArn,
    hostedZoneDomain: edgeConfig.domainName?.split('.').slice(-2).join('.') ?? 'nelsonlamounier.com',
    versions: eksConfig.versions,
});
eksAddons.addDependency(eksPodId);
stacks.push(eksAddons); stackMap.eksAddons = eksAddons;

const eksKarp = new EksKarpenterStack(scope, stackId(this.namespace, 'EksKarpenter', environment), {
    env, targetEnvironment: environment,
    cluster: eksClusterStack.cluster,
    workerNodeRole: eksSystemNg.nodeRole,
    workerSecurityGroupId: baseStack.eksWorkersSg.securityGroupId,
    subnetTagKey: `kubernetes.io/cluster/${eksConfig.clusterName}`,
    karpenter: eksConfig.karpenter,
});
eksKarp.addDependency(eksAddons);
stacks.push(eksKarp); stackMap.eksKarpenter = eksKarp;

const ghOidcRoleArn = process.env.GH_OIDC_ROLE_ARN;
const adminRoleArn = process.env.ADMIN_ROLE_ARN;
const eksAccess = new EksAccessStack(scope, stackId(this.namespace, 'EksAccess', environment), {
    env, targetEnvironment: environment,
    cluster: eksClusterStack.cluster,
    principalArns: [ghOidcRoleArn, adminRoleArn].filter((a): a is string => !!a),
});
eksAccess.addDependency(eksClusterStack);
stacks.push(eksAccess); stackMap.eksAccess = eksAccess;
```

- [ ] **Step 3: Update `factory.test.ts` stack count**

Change `expect(stacks).toHaveLength(11)` → `expect(stacks).toHaveLength(17)`. Update the test name and `stackMap` assertions for the new keys (`eksCluster`, `eksSystemNg`, `eksPodIdentity`, `eksAddons`, `eksKarpenter`, `eksAccess`).

- [ ] **Step 4: Synth dev — confirm all 17 stacks**

```bash
cd infra && AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=development --quiet 2>&1 | tail -30
```

Expected: list shows `EksCluster-development`, `EksSystemNg-development`, `EksPodIdentity-development`, `EksAddons-development`, `EksKarpenter-development`, `EksAccess-development` alongside the existing 11 kubeadm-era stacks.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/projects/kubernetes/factory.ts \
        infra/tests/unit/projects/kubernetes/factory.test.ts
git commit -m "feat(eks): wire 6 EKS stacks into KubernetesProjectFactory"
```

---

## Task 10: Full health check + dev deploy dry-run

**Files:** none (verification only).

- [ ] **Step 1: Lint + typecheck + unit tests**

```bash
cd infra && yarn lint && yarn typecheck && CDK_BUNDLING_STACKS='[]' yarn test:unit 2>&1 | tail -10
```

Expected: zero errors; existing pre-existing failures (sandbox EACCES) acceptable.

- [ ] **Step 2: `cdk diff` for each new stack**

```bash
for STACK in EksCluster EksSystemNg EksPodIdentity EksAddons EksKarpenter EksAccess; do
  echo "=== $STACK ==="
  cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra && \
    AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
    CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
    npx cdk diff -c project=kubernetes -c environment=development "${STACK}-development" 2>&1 | tail -5
done
```

Expected: each diff shows only additions — no destructive changes to existing kubeadm-era stacks.

- [ ] **Step 3: Deploy in dependency order (manual gate)**

This step is intentionally **manual** because the dev account is live. Do NOT run the deploy automatically.

```bash
# Suggested order (one at a time, review each):
# AWS_ACCOUNT_ID=... npx cdk deploy EksCluster-development
# AWS_ACCOUNT_ID=... npx cdk deploy EksSystemNg-development
# AWS_ACCOUNT_ID=... npx cdk deploy EksPodIdentity-development
# AWS_ACCOUNT_ID=... npx cdk deploy EksAddons-development
# AWS_ACCOUNT_ID=... npx cdk deploy EksKarpenter-development
# AWS_ACCOUNT_ID=... npx cdk deploy EksAccess-development
```

For each deploy, after CFN reports CREATE_COMPLETE, verify:
```bash
aws eks describe-cluster --name k8s-eks-development --region eu-west-1 \
  --query 'cluster.status'
# Expected: ACTIVE
aws eks list-nodegroups --cluster-name k8s-eks-development --region eu-west-1
# Expected: SystemMng listed after Task 4 deploy
kubectl get nodes
# Expected after SystemMng deploy: 3 Ready nodes labelled node-role=system
kubectl get crd | grep karpenter
# Expected after EksAddons + EksKarpenter deploy: nodepools.karpenter.sh and ec2nodeclasses.karpenter.k8s.aws
```

- [ ] **Step 4: Verify Karpenter provisions a node**

```bash
kubectl run test-pod --image=public.ecr.aws/eks-distro/kubernetes/pause:3.7 \
  --overrides='{"spec":{"tolerations":[]}}' --restart=Never
# Wait up to 60s
kubectl get nodes -l node-role!=system -w
# Expected: a t3.* node provisioned by Karpenter joins the cluster
kubectl delete pod test-pod
```

- [ ] **Step 5: No commit — verification only**

---

## Task 11: Mark spec section done

**Files:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md`

- [ ] **Step 1: Append a status block to § 7.1 (after the "Total counts" line)**

```markdown

**Status (V1, dev):** ✅ Done (2026-MM-DD) — see Plan 2 (`docs/superpowers/plans/2026-05-05-eks-migration-02-cluster-bootstrap.md`). All 6 EKS stacks deployed in `development`; system MNG joined; Karpenter NodePool provisions on-demand t3 nodes within 60s of a Pending pod; ESO + EBS CSI + ALB controller + external-dns + VPC CNI all Healthy.
```

- [ ] **Step 2: Commit**

```bash
git add -f docs/superpowers/specs/2026-05-05-eks-migration-design.md
git commit -m "docs(eks): mark Plan 2 (cluster bootstrap) complete in dev"
```

---

## Acceptance Criteria — Plan 2 Done When

1. `infra/lib/config/eks/configurations.ts` exports per-env EKS config (cluster name, MNG, Karpenter requirements, addon versions).
2. `KubernetesBaseStack` tags every public/private subnet with `kubernetes.io/role/{elb,internal-elb}` and `kubernetes.io/cluster/<name>: shared`, and provisions an `eks-workers-<env>` SG.
3. Six new stacks (`EksCluster`, `EksSystemNg`, `EksPodIdentity`, `EksAddons`, `EksKarpenter`, `EksAccess`) synthesize cleanly for dev/staging/production env-var swap.
4. `factory.ts` instantiates all six in dependency order (Cluster → SystemNg → PodId → Addons → Karpenter; Access parallel after Cluster), and `factory.test.ts` asserts the 17-stack total.
5. Dev deploy succeeds end-to-end: cluster ACTIVE; 3× t3.medium MNG nodes Ready in 3 AZs; Helm charts Healthy; Karpenter provisions a workload node within 60s.
6. `kubectl auth can-i '*' '*'` from the GH OIDC role and from the admin role returns `yes` (Access Entries verified).
7. Spec § 7.1 status block updated.

---

## Out of Scope (later plans)

- ArgoCD bootstrap on EKS — Plan 3 (kubernetes-bootstrap repo restructure).
- New `deploy-eks-*.yml` GitHub Actions workflows — Plan 4.
- Origin failover + smoke tests + cutover runbook — Plan 5.
- `Deprecated_*` rename of kubeadm-era stacks — Plan 6.
- ALB-controller fine-grained IAM JSON policy — Plan 6 (or earlier if portfolio-blocking).

---

## Risks & Mitigations Specific to This Plan

| Risk | Mitigation |
|---|---|
| `eks.HelmChart` install order races (Karpenter NodePool applies before chart Healthy) | Stack ordering: `EksKarpenterStack` `addDependency(eksAddons)`. CFN waits for addons' `HelmChart::Resource` before applying NodePool manifest. |
| Pod Identity Association created before chart's ServiceAccount exists | First reconcile shows `failed to assume role`; controller restarts. Acceptable — Pod ID resolves on next pod start. |
| `eks.Cluster` synth requires `kubectlLayer` for KubernetesManifest | CDK auto-bundles via `awscli-layer`; no explicit lambda layer needed in this codebase. Verify via the addons stack synth. |
| ALB-controller coarse IAM (`elasticloadbalancing:*`) widens blast radius | Track in spec § 10. Not portfolio-blocking; replace with vendored JSON before any V2 ingress migration. |
| Subnet IP exhaustion during dual-cluster window | Per spec § 5.1: pre-cutover `aws ec2 describe-subnets` audit; this plan only TAGs subnets — does not allocate ENIs until system MNG launches. |
