/**
 * @format
 * Kubernetes (kubeadm) Project - Resource Configurations
 *
 * Centralized resource configurations (policies, retention, instance sizing) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getK8sConfigs } from '../../config/k8s';
 * const configs = getK8sConfigs(Environment.DEVELOPMENT);
 * const instanceType = configs.instanceType; // 't3.medium'
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';

// =============================================================================
// KUBERNETES CONSTANTS
//
// K8s-specific port numbers, versions, and tags.
// Moved from config/defaults.ts — these belong with the K8s config.
// =============================================================================

/** Kubernetes API server port (standard for kubeadm) */
export const K8S_API_PORT = 6443;

/** Kubernetes version for kubeadm installation */
export const KUBERNETES_VERSION = '1.35.1';

/** Traefik HTTP port (deployed via manifests) */
export const TRAEFIK_HTTP_PORT = 80;

/** Traefik HTTPS port (deployed via manifests) */
export const TRAEFIK_HTTPS_PORT = 443;

/**
 * Tag used by DLM, EBS volumes, and EC2 instances for consistent identification.
 * DLM snapshot policies target volumes with this tag — all three locations
 * must stay in sync or backups silently stop.
 */
export const MONITORING_APP_TAG = {
    key: 'Application',
    value: 'Prometheus-Grafana',
} as const;

// =============================================================================
// ENVIRONMENT VARIABLE HELPER
// =============================================================================

/**
 * Read a value from process.env at synth time.
 * Returns undefined if the variable is not set.
 */
function fromEnv(key: string): string | undefined {
    return process.env[key] || undefined;
}

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Kubernetes cluster configuration (kubeadm)
 */
export interface KubernetesClusterConfig {
    /** Kubernetes version (e.g., '1.32.0') */
    readonly kubernetesVersion: string;
    /** Pod network CIDR for Calico CNI @default '192.168.0.0/16' */
    readonly podNetworkCidr: string;
    /** Service subnet CIDR @default '10.96.0.0/12' */
    readonly serviceSubnet: string;
    /** Kubernetes data directory (should be on persistent storage) */
    readonly dataDir: string;
    /** Number of worker nodes @default 1 */
    readonly workerCount: number;
}

/**
 * EC2 compute configuration for Kubernetes nodes
 */
export interface K8sComputeConfig {
    /** EC2 instance type */
    readonly instanceType: ec2.InstanceType;
    /** Root EBS volume size in GB (must be >= Golden AMI snapshot size) @default 30 */
    readonly rootVolumeSizeGb: number;
    /** Whether to enable detailed CloudWatch monitoring */
    readonly detailedMonitoring: boolean;
    /** Whether to use CloudFormation signals for ASG */
    readonly useSignals: boolean;
    /** Timeout for CloudFormation signals in minutes */
    readonly signalsTimeoutMinutes: number;
}

/**
 * Storage configuration for Kubernetes data (EBS volume)
 */
export interface K8sStorageConfig {
    /** EBS volume size in GB */
    readonly volumeSizeGb: number;
    /** EBS mount point on the instance */
    readonly mountPoint: string;
}

/**
 * Networking configuration
 */
export interface K8sNetworkingConfig {
    /** Whether to allocate an Elastic IP for stable CloudFront origin */
    readonly useElasticIp: boolean;
    /** Security group: SSM-only access (no SSH) */
    readonly ssmOnlyAccess: boolean;
}

/**
 * Golden AMI configuration (EC2 Image Builder)
 *
 * Controls the AMI baking pipeline that pre-installs Docker, AWS CLI,
 * kubeadm toolchain, and Calico manifests to reduce instance boot time.
 */
