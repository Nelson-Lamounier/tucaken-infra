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
    cdkEdgeEnvironment,
    getEnvironmentConfig,
} from '../../config/environments';
import { getK8sConfigs } from '../../config/kubernetes';
import { getNextJsConfigs, nextjsResourceNames } from '../../config/nextjs';
import { Project, getProjectConfig } from '../../config/projects';
import { nextjsSsmPaths, k8sSsmPaths } from '../../config/ssm-paths';
import { AmiRefreshConstruct } from '../../constructs/events/ami-refresh/ami-refresh-construct';
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
    KubernetesAppIamStack,
    KubernetesBaseStack,
    KubernetesControlPlaneStack,
    KubernetesDataStack,
    KubernetesEdgeStack,
    KubernetesObservabilityStack,
    KubernetesOidcStack,
    KubernetesWorkerAsgStack,
    PlatformRdsStack,
    TucakenEdgeStack,
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

    /**
     * Public domain hosting the OIDC discovery endpoint for IRSA on the
     * self-hosted kubeadm cluster. Single CloudFront distribution serves
     * every env via path-based separation (`/k8s-{shortEnv}`).
     * @default 'oidc.nelsonlamounier.com'
     */
    readonly oidcDomain?: string;

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
        // The shared Kubernetes cluster hosts the Next.js application, so we need
        // the Next.js resource names, SSM paths, and edge configuration.
        // =================================================================
        const nextjsNamePrefix = 'nextjs';
        const resourceNames = nextjsResourceNames(nextjsNamePrefix, environment);
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

        // VPC ID from baseStack is a concrete string (resolved at synth-time by Vpc.fromLookup),
        // so passing it to consumer stacks does NOT create a cross-stack export.
        // Security Group ID is NOT passed — each consumer stack resolves it from SSM at deploy time
        // to avoid Fn::ImportValue cross-stack exports.
        const sharedVpcId = baseStack.vpc.vpcId;

        // =================================================================
        // Stack 3: CONTROL PLANE STACK (ASG + Launch Template + Runtime)
        //
        // kubeadm cluster hosting both monitoring and app workloads.
        // Consumes base infrastructure from KubernetesBaseStack.
        // Does NOT contain application-specific IAM — see AppIamStack.
        // =================================================================
        const controlPlaneStack = new KubernetesControlPlaneStack(
            scope,
            stackId(this.namespace, 'ControlPlane', environment),
            {
                vpcId: sharedVpcId,
                env,
                description: `Shared kubeadm Kubernetes cluster (monitoring + application) - ${environment}`,
                targetEnvironment: environment,
                configs,
                namePrefix,
                ssmPrefix,
                // cert-manager DNS-01 — pass public hosted zone + cross-account role
                // so CDK writes them to SSM for bootstrap consumption
                publicHostedZoneId: edgeConfig.hostedZoneId,
                crossAccountDnsRoleArn: edgeConfig.crossAccountRoleArn,
            },
        );
        controlPlaneStack.addDependency(baseStack);
        stacks.push(controlPlaneStack);
        stackMap.controlPlane = controlPlaneStack;

        // =================================================================
        // Stack 3b: GENERAL POOL ASG (Kubernetes-Native Worker — general)
        //
        // Hosts: Next.js, tucaken-app, ArgoCD, system components.

        // No taint — accepts all pods without toleration.
        //
        // On-Demand ONLY: ArgoCD is on this pool and owns BlueGreen promotion
        // logic. A Spot interruption that evicts ArgoCD loses the very tool
        // that would orchestrate the graceful handoff. On-Demand cost delta is
        // negligible for a single t3.small vs. the operational risk.
        //
        // desiredCapacity intentionally absent: start at min=1 and let the
        // Cluster Autoscaler prove two nodes are needed before provisioning.
        // Setting it would reset capacity on every `cdk deploy`.
        // =================================================================
        const generalPoolStack = new KubernetesWorkerAsgStack(

            scope,
            stackId(this.namespace, 'GeneralPool', environment),
            {
                vpcId: sharedVpcId,
                env,
                description: `Kubernetes general-purpose worker pool (Next.js, ArgoCD, system) - ${environment}`,
                targetEnvironment: environment,
                poolType: 'general',
                controlPlaneSsmPrefix: ssmPrefix,
                clusterName: namePrefix,
                instanceType: undefined,      // defaults to t3.small
                minCapacity: 1,
                maxCapacity: 4,
                // On-Demand: ArgoCD cannot tolerate Spot interruption.
                // It is the orchestrator for all BlueGreen promotions — evicting it
                // removes the tool needed for graceful workload handoff.
                useSpotInstances: false,
                rootVolumeSizeGb: 30,
                useSignals: true,
                signalsTimeoutMinutes: 40,
                namePrefix,
                crossAccountDnsRoleArn: edgeConfig.crossAccountRoleArn,
            },
        );
        generalPoolStack.addDependency(controlPlaneStack);
        stacks.push(generalPoolStack);
        stackMap.generalPool = generalPoolStack;

        // =================================================================
        // Stack 3c: MONITORING POOL ASG (Kubernetes-Native Worker — monitoring)
        //
        // Hosts: Prometheus, Grafana, Loki, Tempo, Alloy, Steampipe.
        // Tainted `dedicated=monitoring:NoSchedule` by the bootstrap script.
        // =================================================================
        const monitoringPoolStack = new KubernetesWorkerAsgStack(
            scope,
            stackId(this.namespace, 'MonitoringPool', environment),
            {
                vpcId: sharedVpcId,
                env,
                description: `Kubernetes monitoring worker pool (Prometheus, Grafana, Loki, Tempo) - ${environment}`,
                targetEnvironment: environment,
                poolType: 'monitoring',
                controlPlaneSsmPrefix: ssmPrefix,
                clusterName: namePrefix,
                instanceType: undefined, // defaults to t3.medium
                minCapacity: 1,
                maxCapacity: 2,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                useSignals: true,
                signalsTimeoutMinutes: 40,
                namePrefix,
                crossAccountDnsRoleArn: edgeConfig.crossAccountRoleArn,
                // Wire the notification email so the monitoring SNS topic has an
                // email subscriber. Without this, Grafana alerts are published to
                // the topic (via the EC2 instance role) but never delivered to a
                // human recipient. emailConfig is sourced from NOTIFICATION_EMAIL
                // env var at CDK synth time — same as all other stacks.
                notificationEmail: emailConfig.notificationEmail,
            },
        );
        monitoringPoolStack.addDependency(controlPlaneStack);
        stacks.push(monitoringPoolStack);
        stackMap.monitoringPool = monitoringPoolStack;

        // =================================================================
        // Stack 4: APP IAM STACK (Application-Tier Grants)
        //
        // Attaches application-specific IAM policies (DynamoDB, S3,
        // Secrets Manager, SSM) to the compute instance role.
        // Decoupled from compute — adding a DynamoDB table only redeploys
        // this stack, not the ASG or Launch Template.
        // =================================================================
        const appIamStack = new KubernetesAppIamStack(
            scope,
            stackId(this.namespace, 'AppIam', environment),
            {
                controlPlaneStack,
                workerRoleSsmPath: `${ssmPrefix}/general-instance-role-arn`,
                env,
                description: `Application-tier IAM grants for Kubernetes cluster - ${environment}`,
                targetEnvironment: environment,
                configs,
                ssmPrefix,

                // Application-tier IAM grants (Next.js + Bedrock content)
                ssmParameterPath: ssmPaths.wildcard,
                secretsManagerPathPattern: `${nextjsNamePrefix}/${environment}/*`,
                s3ReadBucketArns: [
                    `arn:aws:s3:::${resourceNames.assetsBucketName}`,
                    // Bedrock content pipeline — published MDX blobs
                    `arn:aws:s3:::bedrock-${environment}-kb-data`,
                    // Resume import processor K8s Job — reads uploaded PDF/DOCX
                    // Bucket name is CDK-generated; wildcard covers the random suffix
                    `arn:aws:s3:::bedrock-data-${environment}-assets*`,
                ],
                dynamoTableArns: [
                    `arn:aws:dynamodb:${env.region}:${env.account}:table/${resourceNames.dynamoTableName}`,
                    // Bedrock content pipeline — AI-enhanced article metadata
                    `arn:aws:dynamodb:${env.region}:${env.account}:table/bedrock-${environment}-ai-content`,
                    // Bedrock strategist pipeline — job applications + resume entities
                    `arn:aws:dynamodb:${env.region}:${env.account}:table/${bedrockNamePrefix}-job-strategist`,
                ],
                // Admin write access — article publishing, deletion, and resume CRUD
                dynamoWriteTableArns: [
                    `arn:aws:dynamodb:${env.region}:${env.account}:table/bedrock-${environment}-ai-content`,
                    // Resumes are stored in the strategist table (migrated 2026-03)
                    `arn:aws:dynamodb:${env.region}:${env.account}:table/${bedrockNamePrefix}-job-strategist`,
                ],
                // Admin S3 write — article image/video uploads + resume import presigned PUTs
                s3WriteBucketArns: [
                    `arn:aws:s3:::${resourceNames.assetsBucketName}`,
                    // Resume upload: presigned PUT signed by node role — role must have PutObject
                    `arn:aws:s3:::bedrock-data-${environment}-assets*`,
                ],
                // Bedrock pipeline SSM — resolve infrastructure for admin publish
                bedrockSsmPath: `/${bedrockNamePrefix}/*`,
                // Gap S2: BFF proxy — public-api reads the Bedrock chatbot API key
                // from Secrets Manager using the EC2 instance profile.
                // The '*' suffix covers the 6-char random suffix in SM ARNs.
                bedrockSecretsManagerPath: `${bedrockNamePrefix}/bedrock-api-key*`,
                dynamoKmsKeySsmPath: ssmPaths.dynamodbKmsKeyArn,
                // admin-api BFF — Lambda invocation for article publish/trigger/strategist
                // Called via EC2 instance role (IMDS) — no static credentials in K8s.
                lambdaInvokeArns: [
                    `arn:aws:lambda:${env.region}:${env.account}:function:${bedrockNamePrefix}-pipeline-publish`,
                    `arn:aws:lambda:${env.region}:${env.account}:function:${bedrockNamePrefix}-pipeline-trigger`,
                    `arn:aws:lambda:${env.region}:${env.account}:function:${bedrockNamePrefix}-strategist-trigger`,
                ],
                // Platform RDS credentials — ESO aws-secretsmanager store reads this
                // via the EC2 instance profile. The '?' suffix covers Secrets Manager's
                // 6-char random suffix appended to the ARN.
                additionalSecretArns: [
                    `k8s-${environment}/platform-rds/credentials-??????`,
                ],
            },
        );
        appIamStack.addDependency(controlPlaneStack);
        stacks.push(appIamStack);
        stackMap.appIam = appIamStack;

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

        // =================================================================
        // Stack 6: EDGE STACK (ACM + WAF + CloudFront)
        //
        // MUST be deployed in us-east-1 (CloudFront requirement).
        // Routes traffic: CloudFront → EIP → Traefik → Next.js pod
        // =================================================================
        const edgeEnv = cdkEdgeEnvironment(environment);

        // EIP SSM path is written by the compute stack
        const eipSsmPath = `${ssmPrefix}/elastic-ip`;

        const edgeStack = new KubernetesEdgeStack(
            scope,
            stackId(this.namespace, 'Edge', environment),
            {
                targetEnvironment: environment,
                domainName: edgeConfig.domainName ?? '',
                subjectAlternativeNames: context.subjectAlternativeNames,
                hostedZoneId: edgeConfig.hostedZoneId ?? '',
                crossAccountRoleArn: edgeConfig.crossAccountRoleArn ?? '',
                // SSM lookups read from the primary region
                eipSsmPath,
                eipSsmRegion: env.region,
                assetsBucketSsmPath: ssmPaths.assetsBucketName,
                assetsBucketSsmRegion: env.region,
                rateLimitPerIp: 5000,
                enableIpReputationList: true,
                enableRateLimiting: true,
                createDnsRecords: true,
                namePrefix: nextjsNamePrefix,
                // Pre-launch IP restriction — IPs come from GitHub Secrets
                // via typed config (fromEnv pattern in configurations.ts).
                // To go live: set RESTRICT_ACCESS=false in GitHub Environment.
                restrictAccess: nextjsConfig.restrictAccess,
                allowedIps: nextjsConfig.allowedIpv4 ? [nextjsConfig.allowedIpv4] : [],
                allowedIpv6s: nextjsConfig.allowedIpv6 ? [nextjsConfig.allowedIpv6] : [],
                // Admin services (Grafana/Prometheus/ArgoCD) DNS
                opsSubdomain: configs.edge.opsSubdomain,
                baseDomain: configs.edge.baseDomain,
                runnersSubdomain: configs.edge.runnersSubdomain,
                lokiPushSubdomain: configs.edge.lokiPushSubdomain,
                pushgatewaySubdomain: configs.edge.pushgatewaySubdomain,
                mttrWebhookSubdomain: configs.edge.mttrWebhookSubdomain,
                env: edgeEnv,
            },
        );
        edgeStack.addDependency(controlPlaneStack);
        edgeStack.addDependency(dataStack);
        edgeStack.addDependency(apiStack);
        stacks.push(edgeStack);
        stackMap.edge = edgeStack;

        // =================================================================
        // Stack 6c: OIDC STACK (us-east-1)
        //
        // S3 + CloudFront + IAM OpenIdConnectProvider for IRSA on the
        // self-hosted kubeadm cluster. The kubernetes-bootstrap repo
        // populates the bucket with the cluster's JWKS during control-
        // plane init.
        //
        // Lives in us-east-1 alongside the edge stacks because
        // CloudFront + ACM-for-CloudFront require it. Soft-skips when
        // hosted-zone / cross-account-role config is missing.
        // =================================================================
        const oidcDomain = context.oidcDomain
            ?? process.env.OIDC_DOMAIN
            ?? 'oidc.nelsonlamounier.com';

        const oidcStack = new KubernetesOidcStack(
            scope,
            stackId(this.namespace, 'Oidc', environment),
            {
                targetEnvironment: environment,
                oidcDomain,
                hostedZoneId: edgeConfig.hostedZoneId ?? '',
                crossAccountRoleArn: edgeConfig.crossAccountRoleArn ?? '',
                // controlPlaneNodeRoleArn omitted intentionally: passing
                // instanceRole.roleArn across a region boundary (eu-west-1 →
                // us-east-1) creates a CDK cross-environment Token reference
                // that changes the ControlPlane CloudFormation export key and
                // breaks AppIam's import. The bootstrap script grants itself
                // s3:PutObject via the SSM-stored bucket ARN instead.
                namePrefix,
                env: edgeEnv,
            },
        );
        oidcStack.addDependency(controlPlaneStack);
        stacks.push(oidcStack);
        stackMap.oidc = oidcStack;

        // =================================================================
        // Stack 6b: TUCAKEN EDGE STACK (us-east-1)
        //
        // Independent CloudFront + WAF + ACM for the tucaken-app SaaS.
        // Lives in us-east-1 alongside the portfolio edge stack but ships
        // its own resources end-to-end. Reads the SAME EIP from SSM (shared
        // Traefik origin) but a SEPARATE origin secret so rotation is
        // independent from the portfolio.
        //
        // Soft-skip: if tucaken hosted zones aren't configured, skip the
        // stack rather than fail synth — lets non-tucaken environments
        // continue to deploy unchanged.
        // =================================================================
        const tucakenIoDomain = context.tucakenIoDomain
            ?? process.env.TUCAKEN_IO_DOMAIN
            ?? 'tucaken.io';
        const tucakenComDomain = context.tucakenComDomain
            ?? process.env.TUCAKEN_COM_DOMAIN
            ?? 'tucaken.com';
        const tucakenIoHostedZoneId = context.tucakenIoHostedZoneId
            ?? process.env.TUCAKEN_IO_HOSTED_ZONE_ID;
        const tucakenComHostedZoneId = context.tucakenComHostedZoneId
            ?? process.env.TUCAKEN_COM_HOSTED_ZONE_ID;

        if (tucakenIoHostedZoneId && tucakenComHostedZoneId && edgeConfig.crossAccountRoleArn) {
            const tucakenEdgeStack = new TucakenEdgeStack(
                scope,
                stackId(this.namespace, 'TucakenEdge', environment),
                {
                    targetEnvironment: environment,
                    ioDomain: tucakenIoDomain,
                    comDomain: tucakenComDomain,
                    ioHostedZoneId: tucakenIoHostedZoneId,
                    comHostedZoneId: tucakenComHostedZoneId,
                    crossAccountRoleArn: edgeConfig.crossAccountRoleArn,
                    eipSsmPath,
                    eipSsmRegion: env.region,
                    rateLimitPerIp: 5000,
                    enableIpReputationList: true,
                    enableRateLimiting: true,
                    namePrefix: 'tucaken',
                    // Pre-launch IP gate — re-uses the same allowlist as the
                    // portfolio. Flip RESTRICT_ACCESS=false to go public.
                    restrictAccess: nextjsConfig.restrictAccess,
                    allowedIps: nextjsConfig.allowedIpv4 ? [nextjsConfig.allowedIpv4] : [],
                    allowedIpv6s: nextjsConfig.allowedIpv6 ? [nextjsConfig.allowedIpv6] : [],
                    env: edgeEnv,
                },
            );
            tucakenEdgeStack.addDependency(controlPlaneStack);
            stacks.push(tucakenEdgeStack);
            stackMap.tucakenEdge = tucakenEdgeStack;
        } else {
            cdk.Annotations.of(scope).addInfo(
                'Tucaken edge stack skipped: TUCAKEN_IO_HOSTED_ZONE_ID, ' +
                'TUCAKEN_COM_HOSTED_ZONE_ID, or CROSS_ACCOUNT_ROLE_ARN not set.',
            );
        }

        // =================================================================
        // Stack 7: OBSERVABILITY STACK (CloudWatch Dashboard)
        //
        // Pre-deployment dashboard providing infrastructure visibility
        // before Grafana/Prometheus are operational. Reads all references
        // from SSM — fully decoupled from compute lifecycle.
        // Cost: $3.00/month.
        // =================================================================
        const selfHealingPrefix = flatName('self-healing', '', environment);

        const observabilityStack = new KubernetesObservabilityStack(
            scope,
            stackId(this.namespace, 'Observability', environment),
            {
                env,
                targetEnvironment: environment,
                namePrefix,
                ssmPrefix,
                // SSM paths — the stack resolves these internally via
                // ssm.StringParameter.valueForStringParameter scoped to itself.
                // MUST NOT resolve here: `scope` is cdk.App, not a Stack.
                nlbFullNameSsmPath: k8sSsmPaths(environment).nlbFullName,
                cloudFrontDistributionIdSsmPath: nextjsSsmPaths(environment).cloudfront.distributionId,
                selfHealingConfig: {
                    agentFunctionName: `${selfHealingPrefix}-agent`,
                    toolFunctions: [
                        { functionName: `${selfHealingPrefix}-tool-diagnose-alarm`, label: 'Diagnose Alarm' },
                        { functionName: `${selfHealingPrefix}-tool-ebs-detach`, label: 'EBS Detach' },
                        { functionName: `${selfHealingPrefix}-tool-analyse-cluster-health`, label: 'Analyse Cluster' },
                    ],
                },
            },
        );
        observabilityStack.addDependency(baseStack);
        stacks.push(observabilityStack);
        stackMap.observability = observabilityStack;

        // =================================================================
        // AMI REFRESH CONSTRUCT (EventBridge → Step Functions)
        //
        // Watches /k8s/${environment}/golden-ami/latest SSM parameter for
        // updates and automatically rolls worker ASGs (phase 1) then the
        // control plane ASG (phase 2) — no cdk deploy required after bake.
        // Scoped to controlPlaneStack so resources are co-located with compute.
        // =================================================================
        // AmiRefreshConstruct is scoped to controlPlaneStack but needs Launch Template
        // identifiers from the worker stacks, which already depend on controlPlaneStack
        // via addDependency(). Passing CDK tokens (launchTemplateId) across this boundary
        // would force CloudFormation Fn::ImportValue cross-stack exports and create a cycle.
        //
        // Fix: use launchTemplateName (a concrete string at synth time — `${poolId}-lt`)
        // rather than launchTemplateId (a CloudFormation Ref / CDK token assigned at deploy).
        new AmiRefreshConstruct(controlPlaneStack, 'AmiRefresh', {
            ssmPrefix,
            workerLtNames: [
                generalPoolStack.launchTemplateName,
                monitoringPoolStack.launchTemplateName,
            ],
            workerAsgNames: [
                generalPoolStack.concreteAsgName,
                monitoringPoolStack.concreteAsgName,
            ],
            controlPlaneLtName: controlPlaneStack.launchTemplateName,
            controlPlaneAsgName: controlPlaneStack.concreteAsgName,
            notificationEmail: emailConfig.notificationEmail,
        });

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
                allowlistCidrsSsmPath: `/shared/${environment}/admin-allowlist-cidrs`,
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
