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
    readonly instanceCategory: readonly string[];
    readonly instanceFamily: readonly string[];
    readonly capacityType: readonly ('on-demand' | 'spot')[];
    readonly architectures: readonly string[];
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
    capacityType: ['on-demand'],
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
