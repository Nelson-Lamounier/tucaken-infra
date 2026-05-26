/**
 * @format
 * EKS configuration — per-environment cluster, MNG, addon, and Karpenter
 * settings. Distinct from kubeadm K8sConfigs because EKS introduces a managed
 * control plane and Karpenter-driven workload compute.
 */
import { type DeployableEnvironment, Environment } from '../environments';

/** EKS Kubernetes minor version. Pin once per env; bump as a deliberate task. */
export const EKS_VERSION = '1.34';

/** Karpenter chart version (matches EKS minor + Karpenter compatibility table). */
export const KARPENTER_VERSION = '1.12.0';

/** AWS Load Balancer Controller chart version. */
export const ALB_CONTROLLER_VERSION = '1.8.4';

/** External DNS chart version. */
export const EXTERNAL_DNS_VERSION = '1.15.0';

/** External Secrets Operator chart version. */
export const EXTERNAL_SECRETS_VERSION = '0.10.4';

/** EBS CSI driver chart version (when not using the EKS managed addon). */
export const EBS_CSI_VERSION = '2.35.0';

export interface PodIdentityBinding {
    readonly namespace: string;
    readonly serviceAccount: string;
    readonly purpose:
        | 'karpenter'
        | 'alb-controller'
        | 'external-dns'
        | 'external-secrets'
        | 'ebs-csi'
        | 'grafana-alerting'
        | 'admin-api'
        | 'image-updater'
        | 'headlamp-token-pusher'
        | 'ingestion'
        | 'job-strategist'
        | 'article-pipeline'
        | 'ontology-importer';
}

export interface EksMngConfig {
    readonly instanceTypes: readonly string[];
    readonly desiredSize: number;
    readonly minSize: number;
    readonly maxSize: number;
    readonly diskSizeGib: number;
}

export interface EksKarpenterNodePoolConfig {
    readonly instanceCategory: readonly string[];
    readonly instanceFamily: readonly string[];
    readonly capacityType: readonly ('on-demand' | 'spot')[];
    readonly architectures: readonly string[];
    readonly cpuMin: number;
    readonly cpuMax: number;
}

/**
 * Elastic system-tier pool. Hosts cluster controllers (ESO, cert-manager,
 * ALB controller, etc.) that need isolation from workload churn but should
 * not pin a static MNG node when idle. Karpenter starts at the smallest
 * size in `instanceSizes` and consolidates up under bin-packing pressure.
 *
 * Selected via `karpenter.k8s.aws/instance-size` (not cpu range) because
 * t3 sizes share vCPU count (small/medium/large = 2 vCPU each); only memory
 * differs, so size is the discriminator that matters.
 */
export interface EksKarpenterSystemPoolConfig {
    readonly instanceFamily: readonly string[];
    readonly instanceSizes: readonly string[];
    readonly capacityType: readonly ('on-demand' | 'spot')[];
    readonly architectures: readonly string[];
    /** Pool-wide vCPU cap — prevents runaway scale. */
    readonly cpuLimit: number;
}

export interface EksConfig {
    readonly clusterName: string;
    readonly version: string;
    readonly mng: EksMngConfig;
    readonly podIdentityBindings: readonly PodIdentityBinding[];
    readonly karpenter: EksKarpenterNodePoolConfig;
    /** Optional elastic system-tier NodePool. Undefined = MNG-only system tier. */
    readonly systemPool?: EksKarpenterSystemPoolConfig;
    readonly versions: {
        readonly karpenter: string;
        readonly albController: string;
        readonly externalDns: string;
        readonly externalSecrets: string;
        readonly ebsCsi: string;
    };
    /** IAM principals granted EKS cluster-admin via Access Entries. */
    readonly adminPrincipalArns: readonly string[];
    /** SNS topic ARN for Grafana alert delivery. Omit to disable SNS alerting. */
    readonly grafanaAlertingTopicArn?: string;
}

const COMMON_BINDINGS: readonly PodIdentityBinding[] = [
    // ── Cluster system components ──────────────────────────────────────────────
    { namespace: 'karpenter',          serviceAccount: 'karpenter',                   purpose: 'karpenter' },
    { namespace: 'kube-system',        serviceAccount: 'aws-load-balancer-controller', purpose: 'alb-controller' },
    { namespace: 'kube-system',        serviceAccount: 'external-dns',                purpose: 'external-dns' },
    { namespace: 'external-secrets',   serviceAccount: 'external-secrets',            purpose: 'external-secrets' },
    { namespace: 'kube-system',        serviceAccount: 'ebs-csi-controller-sa',       purpose: 'ebs-csi' },
    { namespace: 'monitoring',         serviceAccount: 'grafana',                     purpose: 'grafana-alerting' },
    // ── Platform workloads ─────────────────────────────────────────────────────
    { namespace: 'admin-api',          serviceAccount: 'admin-api',                   purpose: 'admin-api' },
    { namespace: 'argocd',             serviceAccount: 'argocd-image-updater',        purpose: 'image-updater' },
    { namespace: 'headlamp',           serviceAccount: 'token-pusher',                purpose: 'headlamp-token-pusher' },
    // ── AI pipeline workloads ─────────────────────────────────────────────────
    { namespace: 'ingestion',          serviceAccount: 'ingestion-sa',                purpose: 'ingestion' },
    { namespace: 'job-strategist',     serviceAccount: 'job-strategist-sa',           purpose: 'job-strategist' },
    { namespace: 'article-pipeline',   serviceAccount: 'article-pipeline-sa',         purpose: 'article-pipeline' },
    { namespace: 'ontology-importer',  serviceAccount: 'ontology-importer-sa',        purpose: 'ontology-importer' },
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
    capacityType: ['spot', 'on-demand'],
    architectures: ['amd64'],
    cpuMin: 2,
    cpuMax: 8,
} as const;