export interface K8sImageConfig {
    /** SSM parameter path storing the latest Golden AMI ID */
    readonly amiSsmPath: string;
    /** Whether to create the Image Builder pipeline (first run bootstraps) */
    readonly enableImageBuilder: boolean;
    /** Parent image for Image Builder (base Amazon Linux 2023 AMI) */
    readonly parentImageSsmPath: string;
    /** Software versions to bake into the AMI */
    readonly bakedVersions: {
        readonly dockerCompose: string;
        readonly awsCli: string;
        /** kubeadm/kubelet/kubectl version (matches kubernetesVersion) */
        readonly kubeadm: string;
        /** Container runtime version (tightly coupled to k8s release) */
        readonly containerd: string;
        /** OCI runtime version */
        readonly runc: string;
        /** CNI plugins version */
        readonly cniPlugins: string;
        /** CRI tools version (crictl — should match k8s minor version) */
        readonly crictl: string;
        /** Calico CNI version (with 'v' prefix, e.g. 'v3.29.3') */
        readonly calico: string;
        /**
         * ECR credential provider version (with 'v' prefix, e.g. 'v1.31.0').
         * Pinned to v1.31.0 — the last version with published standalone binaries.
         * The credential provider plugin API is stable and version-independent.
         */
        readonly ecrCredentialProvider: string;
        /**
         * K8sGPT version (without 'v' prefix, e.g. '0.4.29').
         * AI-powered Kubernetes diagnostics tool used by the self-healing
         * pipeline's analyse-cluster-health Lambda via SSM SendCommand.
         */
        readonly k8sgpt: string;
    };
}

/**
 * SSM State Manager configuration
 *
 * Controls post-boot configuration management via SSM associations.
 * State Manager handles tasks like kubeadm bootstrap, CNI installation,
 * manifest deployment, and drift remediation.
 */
export interface K8sSsmConfig {
    /** Whether to create SSM State Manager associations */
    readonly enableStateManager: boolean;
    /** Association schedule (rate expression, e.g., 'rate(30 minutes)') */
    readonly associationSchedule: string;
    /** Maximum concurrent targets for association execution */
    readonly maxConcurrency: string;
    /** Maximum allowed errors before stopping */
    readonly maxErrors: string;
}

/**
 * Monitoring worker node configuration
 *
 * Dedicated worker node for K8s-native monitoring workloads
 * (Prometheus Operator, Grafana, Loki, Tempo).
 */
export interface MonitoringWorkerConfig {
    /** EC2 instance type for the monitoring worker */
    readonly instanceType: ec2.InstanceType;
    /** Kubernetes node label for workload placement (observability, not exclusive) */
    readonly nodeLabel: string;
    /** Whether to enable detailed CloudWatch monitoring */
    readonly detailedMonitoring: boolean;
    /** Whether to use CloudFormation signals for ASG */
    readonly useSignals: boolean;
    /** Timeout for CloudFormation signals in minutes */
    readonly signalsTimeoutMinutes: number;
    /** EBS root volume size in GB */
    readonly rootVolumeSizeGb: number;
    /** Whether to use EC2 Spot instances for cost optimisation */
    readonly useSpotInstances: boolean;
}

/**
 * ArgoCD worker node configuration
 *
 * Dedicated worker node for ArgoCD GitOps controller.
 * Runs on a Spot instance for cost optimisation.
 * ArgoCD UI is still accessible via ops.nelsonlamounier.com/argocd
 * through Traefik ingress on other nodes (Kubernetes service routing).
 *
 * @deprecated Will be removed after the K8s-native worker migration.
 *             ArgoCD is consolidated into the general pool.
 */
export interface ArgocdWorkerConfig {
    /** EC2 instance type for the ArgoCD worker */
    readonly instanceType: ec2.InstanceType;
    /** Kubernetes node label for workload placement */
    readonly nodeLabel: string;
    /** Whether to use EC2 Spot instances for cost savings */
    readonly useSpotInstances: boolean;
    /** Whether to enable detailed CloudWatch monitoring */
    readonly detailedMonitoring: boolean;
    /** Whether to use CloudFormation signals for ASG */
    readonly useSignals: boolean;
    /** Timeout for CloudFormation signals in minutes */
    readonly signalsTimeoutMinutes: number;
    /** EBS root volume size in GB */
    readonly rootVolumeSizeGb: number;
}

