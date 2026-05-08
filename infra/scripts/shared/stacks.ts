/**
 * Stack Configuration — CDK Layer
 *
 * Defines actual stack arrays with `getStackName` lambdas that call into
 * `getStackId()` from CDK's naming utility. Registers each project into
 * the shared `@nelsonlamounier/cdk-deploy-scripts/stacks.js` registry at import time.
 *
 * Consumer scripts import from this file (or from `@nelsonlamounier/cdk-deploy-scripts/stacks.js`
 * for pure types). This file re-exports everything from the shared module
 * so existing `./stacks.js` imports continue to work unchanged.
 */

// Re-export everything from the shared module so consumers don't need
// to change their import paths.
export {
  type DefaultConfig,
  type Environment,
  type ExtraContext,
  type ProjectConfig,
  type StackConfig,
  defaults,
  getAllStacksForProject,
  getEffectiveStacks,
  getProject,
  getRequiredContextMessage,
  getRequiredStacksForProject,
  getStack,
  isCloudFrontStack,
  profileMap,
  projectsMap,
} from '@nelsonlamounier/cdk-deploy-scripts/stacks.js';

import {
  registerProject,
  type Environment,
  type ExtraContext,
  type StackConfig,
} from '@nelsonlamounier/cdk-deploy-scripts/stacks.js';

import { Project } from '../../lib/config/projects.js';
import { getStackId } from '../../lib/utilities/naming.js';

// =============================================================================
// SHARED PROJECT (VPC + ECR shared infrastructure)
// =============================================================================

const sharedStacks: StackConfig[] = [
  {
    id: 'infra',
    name: 'Shared Infrastructure',
    getStackName: (env) => getStackId(Project.SHARED, 'infra', env),
    description: 'Shared VPC with public subnets and ECR repository',
  },
];

registerProject({
  id: 'shared',
  name: 'Shared',
  description: 'Shared infrastructure (VPC, ECR) used by multiple projects',
  stacks: sharedStacks,
  cdkContext: (env) => ({
    project: 'shared',
    environment: env,
  }),
});

// =============================================================================
// ORG PROJECT
// =============================================================================

const orgStacks: StackConfig[] = [
  {
    id: 'dns-role',
    name: 'DNS Role Stack',
    getStackName: () =>
      getStackId(Project.ORG, 'dnsRole', 'production'), // Always production for root account
    description: 'Cross-account DNS delegation role in root account',
  },
];

registerProject({
  id: 'org',
  name: 'Org',
  description: 'Root account resources for AWS Organizations',
  stacks: orgStacks,
  cdkContext: (_env: Environment, extra?: ExtraContext) => {
    const context: Record<string, string> = {
      project: 'org',
      environment: 'production', // Always production for root account
    };

    // Add org-specific context if provided (from ExtraContext)
    if (extra?.hostedZoneIds) {
      context.hostedZoneIds = extra.hostedZoneIds;
    }
    if (extra?.trustedAccountIds) {
      context.trustedAccountIds = extra.trustedAccountIds;
    }
    if (extra?.externalId) {
      context.externalId = extra.externalId;
    }

    // Add any additional generic context
    if (extra?.additionalContext) {
      Object.assign(context, extra.additionalContext);
    }

    return context;
  },
});

// =============================================================================
// K8S PROJECT (EKS — migrated from kubeadm on 2026-05-07)
// Active pipeline deploys: Data → Base → API → PlatformRds (kubernetes project)
//                          EKS stacks deployed by _deploy-eks.yml
// Deprecated kubeadm stacks (ControlPlane, GeneralPool, MonitoringPool,
// AppIam, Observability) are marked optional — NOT_FOUND is acceptable once
// they are destroyed. Do not add new callers; use EKS stacks instead.
// =============================================================================

