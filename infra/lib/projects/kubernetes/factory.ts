/**
 * @format
 * Kubernetes Project Factory
 *
 * Creates shared Kubernetes infrastructure hosting both monitoring and
 * application workloads on a kubeadm Kubernetes cluster.
 *
 * Stack Architecture (9 stacks, plus API + Edge + Observability):
 *   1.  Kubernetes-Data:          DynamoDB, S3 Assets, SSM parameters
 *   2.  Kubernetes-Base:          VPC, Security Group, KMS, EBS, Elastic IP
 *   2b. Kubernetes-GoldenAmi:     EC2 Image Builder pipeline (bakes Golden AMI)
 *   2c. Kubernetes-SsmAutomation: SSM Automation bootstrap documents
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
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    K8sSsmAutomationStack,
    KubernetesAppIamStack,
    KubernetesBaseStack,
    GoldenAmiStack,
    KubernetesControlPlaneStack,
    KubernetesDataStack,
    KubernetesEdgeStack,
    KubernetesObservabilityStack,
    KubernetesWorkerAsgStack,
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
        // Stack 2b: GOLDEN AMI STACK (Image Builder Pipeline)
        //
        // Dedicated stack for the EC2 Image Builder pipeline.
        // Deployed before ControlPlane so the AMI can be baked before
        // any ASG launches EC2 instances.
        // Gated by imageConfig.enableImageBuilder flag.
        // =================================================================
        let goldenAmiStack: GoldenAmiStack | undefined;
        if (configs.image.enableImageBuilder) {
            goldenAmiStack = new GoldenAmiStack(
                scope,
                stackId(this.namespace, 'GoldenAmi', environment),
                {
                    env,
                    description: `Golden AMI Image Builder pipeline - ${environment}`,
                    targetEnvironment: environment,
                    vpcId: sharedVpcId,
                    configs,
                    namePrefix,
                    ssmPrefix,
                },
            );
            goldenAmiStack.addDependency(baseStack);
            stacks.push(goldenAmiStack);
            stackMap.goldenAmi = goldenAmiStack;
        }

        // =================================================================
        // Stack 2c: SSM AUTOMATION STACK (Bootstrap Documents)
        //
        // SSM Automation documents for control plane and worker bootstrap.
        // Deployed independently so bootstrap scripts can be updated
        // without redeploying EC2 instances.
        // =================================================================
        const ssmAutomationStack = new K8sSsmAutomationStack(
            scope,
            stackId(this.namespace, 'SsmAutomation', environment),
            {
                env,
                description: `SSM Automation documents for K8s bootstrap - ${environment}`,
                targetEnvironment: environment,
                configs,
                namePrefix,
                ssmPrefix,
                scriptsBucketName: `${namePrefix}-k8s-scripts-${env.account}`,
                notificationEmail: emailConfig.notificationEmail,
            },
        );
        ssmAutomationStack.addDependency(baseStack);
        stacks.push(ssmAutomationStack);
        stackMap.ssmAutomation = ssmAutomationStack;

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
        // Hosts: Next.js, start-admin, ArgoCD, system components.

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
                workerPoolRole: generalPoolStack.instanceRole,
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
                // Admin S3 write — article image and video uploads from admin panel
                s3WriteBucketArns: [
                    `arn:aws:s3:::${resourceNames.assetsBucketName}`,
                ],
                // Bedrock pipeline SSM — resolve infrastructure for admin publish
                bedrockSsmPath: `/${bedrockNamePrefix}/*`,
                dynamoKmsKeySsmPath: ssmPaths.dynamodbKmsKeyArn,
                // admin-api BFF — Lambda invocation for article publish/trigger/strategist
                // Called via EC2 instance role (IMDS) — no static credentials in K8s.
                lambdaInvokeArns: [
                    `arn:aws:lambda:${env.region}:${env.account}:function:${bedrockNamePrefix}-pipeline-publish`,
                    `arn:aws:lambda:${env.region}:${env.account}:function:${bedrockNamePrefix}-pipeline-trigger`,
                    `arn:aws:lambda:${env.region}:${env.account}:function:${bedrockNamePrefix}-strategist-trigger`,
                ],
            },
        );
        appIamStack.addDependency(controlPlaneStack);
        appIamStack.addDependency(generalPoolStack);
        stacks.push(appIamStack);
        stackMap.appIam = appIamStack;

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
                env: edgeEnv,
            },
        );
        edgeStack.addDependency(controlPlaneStack);
        edgeStack.addDependency(dataStack);
        edgeStack.addDependency(apiStack);
        stacks.push(edgeStack);
        stackMap.edge = edgeStack;

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
