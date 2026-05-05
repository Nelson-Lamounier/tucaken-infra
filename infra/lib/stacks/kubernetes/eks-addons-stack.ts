/**
 * @format
 * EKS Addons Stack — Helm-installed cluster addons.
 *
 * Order: VPC CNI (managed) → ESO → ALB controller → external-dns → Karpenter
 * → EBS CSI. ServiceAccounts referenced by `EksPodIdentityStack`.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 3.3
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksAddonsStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly vpcId: string;
    readonly region: string;
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

        // EKS Pod Identity Agent — DaemonSet on every node that exchanges
        // service-account tokens for AWS creds at 169.254.170.23/v1/credentials.
        // Without it, every pod with a PodIdentityAssociation hangs trying to
        // fetch AWS creds during init (Karpenter, ALB controller, ESO, etc.
        // all fail liveness/readiness probes). This is an AWS-managed addon
        // distinct from CfnPodIdentityAssociation, which only sets up the
        // role-to-SA mapping at the EKS control-plane level.
        const podIdentityAgent = new eks.CfnAddon(this, 'PodIdentityAgent', {
            clusterName: props.cluster.clusterName,
            addonName: 'eks-pod-identity-agent',
            resolveConflicts: 'OVERWRITE',
        });

        // V1 addons must run on the system MNG (`dedicated=system:NoSchedule`)
        // because Karpenter has not yet provisioned workload nodes when these
        // charts install. Without this toleration, ALB controller pods are
        // Pending → its mutating webhook has no endpoints → every Service
        // create (including Karpenter's) fails admission.
        const systemToleration = [{ key: 'dedicated', value: 'system', effect: 'NoSchedule' }];

        // Namespaces hosting infrastructure addons. The ALB controller's
        // mutating Service webhook is scoped to NOT intercept these — it
        // only acts on application-namespace Services. This avoids two
        // failure modes:
        //   1. Bootstrap chicken-and-egg: ESO/Karpenter/etc. create Services
        //      during install; ALB webhook (failurePolicy=Fail) blocks them
        //      until ALB pods are Ready. Without scoping, every infra chart
        //      install must serialize behind ALB readiness.
        //   2. Recovery scenarios: any time ALB pods restart (node refresh,
        //      OOM, eviction), the webhook briefly has no endpoints. Without
        //      scoping, that window blocks every cluster-wide Service create
        //      — the cluster brown-outs every time ALB churns.
        // Application namespaces (admin-api, ingestion, etc. — Plan 5) stay
        // in scope because that's where ALB-managed Services actually live.
        const infraNamespacesExcludedFromAlbWebhook = [
            'kube-system',
            'external-secrets',
            'karpenter',
            'argocd',  // Plan 4 / 5 — pre-allocated.
        ];
        const albWebhookNamespaceSelectors = [
            {
                key: 'kubernetes.io/metadata.name',
                operator: 'NotIn',
                values: infraNamespacesExcludedFromAlbWebhook,
            },
        ];

        // ALB controller installs FIRST among Helm charts (after the EKS
        // managed addons). Every other chart depends on it so that even
        // though the webhook is scoped out of infra namespaces, the
        // controller's IAM/Pod Identity is fully wired before workload
        // charts (Plan 5) start landing. ALB itself depends on the Pod
        // Identity Agent — without it, the controller cannot fetch AWS
        // credentials and hangs at startup.
        const albController = new eks.HelmChart(this, 'AlbController', {
            cluster: props.cluster,
            chart: 'aws-load-balancer-controller',
            release: 'aws-load-balancer-controller',
            repository: 'https://aws.github.io/eks-charts',
            namespace: 'kube-system',
            version: props.versions.albController,
            wait: true,
            values: {
                clusterName: props.cluster.clusterName,
                // Pass vpcId + region explicitly. EKS-optimized AL2023 nodes
                // default IMDSv2 hop-limit=1 → pod containers get 401 from
                // IMDS; without these values the ALB controller crashes at
                // boot trying to introspect the VPC.
                vpcId: props.vpcId,
                region: props.region,
                serviceAccount: { name: 'aws-load-balancer-controller', create: true },
                tolerations: systemToleration,
                // Scope mutating webhooks to application namespaces only.
                webhookNamespaceSelectors: albWebhookNamespaceSelectors,
            },
        });
        albController.node.addDependency(podIdentityAgent);

        const eso = new eks.HelmChart(this, 'ExternalSecrets', {
            cluster: props.cluster,
            chart: 'external-secrets',
            release: 'external-secrets',
            repository: 'https://charts.external-secrets.io',
            namespace: 'external-secrets',
            createNamespace: true,
            version: props.versions.externalSecrets,
            wait: true,
            values: {
                serviceAccount: { name: 'external-secrets', create: true },
                tolerations: systemToleration,
                webhook: { tolerations: systemToleration },
                certController: { tolerations: systemToleration },
            },
        });
        eso.node.addDependency(albController);

        const externalDns = new eks.HelmChart(this, 'ExternalDns', {
            cluster: props.cluster,
            chart: 'external-dns',
            release: 'external-dns',
            repository: 'https://kubernetes-sigs.github.io/external-dns/',
            namespace: 'kube-system',
            version: props.versions.externalDns,
            wait: true,
            values: {
                provider: 'aws',
                domainFilters: [props.hostedZoneDomain],
                policy: 'upsert-only',
                txtOwnerId: `eks-${props.targetEnvironment}`,
                serviceAccount: { name: 'external-dns', create: true },
                tolerations: systemToleration,
            },
        });
        externalDns.node.addDependency(albController);

        const karpenter = new eks.HelmChart(this, 'Karpenter', {
            cluster: props.cluster,
            chart: 'karpenter',
            release: 'karpenter',
            // OCI Helm repo: full chart path (registry/namespace/chart) — CDK
            // appends `:version` directly to `repository` for oci:// scheme,
            // dropping the `chart` field. Without the second `/karpenter`,
            // helm fetches `public.ecr.aws/karpenter:<version>` and 404s.
            repository: 'oci://public.ecr.aws/karpenter/karpenter',
            namespace: 'karpenter',
            createNamespace: true,
            version: props.versions.karpenter,
            wait: true,
            values: {
                settings: {
                    clusterName: props.cluster.clusterName,
                    interruptionQueue: props.karpenterInterruptionQueueName,
                },
                serviceAccount: { name: 'karpenter', create: true },
                tolerations: systemToleration,
            },
        });
        karpenter.node.addDependency(albController);
        karpenter.node.addDependency(eso);

        // EBS CSI driver as a managed addon (NOT Helm). EKS keeps its
        // sidecar images in lock-step with the cluster Kubernetes version
        // — the Helm chart pinned us to images for K8s 1.31 sidecars
        // (e.g. csi-attacher v4.7.0-eks-1-31-3) which fail with
        // 'flag provided but not defined: -feature-gates' on a 1.34
        // cluster. Managed addon side-steps the entire compatibility
        // matrix and re-uses the same Pod Identity ServiceAccount we
        // declared in EksPodIdentityStack (kube-system/ebs-csi-controller-sa).
        new eks.CfnAddon(this, 'EbsCsi', {
            clusterName: props.cluster.clusterName,
            addonName: 'aws-ebs-csi-driver',
            resolveConflicts: 'OVERWRITE',
        });
    }
}