const k8sStacks: StackConfig[] = [
  {
    id: 'data',
    name: 'Data Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'data', env),
    description: 'DynamoDB, S3 assets, SSM parameters for K8s application',
  },
  {
    id: 'base',
    name: 'Base Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'base', env),
    description:
      'VPC networking, security group, KMS key, EBS volume, Elastic IP',
    dependsOn: ['data'],
  },
  {
    id: 'controlPlane',
    name: 'Control Plane Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'controlPlane', env),
    description:
      'kubeadm Kubernetes control plane — deprecated, pending cdk destroy',
    dependsOn: ['base'],
    optional: true,
  },
  {
    id: 'generalPool',
    name: 'General Pool ASG Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'generalPool', env),
    description:
      'kubeadm general-purpose ASG pool — deprecated, pending cdk destroy',
    dependsOn: ['controlPlane'],
    optional: true,
  },
  {
    id: 'monitoringPool',
    name: 'Monitoring Pool ASG Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'monitoringPool', env),
    description:
      'kubeadm monitoring ASG pool — deprecated, pending cdk destroy',
    dependsOn: ['controlPlane'],
    optional: true,
  },
  {
    id: 'appIam',
    name: 'App IAM Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'appIam', env),
    description:
      'kubeadm application-tier IAM grants — deprecated, pending cdk destroy',
    dependsOn: ['controlPlane'],
    optional: true,
  },
  {
    id: 'api',
    name: 'API Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'api', env),
    description:
      'API Gateway with Lambda for email subscriptions (subscribe + verify)',
    dependsOn: ['data'],
    optional: true, // Application-layer — deployed separately from infrastructure
  },
  {
    id: 'observability',
    name: 'Observability Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'observability', env),
    description:
      'kubeadm CloudWatch dashboards — deprecated, pending cdk destroy',
    dependsOn: ['base'],
    optional: true,
  },
  {
    id: 'platformRds',
    name: 'Platform RDS Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'platformRds', env),
    description:
      'PostgreSQL 16.6 RDS instance for platform data (articles, identity, career) with PgBouncer via K8s',
    dependsOn: ['base'],
  },
  // ===== EKS V1 stacks (parallel deployment alongside kubeadm cluster) =====
  // Order: eksCluster → eksSystemNg → eksPodIdentity → eksAddons → eksKarpenter
  // (eksAccess parallel to chain, depends only on eksCluster).
  // Spec: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 7.1
  {
    id: 'eksCluster',
    name: 'EKS Cluster Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksCluster', env),
    description: 'EKS managed control plane + KMS envelope key + control-plane log group',
    dependsOn: ['base'],
  },
  {
    id: 'eksSystemNg',
    name: 'EKS System Node Group Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksSystemNg', env),
    description: '2× t3.medium MNG (system taint, AZ-spread)',
    dependsOn: ['eksCluster'],
  },
  {
    id: 'eksPodIdentity',
    name: 'EKS Pod Identity Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksPodIdentity', env),
    description:
      'CfnPodIdentityAssociation + per-purpose IAM roles (Karpenter, ALB, ESO, EBS CSI, external-dns)',
    dependsOn: ['eksSystemNg'],
  },
  {
    id: 'eksAddons',
    name: 'EKS Addons Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksAddons', env),
    description: 'VPC CNI managed addon + Helm: ESO, ALB controller, external-dns, Karpenter, EBS CSI',
    dependsOn: ['eksPodIdentity'],
  },
  {
    id: 'eksKarpenter',
    name: 'EKS Karpenter Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksKarpenter', env),
    description: 'SQS interruption queue + 4 EventBridge rules + NodePool/EC2NodeClass manifests',
    dependsOn: ['eksAddons'],
  },
  {
    id: 'eksScheduler',
    name: 'EKS Scheduler Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksScheduler', env),
    description: 'EventBridge Scheduler: scale-up 04:00 / scale-down 23:00 (dev only)',
    dependsOn: ['eksSystemNg'],
  },
  {
    id: 'eksAccess',
    name: 'EKS Access Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksAccess', env),
    description: 'AccessEntry × N — IAM principal → Kubernetes RBAC bindings',
    dependsOn: ['eksCluster'],
  },
  {
    id: 'eksAlbCerts',
    name: 'EKS ALB Certificates Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksAlbCerts', env),
    description:
      'Wildcard ACM certs (eu-west-1) for the shared public ALB — nelsonlamounier.com, tucaken.io, tucaken.com',
  },
  {
    id: 'eksPublicWaf',
    name: 'EKS Public WAF Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'eksPublicWaf', env),
    description:
      'Host-scoped REGIONAL WAFv2 WebACL (IP allowlist on admin/ops/tucaken hosts, rate limit on api host, AWS Managed Rule Sets globally)',
  },
];

registerProject({
  id: 'kubernetes',
  name: 'Kubernetes',
  description:
    'EKS cluster + shared infrastructure (Data, Base, API, PlatformRds, EKS stacks)',
  stacks: k8sStacks,
  cdkContext: (env) => {
    const context: Record<string, string> = {
      project: 'kubernetes',
      environment: env,
    };

    // Bridge ALLOW_IPV4 / ALLOW_IPV6 env vars (set by GitHub Actions from
    // environment secrets) into the CDK context parameter that base-stack.ts
    // reads via tryGetContext('adminAllowedIps').
    const ipParts = [process.env.ALLOW_IPV4, process.env.ALLOW_IPV6].filter(
      Boolean,
    );
    if (ipParts.length > 0) {
      context.adminAllowedIps = ipParts.join(',');
    }

    return context;
  },
});