// Dev workload pool: spot-only (no on-demand fallback) — cost-optimised,
// Karpenter still provisions purely on pod demand. staging/prod keep the
// on-demand fallback via COMMON_KARPENTER.
const DEV_KARPENTER: EksKarpenterNodePoolConfig = {
    ...COMMON_KARPENTER,
    capacityType: ['spot'],
} as const;

// Dev system pool: spot, sized for POD DENSITY (not CPU). Karpenter ranks
// candidate nodes by pending pods' CPU/memory requests and is blind to the
// per-node ENI pod cap. So allowing small/medium causes Karpenter to pack
// tiny system pods (cert-manager, ESO, ALB controller, …) into a t3.medium
// (17-pod ENI cap) and silently saturate at that ceiling with CPU headroom
// left over — exactly what happened 2026-05-26 when the ESO main controller
// could not schedule (no system node had a free pod slot, and Karpenter could
// not provision another node within cpuLimit:2).
//
// Floor sizes at t3.large (35 pods) and allow t3.xlarge (58 pods); raise
// cpuLimit to 8 so the pool can scale to ~2× xlarge or ~4× large. t3.small/
// medium/large all have 2 vCPU — Karpenter picks the smallest fitting by
// memory, so dropping small/medium forces ≥35 pods/node. Paired with the
// dev MNG (t3.large × 1–3) for an on-demand bootstrap landing zone.
const DEV_KARPENTER_SYSTEM: EksKarpenterSystemPoolConfig = {
    instanceFamily: ['t3'],
    instanceSizes: ['large', 'xlarge'],
    capacityType: ['spot'],
    architectures: ['amd64'],
    cpuLimit: 8,
} as const;

// SSM paths holding admin-principal ARNs per environment. Populate manually:
//   aws ssm put-parameter --name /cdk-monitoring/development/eks/admin-principal-arns \
//     --type StringList --value "arn:aws:iam::...,arn:aws:iam::..." --profile <profile>
// Keeps account IDs and SSO role hashes out of source control.
export const EKS_ADMIN_PRINCIPAL_ARNS_SSM_PATHS: Record<DeployableEnvironment, string> = {
    [Environment.DEVELOPMENT]: '/cdk-monitoring/development/eks/admin-principal-arns',
    [Environment.STAGING]: '/cdk-monitoring/staging/eks/admin-principal-arns',
    [Environment.PRODUCTION]: '/cdk-monitoring/production/eks/admin-principal-arns',
};

export const EKS_CONFIGS: Record<DeployableEnvironment, Omit<EksConfig, 'adminPrincipalArns'>> = {
    [Environment.DEVELOPMENT]: {
        clusterName: 'k8s-eks-development',
        version: EKS_VERSION,
        // Landing zone: on-demand t3.large hosts the Karpenter controller,
        // CoreDNS, and other cluster-critical pods that should not run on
        // spot. t3.large gives 35 pods/node ENI capacity (vs t3.medium's
        // 17 — the per-node pod cap that previously starved the system tier
        // when small/medium nodes filled at the ENI ceiling). All other
        // system pods (argocd, ESO, cert-manager, …) land on the elastic
        // spot `system` Karpenter NodePool. maxSize 3 is rolling-update
        // surge headroom (one extra node during MNG instance-type rotation).
        mng: { instanceTypes: ['t3.large'], desiredSize: 1, minSize: 1, maxSize: 3, diskSizeGib: 30 },
        podIdentityBindings: COMMON_BINDINGS,
        karpenter: DEV_KARPENTER,
        systemPool: DEV_KARPENTER_SYSTEM,
        versions: COMMON_VERSIONS,
        grafanaAlertingTopicArn: 'arn:aws:sns:eu-west-1:771826808455:k8s-bootstrap-alarm',
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
        mng: { instanceTypes: ['t3.large'], desiredSize: 3, minSize: 3, maxSize: 6, diskSizeGib: 30 },
        podIdentityBindings: COMMON_BINDINGS,
        karpenter: COMMON_KARPENTER,
        versions: COMMON_VERSIONS,
    },
};

export function getEksConfig(
    env: Environment,
    adminPrincipalArns: readonly string[] = [],
): EksConfig {
    if (env === Environment.MANAGEMENT) {
        throw new Error('EKS not deployed to management env');
    }
    return { ...EKS_CONFIGS[env as DeployableEnvironment], adminPrincipalArns };
}
