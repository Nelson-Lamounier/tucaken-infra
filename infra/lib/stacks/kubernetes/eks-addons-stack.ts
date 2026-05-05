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

        // V1 addons must run on the system MNG (`dedicated=system:NoSchedule`)
        // because Karpenter has not yet provisioned workload nodes when these
        // charts install. Without this toleration, ALB controller pods are
        // Pending → its mutating webhook has no endpoints → every Service
        // create (including Karpenter's) fails admission.
        const systemToleration = [{ key: 'dedicated', value: 'system', effect: 'NoSchedule' }];

        new eks.HelmChart(this, 'ExternalSecrets', {
            cluster: props.cluster,
            chart: 'external-secrets',
            release: 'external-secrets',
            repository: 'https://charts.external-secrets.io',
            namespace: 'external-secrets',
            createNamespace: true,
            version: props.versions.externalSecrets,
            values: {
                serviceAccount: { name: 'external-secrets', create: true },
                tolerations: systemToleration,
                webhook: { tolerations: systemToleration },
                certController: { tolerations: systemToleration },
            },
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
                tolerations: systemToleration,
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
                tolerations: systemToleration,
            },
        });

        new eks.HelmChart(this, 'Karpenter', {
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
            values: {
                settings: {
                    clusterName: props.cluster.clusterName,
                    interruptionQueue: props.karpenterInterruptionQueueName,
                },
                serviceAccount: { name: 'karpenter', create: true },
                tolerations: systemToleration,
            },
        });

        new eks.HelmChart(this, 'EbsCsi', {
            cluster: props.cluster,
            chart: 'aws-ebs-csi-driver',
            release: 'aws-ebs-csi-driver',
            repository: 'https://kubernetes-sigs.github.io/aws-ebs-csi-driver',
            namespace: 'kube-system',
            version: props.versions.ebsCsi,
            values: {
                controller: {
                    serviceAccount: { name: 'ebs-csi-controller-sa', create: true },
                    tolerations: systemToleration,
                },
            },
        });
    }
}