/**
 * Generic ASG worker pool configuration (K8s-native worker architecture).
 *
 * Used for both the `general` and `monitoring` pools.
 * Replaces the named MonitoringWorkerConfig and ArgocdWorkerConfig once migration
 * is complete.
 */
export interface KubernetesWorkerPoolConfig {
    /** EC2 instance type — defaults to t3.small (general) or t3.medium (monitoring) */
    readonly instanceType: ec2.InstanceType;
    /** Minimum ASG capacity @default 1 */
    readonly minCapacity: number;
    /** Maximum ASG capacity @default 4 (general) | 2 (monitoring) */
    readonly maxCapacity: number;
    /** Whether to use EC2 Spot instances @default true */
    readonly useSpotInstances: boolean;
    /** EBS root volume size in GB @default 30 */
    readonly rootVolumeSizeGb: number;
    /** Whether to enable detailed CloudWatch monitoring @default false */
    readonly detailedMonitoring: boolean;
    /** Whether to use CloudFormation signals @default true */
    readonly useSignals: boolean;
    /** CloudFormation signals timeout in minutes @default 40 */
    readonly signalsTimeoutMinutes: number;
}

/**
 * Configuration for both generic ASG worker pools.
 */
export interface KubernetesWorkerPoolsConfig {
    /** General-purpose pool: Next.js, tucaken-app, ArgoCD, system components */
    readonly general: KubernetesWorkerPoolConfig;
    /** Monitoring pool: Prometheus, Grafana, Loki, Tempo, Alloy */
    readonly monitoring: KubernetesWorkerPoolConfig;
}

// =============================================================================
// SECURITY GROUP CONFIGURATION (Data-Driven Port Rules)
// =============================================================================

/**
 * A single port rule for a Kubernetes Security Group.
 *
 * Each rule maps to one `addIngressRule()` call. The `source` discriminator
 * determines the peer type at construct time:
 * - `'self'`    → self-referencing (intra-cluster communication)
 * - `'vpcCidr'` → `ec2.Peer.ipv4(vpc.vpcCidrBlock)`
 * - `'podCidr'` → `ec2.Peer.ipv4(podNetworkCidr)`
 */
export interface K8sPortRule {
    /** Start port (or single port when endPort is omitted) */
    readonly port: number;
    /** End port for a range — creates `tcpRange(port, endPort)` */
    readonly endPort?: number;
    /** Transport protocol */
    readonly protocol: 'tcp' | 'udp';
    /** Source type for the ingress peer */
    readonly source: 'self' | 'vpcCidr' | 'podCidr' | 'anyIpv4';
    /** Human-readable description for the SG rule */
    readonly description: string;
}

/**
 * Security group role configuration — rules and outbound behavior.
 */
export interface K8sSecurityGroupRoleConfig {
    /** Whether to allow all outbound traffic */
    readonly allowAllOutbound: boolean;
    /** Port rules for this security group */
    readonly rules: K8sPortRule[];
}

/**
 * Complete security group configuration for the Kubernetes cluster.
 *
 * All 4 SGs are config-driven. CloudFront prefix list and admin IP
 * rules are added post-loop in base-stack since they need runtime values.
 */
export interface K8sSecurityGroupConfig {
    /** Cluster base SG — intra-cluster communication (all nodes) */
    readonly clusterBase: K8sSecurityGroupRoleConfig;
    /** Control plane SG — K8s API server access */
    readonly controlPlane: K8sSecurityGroupRoleConfig;
    /** Ingress SG — Traefik HTTP/HTTPS (static rules only; CloudFront + admin IPs added at runtime) */
    readonly ingress: K8sSecurityGroupRoleConfig;
    /** Monitoring SG — Prometheus, Node Exporter, Loki, Tempo */
    readonly monitoring: K8sSecurityGroupRoleConfig;
}

