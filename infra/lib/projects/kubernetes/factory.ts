/**
 * @format
 * Kubernetes Project Factory
 *
 * Creates shared Kubernetes infrastructure hosting both monitoring and
 * application workloads on a kubeadm Kubernetes cluster.
 *
 * Stack Architecture (8 stacks):
 *   1.  Kubernetes-Data:          DynamoDB, S3 Assets, SSM parameters
 *   2.  Kubernetes-Base:          VPC, Security Group, KMS, EBS, Elastic IP
 *   3.  Kubernetes-ControlPlane:  Control plane EC2 (t3.medium), ASG, IAM
 *   3b. Kubernetes-GeneralPool:   Kubernetes-native worker ASG (Next.js, ArgoCD)
 *   3c. Kubernetes-MonitoringPool: Kubernetes-native worker ASG (Prometheus, Grafana)
 *   4.  Kubernetes-AppIam:        Application-tier IAM grants (DynamoDB, S3, Secrets)
 *   5.  Kubernetes-API:           API Gateway + Lambda (email subscriptions)
 *   6.  Kubernetes-Edge:          ACM + WAF + CloudFront (us-east-1)
 *   7.  Kubernetes-Observability: CloudWatch pre-deployment dashboard
 *
 * Worker nodes are Kubernetes-native ASG pools. CDK provisions the Launch
 * Template and Auto Scaling Group; the K8s bootstrap script handles kubeadm
 * join, node labelling, and taint application automatically.
 *
 * Workload isolation is enforced at the Kubernetes layer via Namespaces,
 * NetworkPolicies, ResourceQuotas, and PriorityClasses.
 *
 * Usage:
 *   npx cdk synth -c project=k8s -c environment=dev
 */

import * as cdk from 'aws-cdk-lib/core';

import { getEksConfig, EKS_ADMIN_PRINCIPAL_ARNS_SSM_PATHS } from '../../config/eks';
import {
    Environment,
    cdkEnvironment,
    getEnvironmentConfig,
} from '../../config/environments';
import { getK8sConfigs } from '../../config/kubernetes';
import { getNextJsConfigs } from '../../config/nextjs';
import { Project, getProjectConfig } from '../../config/projects';
import { nextjsSsmPaths } from '../../config/ssm-paths';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    EksAccessStack,
    EksAddonsStack,
    EksAlbCertsStack,
    EksPublicWafStack,
    EksClusterStack,
    EksKarpenterStack,
    EksPodIdentityStack,
    EksSystemNodeGroupStack,
    KubernetesBaseStack,
    KubernetesDataStack,
    PlatformRdsStack,
} from '../../stacks/kubernetes';
import { NextJsApiStack } from '../../stacks/kubernetes/api-stack';
import { stackId, flatName } from '../../utilities/naming';

// =============================================================================
// FACTORY CONTEXT
// =============================================================================

/**
 * Factory context for Kubernetes project.
 */
export interface KubernetesFactoryContext extends ProjectFactoryContext {
    /** Target environment (inherited from base) */
    readonly environment: Environment;

    /** Override domain name for edge stack */
    readonly domainName?: string;

    /** Override hosted zone ID for edge stack */
    readonly hostedZoneId?: string;

    /** Override cross-account role ARN for edge stack */
    readonly crossAccountRoleArn?: string;

    /** Additional domains for certificate SANs */
    readonly subjectAlternativeNames?: string[];

    // =========================================================================
    // Tucaken edge configuration
    //
    // Tucaken is a separate customer-facing SaaS hosted on the same K8s
    // cluster but with its own edge (CloudFront, WAF, ACM cert, origin
    // secret). Hosted zones live in the root account alongside
    // nelsonlamounier.com — same crossAccountRoleArn is reused.
    //
    // Source: GitHub Environment secrets/vars
    //   TUCAKEN_IO_HOSTED_ZONE_ID, TUCAKEN_COM_HOSTED_ZONE_ID
    //   TUCAKEN_IO_DOMAIN (default 'tucaken.io')
    //   TUCAKEN_COM_DOMAIN (default 'tucaken.com')
    // =========================================================================
    readonly tucakenIoDomain?: string;
    readonly tucakenComDomain?: string;
    readonly tucakenIoHostedZoneId?: string;
    readonly tucakenComHostedZoneId?: string;

    // API stack email configuration
    /** Override notification email from config */
    readonly notificationEmail?: string;
    /** Override SES from email from config */
    readonly sesFromEmail?: string;
    /** Override verification secret from config */
    readonly verificationSecret?: string;
    /** Override verification base URL from config */
    readonly verificationBaseUrl?: string;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Kubernetes project factory.
 * Creates Data, Compute, API, and Edge stacks for a shared kubeadm cluster.
 *
 * @example
 * ```typescript
 * const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
 * factory.createAllStacks(app, { environment: Environment.DEVELOPMENT });
 * ```
 */
export class KubernetesProjectFactory implements IProjectFactory<KubernetesFactoryContext> {
    readonly project = Project.KUBERNETES;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.KUBERNETES).namespace;
    }

    /**
     * Create all stacks for the Kubernetes project.
     */
    createAllStacks(scope: cdk.App, context: KubernetesFactoryContext): ProjectStackFamily {
        const environment = context.environment ?? this.environment;
        const _envConfig = getEnvironmentConfig(environment);
        const configs = getK8sConfigs(environment);
        const nextjsConfig = getNextJsConfigs(environment);

        const namePrefix = flatName('k8s', '', environment);
        const env = cdkEnvironment(environment);
        const ssmPrefix = `/k8s/${environment}`;

        // =================================================================
        // Resolve Next.js application config
        //
        // SSM paths and edge configuration for the API stack.
        // =================================================================
        const nextjsNamePrefix = 'nextjs';
        const ssmPaths = nextjsSsmPaths(environment, nextjsNamePrefix);

        // Bedrock content table SSM path — DynamoDB was consolidated into
        // AiContentStack (bedrock project). The API stack discovers the
        // table name via this SSM parameter instead of the removed nextjs path.
        const bedrockNamePrefix = flatName('bedrock', '', environment);
        const bedrockContentTableSsmPath = `/${bedrockNamePrefix}/content-table-name`;

        // Edge configuration (context override > Next.js config)
        const edgeConfig = {
            domainName: context.domainName ?? nextjsConfig.domainName,
            hostedZoneId: context.hostedZoneId ?? nextjsConfig.hostedZoneId,
            crossAccountRoleArn: context.crossAccountRoleArn ?? nextjsConfig.crossAccountRoleArn,
        };

        // Soft validation — warn if edge config is incomplete
        if (!edgeConfig.domainName || !edgeConfig.hostedZoneId || !edgeConfig.crossAccountRoleArn) {
            const missing: string[] = [];
            if (!edgeConfig.domainName) missing.push('domainName (DOMAIN_NAME)');
            if (!edgeConfig.hostedZoneId) missing.push('hostedZoneId (HOSTED_ZONE_ID)');
            if (!edgeConfig.crossAccountRoleArn) missing.push('crossAccountRoleArn (CROSS_ACCOUNT_ROLE_ARN)');
            cdk.Annotations.of(scope).addWarning(
                `Edge config incomplete: ${missing.join(', ')}. ` +
                `Edge stack will fail if deployed without these values.`,
            );
        }

        // Email / secrets configuration (context override > config)
        const emailConfig = {
            notificationEmail: context.notificationEmail ?? nextjsConfig.notificationEmail,
            sesFromEmail: context.sesFromEmail ?? nextjsConfig.sesFromEmail,
            verificationBaseUrl: context.verificationBaseUrl ?? nextjsConfig.verificationBaseUrl,
            verificationSecret: context.verificationSecret ?? nextjsConfig.verificationSecret,
        };

        // Soft validation — warn if email config is incomplete
        if (!emailConfig.notificationEmail || !emailConfig.sesFromEmail || !emailConfig.verificationSecret) {
            const missing: string[] = [];
            if (!emailConfig.notificationEmail) missing.push('notificationEmail (NOTIFICATION_EMAIL)');
            if (!emailConfig.sesFromEmail) missing.push('sesFromEmail (SES_FROM_EMAIL)');
            if (!emailConfig.verificationSecret) missing.push('verificationSecret (VERIFICATION_SECRET)');
            cdk.Annotations.of(scope).addWarning(
                `Email config incomplete: ${missing.join(', ')}. ` +
                `API stack will fail if deployed without these values.`,
            );
        }

        const stacks: cdk.Stack[] = [];
        const stackMap: Record<string, cdk.Stack> = {};

        // =================================================================
        // Stack 1: DATA STACK (DynamoDB + S3 + SSM)
        //
        // Data layer for the Next.js application running on Kubernetes.
        // Rarely changes — deployed once per environment.
        // =================================================================
        const dataStack = new KubernetesDataStack(
            scope,
            stackId(this.namespace, 'Data', environment),
            {
                targetEnvironment: environment,
                projectName: nextjsNamePrefix,
                env,
            },
        );
        stacks.push(dataStack);
        stackMap.data = dataStack;

        // =================================================================
        // Stack 2: BASE STACK (VPC, SG, KMS, EBS, EIP — "The Base")
        //
        // Long-lived infrastructure that rarely changes. Decoupled from
        // the runtime compute stack to avoid unnecessary deployments.
        // Admin IPs for ingress SG are sourced from SSM (/admin/allowed-ips)
        // at synth time — no env vars needed.
        // =================================================================
        const baseStack = new KubernetesBaseStack(
            scope,
            stackId(this.namespace, 'Base', environment),
            {
                env,
                description: `Kubernetes base infrastructure (VPC, SG, EBS, EIP) - ${environment}`,
                targetEnvironment: environment,
                configs,
                namePrefix,
                ssmPrefix,
            },
        );
        stacks.push(baseStack);
        stackMap.base = baseStack;

        // =================================================================
        // Stack 4b: PLATFORM RDS STACK
        //
        // Single PostgreSQL 16 + pgvector instance in SharedVpc.
        // All AI pipeline Jobs, admin-api, and public-api connect via
        // PgBouncer (pgbouncer.platform.svc.cluster.local:5432).
        // Deployed as sibling to AppIamStack — same dependency (BaseStack).
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

        // =================================================================
        // Stack 5: API STACK (API Gateway + Lambda)
        //
        // Serverless email subscription API (subscribe + verify).
        // Independent lifecycle — depends only on Data stack (SSM discovery).
        // =================================================================
        const apiStack = new NextJsApiStack(
            scope,
            stackId(this.namespace, 'Api', environment),
            {
                targetEnvironment: environment,
                projectName: nextjsNamePrefix,
                tableSsmPath: bedrockContentTableSsmPath,
                bucketSsmPath: ssmPaths.assetsBucketName,
                namePrefix: nextjsNamePrefix,
                ssmPrefix,
                // WAF: API traffic is routed through CloudFront edge WAF
                skipWaf: true,

                // Email subscription configuration
                notificationEmail: emailConfig.notificationEmail ?? '',
                sesFromEmail: emailConfig.sesFromEmail ?? '',
                verificationBaseUrl: emailConfig.verificationBaseUrl ?? '',
                verificationSecret: emailConfig.verificationSecret ?? '',

                env,
            },
        );
        apiStack.addDependency(dataStack);
        stacks.push(apiStack);
        stackMap.api = apiStack;

        // EDGE / TUCAKEN-EDGE STACKS REMOVED (Plan 5b Phase 5)
        // CloudFront for nelsonlamounier.com, tucaken.io and tucaken.com is
        // gone — the EKS public ALB (provisioned by the AWS Load Balancer
        // Controller via workload Ingresses) is now the sole public
        // endpoint. ACM wildcards for the ALB live in EksAlbCertsStack and
        // the WAF in EksPublicWafStack.
        //
        // Run `cdk destroy Edge-<env>` and `cdk destroy TucakenEdge-<env>`
        // post-merge to deprovision the legacy distributions.

        // tucaken.io and tucaken.com hosted-zone IDs (still consumed by
        // EksAlbCertsStack for ACM cross-account DNS validation).
        const tucakenIoHostedZoneId = context.tucakenIoHostedZoneId
            ?? process.env.TUCAKEN_IO_HOSTED_ZONE_ID;
        const tucakenComHostedZoneId = context.tucakenComHostedZoneId
            ?? process.env.TUCAKEN_COM_HOSTED_ZONE_ID;

        // =================================================================
        // EKS Stacks (V1 — parallel deployment alongside kubeadm cluster)
        //
        // Sequencing: Cluster → SystemNg → PodIdentity → Addons → Karpenter
        // (Access in parallel after Cluster).
        //
        // Source of truth: docs/superpowers/specs/2026-05-05-eks-migration-design.md § 7.1
        // =================================================================
        // Admin principal ARNs resolved inside EksAccessStack (SSM lookup
        // requires Stack scope, not App scope). Path passed through props.
        const adminArnsSsmPath = EKS_ADMIN_PRINCIPAL_ARNS_SSM_PATHS[
            environment as keyof typeof EKS_ADMIN_PRINCIPAL_ARNS_SSM_PATHS
        ];

        const eksConfig = getEksConfig(environment);

        const eksClusterStack = new EksClusterStack(
            scope,
            stackId(this.namespace, 'EksCluster', environment),
            {
                env, targetEnvironment: environment,
                vpc: baseStack.vpc,
                clusterName: eksConfig.clusterName,
                version: eksConfig.version,
            },
        );
        eksClusterStack.addDependency(baseStack);
        stacks.push(eksClusterStack); stackMap.eksCluster = eksClusterStack;

        const eksSystemNg = new EksSystemNodeGroupStack(
            scope,
            stackId(this.namespace, 'EksSystemNg', environment),
            {
                env, targetEnvironment: environment,
                cluster: eksClusterStack.cluster,
                instanceTypes: eksConfig.mng.instanceTypes,
                desiredSize: eksConfig.mng.desiredSize,
                minSize: eksConfig.mng.minSize,
                maxSize: eksConfig.mng.maxSize,
                diskSizeGib: eksConfig.mng.diskSizeGib,
            },
        );
        eksSystemNg.addDependency(eksClusterStack);
        stacks.push(eksSystemNg); stackMap.eksSystemNg = eksSystemNg;

        const karpenterQueueArn = `arn:aws:sqs:${env.region}:${env.account}:${eksConfig.clusterName}-karpenter`;

        // Apex domains ExternalDNS reconciles. Sourced statically rather than
        // from EksConfig so the migration to ALB+ACM (Plan 5b) is reviewable
        // in one place; future enhancement: surface as a config field per env.
        const externalDnsApexDomains = ['nelsonlamounier.com', 'tucaken.io', 'tucaken.com'];

        const eksPodId = new EksPodIdentityStack(
            scope,
            stackId(this.namespace, 'EksPodIdentity', environment),
            {
                env, targetEnvironment: environment,
                cluster: eksClusterStack.cluster,
                bindings: eksConfig.podIdentityBindings,
                karpenterInterruptionQueueArn: karpenterQueueArn,
                workerNodeRoleArn: eksSystemNg.nodeRole.roleArn,
                hostedZoneIds: edgeConfig.hostedZoneId ? [edgeConfig.hostedZoneId] : [],
                crossAccountDnsRoleArn: edgeConfig.crossAccountRoleArn,
            },
        );
        eksPodId.addDependency(eksSystemNg);
        stacks.push(eksPodId); stackMap.eksPodIdentity = eksPodId;

        const eksAddons = new EksAddonsStack(
            scope,
            stackId(this.namespace, 'EksAddons', environment),
            {
                env, targetEnvironment: environment,
                cluster: eksClusterStack.cluster,
                vpcId: baseStack.vpc.vpcId,
                region: env.region!,
                karpenterInterruptionQueueName: `${eksConfig.clusterName}-karpenter`,
                workerNodeRoleArn: eksSystemNg.nodeRole.roleArn,
                hostedZoneDomains: externalDnsApexDomains,
                crossAccountDnsRoleArn: edgeConfig.crossAccountRoleArn,
                versions: eksConfig.versions,
            },
        );
        eksAddons.addDependency(eksPodId);
        stacks.push(eksAddons); stackMap.eksAddons = eksAddons;

        const eksKarp = new EksKarpenterStack(
            scope,
            stackId(this.namespace, 'EksKarpenter', environment),
            {
                env, targetEnvironment: environment,
                cluster: eksClusterStack.cluster,
                workerNodeRole: eksSystemNg.nodeRole,
                workerSecurityGroupIdSsmPath: `${ssmPrefix}/eks/workers-sg-id`,
                subnetTagKey: `kubernetes.io/cluster/${eksConfig.clusterName}`,
                karpenter: eksConfig.karpenter,
            },
        );
        eksKarp.addDependency(eksAddons);
        stacks.push(eksKarp); stackMap.eksKarpenter = eksKarp;

        // Access entries: config-defined admins + optional GH OIDC / extra admin
        // from env vars (CI injects GH_OIDC_ROLE_ARN; ADMIN_ROLE_ARN for ad-hoc).
        const ghOidcRoleArn = process.env.GH_OIDC_ROLE_ARN;
        const adminRoleArn = process.env.ADMIN_ROLE_ARN;
        const accessPrincipals = Array.from(new Set([
            ...eksConfig.adminPrincipalArns,
            ghOidcRoleArn,
            adminRoleArn,
        ].filter((a): a is string => !!a)));
        const eksAccess = new EksAccessStack(
            scope,
            stackId(this.namespace, 'EksAccess', environment),
            {
                env, targetEnvironment: environment,
                cluster: eksClusterStack.cluster,
                principalArns: accessPrincipals,
                adminPrincipalArnsSsmPath: adminArnsSsmPath,
            },
        );
        eksAccess.addDependency(eksClusterStack);
        stacks.push(eksAccess); stackMap.eksAccess = eksAccess;

        // ---------- ALB wildcard certificates (eu-west-1) ----------
        // Soft-skip when tucaken zones or cross-account role aren't
        // configured — same gate as TucakenEdgeStack so single-domain
        // environments stay deployable.
        if (
            edgeConfig.hostedZoneId
            && tucakenIoHostedZoneId
            && tucakenComHostedZoneId
            && edgeConfig.crossAccountRoleArn
        ) {
            const eksAlbCerts = new EksAlbCertsStack(
                scope,
                stackId(this.namespace, 'EksAlbCerts', environment),
                {
                    env, targetEnvironment: environment,
                    nelsonlamounierHostedZoneId: edgeConfig.hostedZoneId,
                    tucakenIoHostedZoneId,
                    tucakenComHostedZoneId,
                    crossAccountRoleArn: edgeConfig.crossAccountRoleArn,
                    ssmPrefix,
                },
            );
            stacks.push(eksAlbCerts); stackMap.eksAlbCerts = eksAlbCerts;
        } else {
            cdk.Annotations.of(scope).addInfo(
                'EKS ALB certs stack skipped: hostedZoneId, tucaken zones, ' +
                'or CROSS_ACCOUNT_ROLE_ARN not set.',
            );
        }

        // ---------- Public WAF (eu-west-1, REGIONAL) ----------
        // Host-scoped allowlist + managed rules + rate limit. Attached to
        // the shared ALB via `alb.ingress.kubernetes.io/wafv2-acl-arn` on
        // a workload Ingress. Plan 5b § 0.4.
        const eksPublicWaf = new EksPublicWafStack(
            scope,
            stackId(this.namespace, 'EksPublicWaf', environment),
            {
                env, targetEnvironment: environment,
                allowlistIpv4SsmPath: `/k8s/${environment}/monitoring/allow-ipv4`,
                allowlistIpv6SsmPath: `/k8s/${environment}/monitoring/allow-ipv6`,
                allowlistedHosts: [
                    'admin.nelsonlamounier.com',
                    'ops.nelsonlamounier.com',
                    // Tucaken pre-launch IP gate — application is still
                    // under development. Drop these four entries when
                    // going public; the AWS Managed Rule Sets and ACM
                    // wildcards remain.
                    'tucaken.io',
                    'www.tucaken.io',
                    'tucaken.com',
                    'www.tucaken.com',
                ],
                rateLimitedHosts: ['api.nelsonlamounier.com'],
                rateLimitPerIp: 2000,
                ssmPrefix,
                clusterName: eksConfig.clusterName,
            },
        );
        stacks.push(eksPublicWaf); stackMap.eksPublicWaf = eksPublicWaf;

        cdk.Annotations.of(scope).addInfo(
            `K8s factory created ${stacks.length} stacks for ${environment}: ` +
            `Data → Base → Compute → Edge → Observability (domain: ${edgeConfig.domainName ?? 'not configured'})`,
        );

        return {
            stacks,
            stackMap,
        };
    }
}