export interface K8sEdgeConfig {
    // Synth-time context — DNS/Edge (env var > hardcoded default)
    /** Domain name for monitoring CloudFront distribution */
    readonly domainName?: string;
    /** Route53 Hosted Zone ID for DNS validation and alias records */
    readonly hostedZoneId?: string;
    /** Cross-account IAM role ARN for Route53 access */
    readonly crossAccountRoleArn?: string;

    // WAF configuration
    /** WAF rate limit per IP per 5 minutes @default 2000 */
    readonly rateLimitPerIp: number;
    /** Enable WAF rate limiting @default true */
    readonly enableRateLimiting: boolean;
    /** Enable IP reputation list @default true */
    readonly enableIpReputationList: boolean;
    /** Admin services subdomain prefix (e.g., 'ops' -> ops.nelsonlamounier.com) */
    readonly opsSubdomain?: string;
    /** Root domain for ops DNS record (e.g., 'nelsonlamounier.com') */
    readonly baseDomain?: string;
    /** GitHub Actions ARC webhook subdomain (e.g., 'runners' -> runners.nelsonlamounier.com → EIP) */
    readonly runnersSubdomain?: string;
    /**
     * Loki push endpoint subdomain (e.g., 'loki-push' -> loki-push.nelsonlamounier.com → EIP).
     * Set on a single env (dev) — that cluster is the canonical log sink for
     * all environments. Staging/prod log shippers push to the same hostname.
     */
    readonly lokiPushSubdomain?: string;
    /**
     * Prometheus Pushgateway subdomain (e.g., 'pushgateway' -> pushgateway.nelsonlamounier.com → EIP).
     * Same single-env (dev) ownership rule as lokiPushSubdomain — that
     * cluster is the canonical metrics sink for all environments.
     */
    readonly pushgatewaySubdomain?: string;
    /**
     * MTTR webhook subdomain (e.g., 'mttr-webhook' -> mttr-webhook.nelsonlamounier.com → EIP).
     * Same single-env (dev) ownership rule — the cluster that owns this DNS
     * is the canonical incident-ingest endpoint for all environments.
     */
    readonly mttrWebhookSubdomain?: string;
}

/**
 * Complete resource configurations for kubeadm Kubernetes project
 */
export interface K8sConfigs {
    readonly cluster: KubernetesClusterConfig;
    readonly compute: K8sComputeConfig;
    readonly storage: K8sStorageConfig;
    readonly networking: K8sNetworkingConfig;
    readonly securityGroups: K8sSecurityGroupConfig;
    readonly image: K8sImageConfig;
    readonly ssm: K8sSsmConfig;
    readonly edge: K8sEdgeConfig;
    /**
     * @deprecated Legacy single-node worker config — kept during migration window.
     *             Will be removed once MonitoringWorker stack is decommissioned.
     */
    readonly monitoringWorker: MonitoringWorkerConfig;
    /**
     * @deprecated Legacy single-node worker config — kept during migration window.
     *             Will be removed once ArgocdWorker stack is decommissioned.
     */
    readonly argocdWorker: ArgocdWorkerConfig;
    /** K8s-native ASG worker pools (general + monitoring). Replaces legacy workers. */
    readonly workerPools: KubernetesWorkerPoolsConfig;
    readonly logRetention: logs.RetentionDays;
    readonly isProduction: boolean;
    readonly removalPolicy: cdk.RemovalPolicy;
    readonly createKmsKeys: boolean;
}

// =============================================================================
// DEFAULT SECURITY GROUP RULES
//
// All K8s-specific ports extracted from base-stack.ts inline rules.
// Shared by all environments — override per-environment if needed.
// =============================================================================

/**
 * Default security group configuration for Kubernetes clusters.
 *
 * All 4 SGs are defined here with their static rules. The Ingress SG
 * includes static rules only (HTTP from anyIpv4). Runtime-dependent rules
 * (CloudFront managed prefix list, admin IPs from `/admin/allowed-ips` SSM
 * parameter) are added imperatively in `base-stack.ts` after the config-driven
 * loop because they require deploy-time API lookups or synth-time SSM resolution.
 */
const DEFAULT_K8S_SECURITY_GROUPS: K8sSecurityGroupConfig = {
    clusterBase: {
        allowAllOutbound: true,
        rules: [
            // ----- Self-referencing (intra-cluster) -----
            { port: 2379, endPort: 2380, protocol: 'tcp', source: 'self', description: 'etcd client and peer (intra-cluster)' },
            { port: 6443, protocol: 'tcp', source: 'vpcCidr', description: 'K8s API server (intra-cluster / VPC)' },
            { port: 10250, protocol: 'tcp', source: 'self', description: 'kubelet API (intra-cluster)' },
            { port: 10257, protocol: 'tcp', source: 'self', description: 'kube-controller-manager (intra-cluster)' },
            { port: 10259, protocol: 'tcp', source: 'self', description: 'kube-scheduler (intra-cluster)' },
            { port: 4789, protocol: 'udp', source: 'self', description: 'VXLAN overlay networking (intra-cluster)' },
            { port: 179, protocol: 'tcp', source: 'self', description: 'Calico BGP peering (intra-cluster)' },
            { port: 30000, endPort: 32767, protocol: 'tcp', source: 'self', description: 'NodePort services (intra-cluster)' },
            { port: 53, protocol: 'tcp', source: 'self', description: 'CoreDNS TCP (intra-cluster)' },
            { port: 53, protocol: 'udp', source: 'self', description: 'CoreDNS UDP (intra-cluster)' },
            { port: 5473, protocol: 'tcp', source: 'self', description: 'Calico Typha (intra-cluster)' },
            { port: 9100, protocol: 'tcp', source: 'self', description: 'Traefik metrics (intra-cluster)' },
            { port: 9101, protocol: 'tcp', source: 'self', description: 'Node Exporter metrics (intra-cluster)' },
            // ----- Pod CIDR → node (kube-proxy DNAT preserves pod source IP) -----
            { port: 6443, protocol: 'tcp', source: 'podCidr', description: 'K8s API server (from pods)' },
            { port: 10250, protocol: 'tcp', source: 'podCidr', description: 'kubelet API (from pods)' },
            { port: 53, protocol: 'udp', source: 'podCidr', description: 'CoreDNS UDP (from pods)' },
            { port: 53, protocol: 'tcp', source: 'podCidr', description: 'CoreDNS TCP (from pods)' },
            { port: 9100, protocol: 'tcp', source: 'podCidr', description: 'Traefik metrics (from pods)' },
            { port: 9101, protocol: 'tcp', source: 'podCidr', description: 'Node Exporter metrics (from pods)' },
        ],
    },
    controlPlane: {
        allowAllOutbound: false,
        rules: [
            { port: 6443, protocol: 'tcp', source: 'vpcCidr', description: 'K8s API from VPC (SSM port-forwarding)' },
        ],
    },
    monitoring: {
        allowAllOutbound: false,
        rules: [
            { port: 9090, protocol: 'tcp', source: 'vpcCidr', description: 'Prometheus metrics from VPC' },
            { port: 9100, protocol: 'tcp', source: 'vpcCidr', description: 'Node Exporter metrics from VPC' },
            { port: 9100, protocol: 'tcp', source: 'podCidr', description: 'Node Exporter metrics from pods (Prometheus scraping)' },
            { port: 30100, protocol: 'tcp', source: 'vpcCidr', description: 'Loki push API from VPC (cross-stack log shipping)' },
            { port: 30417, protocol: 'tcp', source: 'vpcCidr', description: 'Tempo OTLP gRPC from VPC (cross-stack trace shipping)' },
        ],
    },
    ingress: {
        allowAllOutbound: false,
        rules: [
             { port: 80, protocol: 'tcp', source: 'vpcCidr', description: 'HTTP health checks from NLB' },
        ],
    },
};

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * k8s resource configurations by environment
 */
export const K8S_CONFIGS: Record<DeployableEnvironment, K8sConfigs> = {
    [Environment.DEVELOPMENT]: {
        cluster: {
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 2,
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            rootVolumeSizeGb: 30,
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 40,
        },
        storage: {
            volumeSizeGb: 30,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        securityGroups: DEFAULT_K8S_SECURITY_GROUPS,
        image: {
            amiSsmPath: '/k8s/development/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
                ecrCredentialProvider: 'v1.31.0',
                k8sgpt: '0.4.31',
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            // Synth-time context — Edge (env var > hardcoded default)
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.dev.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            // WAF
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
            opsSubdomain: 'ops',
            baseDomain: 'nelsonlamounier.com',
            runnersSubdomain: 'runners',
            // DEV cluster owns the loki-push DNS — staging/prod log shippers
            // push to the same hostname. Leave undefined in higher envs.
            lokiPushSubdomain: 'loki-push',
            // Same single-owner rule for the Prometheus Pushgateway.
            pushgatewaySubdomain: 'pushgateway',
            // Same single-owner rule for the MTTR webhook receiver.
            mttrWebhookSubdomain: 'mttr-webhook',
        },
        monitoringWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            nodeLabel: 'workload=monitoring,environment=development',
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
            useSpotInstances: true,
        },
        argocdWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=argocd,environment=development',
            useSpotInstances: true,
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
        },
        workerPools: {
            general: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
                // Minimum 2 nodes — ensures a scheduling landing zone during
                // CA scale-down and cold-start events. CA will not shrink
                // below this floor, preventing single-point-of-failure scenarios
                // where an OOM or eviction leaves zero available nodes.
                minCapacity: 2,
                maxCapacity: 4,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: false,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
            monitoring: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                minCapacity: 1,
                maxCapacity: 2,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: false,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.STAGING]: {
        cluster: {
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 2,
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            rootVolumeSizeGb: 30,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
        },
        storage: {
            volumeSizeGb: 40,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        securityGroups: DEFAULT_K8S_SECURITY_GROUPS,
        image: {
            amiSsmPath: '/k8s/staging/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
                ecrCredentialProvider: 'v1.31.0',
                k8sgpt: '0.4.31',
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.staging.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
            opsSubdomain: 'ops',
            baseDomain: 'nelsonlamounier.com',
            runnersSubdomain: 'runners',
        },
        monitoringWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=monitoring,environment=staging',
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
            useSpotInstances: true,
        },
        argocdWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=argocd,environment=staging',
            useSpotInstances: true,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
        },
        workerPools: {
            general: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
                minCapacity: 1,
                maxCapacity: 4,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
            monitoring: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                minCapacity: 1,
                maxCapacity: 2,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.PRODUCTION]: {
        cluster: {
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 2,
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            rootVolumeSizeGb: 30,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
        },
        storage: {
            volumeSizeGb: 50,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        securityGroups: DEFAULT_K8S_SECURITY_GROUPS,
        image: {
            amiSsmPath: '/k8s/production/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
                ecrCredentialProvider: 'v1.31.0',
                k8sgpt: '0.4.31',
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
            opsSubdomain: 'ops',
            baseDomain: 'nelsonlamounier.com',
            runnersSubdomain: 'runners',
        },
        monitoringWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=monitoring,environment=production',
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
            useSpotInstances: true,
        },
        argocdWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=argocd,environment=production',
            useSpotInstances: true,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
        },
        workerPools: {
            general: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
                minCapacity: 1,
                maxCapacity: 4,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
            monitoring: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                minCapacity: 1,
                maxCapacity: 2,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get k8s configurations for an environment
 */
export function getK8sConfigs(env: Environment): K8sConfigs {
    return K8S_CONFIGS[env as DeployableEnvironment];
}
