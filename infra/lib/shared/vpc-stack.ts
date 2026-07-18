/**
 * @format
 * Shared VPC Stack
 *
 * Provides shared networking infrastructure used by all projects.
 * Stack name: {Namespace}-VpcStack-{environment} (e.g., Monitoring-VpcStack-dev)
 */

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { getEksConfig } from '../config/eks';
import { Environment } from '../config/environments';

/**
 * Flow log configuration
 */
export interface FlowLogConfig {
    readonly logGroupName?: string;
    readonly retentionDays?: logs.RetentionDays;
    readonly encryptionKey?: kms.IKey;
    readonly createEncryptionKey?: boolean;
}

/**
 * Gateway Endpoint configuration
 */
export interface GatewayEndpointConfig {
    readonly enableS3Endpoint?: boolean;
    readonly enableDynamoDbEndpoint?: boolean;
}

/**
 * Props for SharedVpcStack
 */
export interface SharedVpcStackProps extends cdk.StackProps {
    /** Target environment (renamed to avoid CDK Stack.environment conflict) */
    readonly targetEnvironment: Environment;
    /** CIDR block for the VPC */
    readonly cidr?: string;
    /** Maximum number of Availability Zones */
    readonly maxAzs?: number;
    /** Flow log configuration */
    readonly flowLogConfig?: FlowLogConfig;
    /** Gateway Endpoint configuration */
    readonly gatewayEndpoints?: GatewayEndpointConfig;
    /** ECR repository name @default 'nextjs-frontend' */
    readonly ecrRepositoryName?: string;
    /** Enable ECR repository creation @default true */
    readonly createEcrRepository?: boolean;
    /** Admin/tucaken-app ECR repository name @default 'tucaken-app' */
    readonly adminEcrRepositoryName?: string;
    /** Enable admin ECR repository creation @default true */
    readonly createAdminEcrRepository?: boolean;
    /** public-api BFF ECR repository name @default 'public-api' */
    readonly publicApiEcrRepositoryName?: string;
    /** Enable public-api ECR repository creation @default true */
    readonly createPublicApiEcrRepository?: boolean;
    /** admin-api BFF ECR repository name @default 'admin-api' */
    readonly adminApiEcrRepositoryName?: string;
    /** Enable admin-api ECR repository creation @default true */
    readonly createAdminApiEcrRepository?: boolean;
    /** wiki-mcp MCP server ECR repository name @default 'wiki-mcp' */
    readonly wikiMcpEcrRepositoryName?: string;
    /** Enable wiki-mcp ECR repository creation @default false */
    readonly createWikiMcpEcrRepository?: boolean;
    /** ingestion K8s Job ECR repository name @default 'ingestion' */
    readonly ingestionEcrRepositoryName?: string;
    /** Enable ingestion ECR repository creation @default true */
    readonly createIngestionEcrRepository?: boolean;
    /** ontology-importer CronJob ECR repository name @default 'ontology-importer' */
    readonly ontologyImporterEcrRepositoryName?: string;
    /** Enable ontology-importer ECR repository creation @default true */
    readonly createOntologyImporterEcrRepository?: boolean;
    /** Enable ontology-importer Bedrock batch I/O S3 bucket creation @default true */
    readonly createOntologyImporterBatchBucket?: boolean;
    /** article-pipeline K8s Job ECR repository name @default 'article-pipeline' */
    readonly articlePipelineEcrRepositoryName?: string;
    /** Enable article-pipeline ECR repository creation @default true */
    readonly createArticlePipelineEcrRepository?: boolean;
    /** job-strategist K8s Job ECR repository name @default 'job-strategist' */
    readonly jobStrategistEcrRepositoryName?: string;
    /** Enable job-strategist ECR repository creation @default true */
    readonly createJobStrategistEcrRepository?: boolean;
    /** resume-import-processor K8s Job ECR repository name @default 'resume-import-processor' */
    readonly resumeImportProcessorEcrRepositoryName?: string;
    /** Enable resume-import-processor ECR repository creation @default true */
    readonly createResumeImportProcessorEcrRepository?: boolean;
    /** platform-job-watcher ECR repository name @default 'platform-job-watcher' */
    readonly platformJobWatcherEcrRepositoryName?: string;
    /** Enable platform-job-watcher ECR repository creation @default true */
    readonly enablePlatformJobWatcherEcrRepository?: boolean;
    /** synthetic-monitor ECR repository name @default 'synthetic-monitor' */
    readonly syntheticMonitorEcrRepositoryName?: string;
    /** Enable synthetic-monitor ECR repository creation @default true */
    readonly createSyntheticMonitorEcrRepository?: boolean;
}


/**
 * Shared VPC Stack - one per environment, used by all projects.
 *
 * @example
 * ```typescript
 * const vpc = new SharedVpcStack(app, 'Shared-VpcStack-dev', {
 *     environment: Environment.DEVELOPMENT,
 * });
 * ```
 */
export class SharedVpcStack extends cdk.Stack {
    /** The VPC created by this stack */
    public readonly vpc: ec2.Vpc;
    /** The target environment (dev, staging, prod) */
    public readonly targetEnvironment: Environment;
    /** KMS key for flow log encryption */
    public readonly flowLogEncryptionKey?: kms.IKey;
    /** CloudWatch log group for flow logs */
    public readonly flowLogGroup?: logs.ILogGroup;
    /** S3 Gateway Endpoint */
    public readonly s3Endpoint?: ec2.GatewayVpcEndpoint;
    /** DynamoDB Gateway Endpoint */
    public readonly dynamoDbEndpoint?: ec2.GatewayVpcEndpoint;
    /** ECR Repository for container images (nextjs-frontend) */
    public readonly ecrRepository?: ecr.Repository;
    /** ECR Repository for the tucaken-app container images */
    public readonly adminEcrRepository?: ecr.Repository;
    /** ECR Repository for the public-api BFF */
    public readonly publicApiEcrRepository?: ecr.Repository;
    /** ECR Repository for the admin-api BFF */
    public readonly adminApiEcrRepository?: ecr.Repository;
    /** ECR Repository for the wiki-mcp MCP server */
    public readonly wikiMcpEcrRepository?: ecr.Repository;
    /** ECR Repository for the ingestion K8s Job (Phase 3) */
    public readonly ingestionEcrRepository?: ecr.Repository;
    /** ECR Repository for the ontology-importer CronJob (Tier 2 ontology auto-import) */
    public readonly ontologyImporterEcrRepository?: ecr.Repository;
    /** S3 bucket holding Bedrock batch input/output JSONL for the ontology-importer */
    public readonly ontologyImporterBatchBucket?: s3.Bucket;
    /** ECR Repository for the article-pipeline K8s Job (Phase 4) */
    public readonly articlePipelineEcrRepository?: ecr.Repository;
    /** ECR Repository for the job-strategist K8s Job (Phase 4) */
    public readonly jobStrategistEcrRepository?: ecr.Repository;
    /** ECR Repository for the resume-import-processor K8s Job */
    public readonly resumeImportProcessorEcrRepository?: ecr.Repository;
    /** ECR Repository for the platform-job-watcher Deployment */
    public readonly platformJobWatcherEcrRepository?: ecr.Repository;
    /** ECR Repository for the synthetic-monitor CronJob */
    public readonly syntheticMonitorEcrRepository?: ecr.Repository;

    constructor(scope: Construct, id: string, props: SharedVpcStackProps) {
        super(scope, id, props);

        this.targetEnvironment = props.targetEnvironment;

        // Create VPC with public edge subnets and isolated data subnets.
        // Isolated subnets add no NAT Gateway cost and keep RDS away from IGW routes.
        this.vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: `shared-vpc-${props.targetEnvironment}`,
            ipAddresses: ec2.IpAddresses.cidr(props.cidr ?? '10.0.0.0/16'),
            maxAzs: props.maxAzs ?? 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Isolated',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 24,
                },
            ],
        });

        // EKS subnet discovery tags. EKS + AWS LB Controller find subnets via:
        //   - kubernetes.io/role/elb=1 (public, internet-facing LBs)
        //   - kubernetes.io/cluster/<name>=shared (shared, NOT owned — VPC outlives any cluster)
        // V1 dev runs EKS workers on public subnets (no NAT GW, cost-guardrail).
        // See docs/superpowers/specs/2026-05-05-eks-migration-design.md § 5.1.
        const eksClusterName = getEksConfig(props.targetEnvironment).clusterName;
        for (const subnet of this.vpc.publicSubnets) {
            cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
            cdk.Tags.of(subnet).add(`kubernetes.io/cluster/${eksClusterName}`, 'shared');
        }
        for (const subnet of this.vpc.privateSubnets) {
            cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
            cdk.Tags.of(subnet).add(`kubernetes.io/cluster/${eksClusterName}`, 'shared');
        }

        // Configure Gateway Endpoints (free)
        this.configureGatewayEndpoints(props.gatewayEndpoints);

        // Configure Flow Logs if enabled
        if (props.flowLogConfig) {
            this.configureFlowLogs(props.flowLogConfig);
        }

        // =====================================================================
        // ECR Repository - Shared container registry for all applications
        // Decoupled from application stacks; applications discover via SSM/tags
        // =====================================================================
        if (props.createEcrRepository !== false) {
            const repoName = props.ecrRepositoryName ?? 'nextjs-frontend';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.ecrRepository = new ecr.Repository(this, 'EcrRepository', {
                repositoryName: repoName,
                imageScanOnPush: true,
                // MUTABLE for all environments (Option B: Service-Only deployment)
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });




            // SSM Parameters for ECR discovery
            const ecrSsmPrefix = `/shared/ecr/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmEcrRepositoryUri', {
                parameterName: `${ecrSsmPrefix}/repository-uri`,
                stringValue: this.ecrRepository.repositoryUri,
                description: `Shared ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmEcrRepositoryArn', {
                parameterName: `${ecrSsmPrefix}/repository-arn`,
                stringValue: this.ecrRepository.repositoryArn,
                description: `Shared ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmEcrRepositoryName', {
                parameterName: `${ecrSsmPrefix}/repository-name`,
                stringValue: this.ecrRepository.repositoryName,
                description: `Shared ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // ECR Outputs
            new cdk.CfnOutput(this, 'EcrRepositoryUri', {
                value: this.ecrRepository.repositoryUri,
                description: 'ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'EcrRepositoryArn', {
                value: this.ecrRepository.repositoryArn,
                description: 'ECR Repository ARN',
            });

            new cdk.CfnOutput(this, 'DockerLoginCommand', {
                value: `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
                description: 'Docker login command for ECR',
            });
        }

        // =====================================================================
        // ECR Repository (Admin/Tucaken-app) — Separate container registry for
        // the customer-facing TanStack Start application (tucaken-app).
        // Uses the same lifecycle rules and encryption as the frontend repo.
        //
        // SSM key prefix `/shared/ecr-admin/{env}/` is preserved for backward
        // compatibility with existing workflow consumers — only the value (the
        // ECR repo name/URI) changes when this prop's default flips.
        // =====================================================================
        if (props.createAdminEcrRepository !== false) {
            const adminRepoName = props.adminEcrRepositoryName ?? 'tucaken-app';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.adminEcrRepository = new ecr.Repository(this, 'AdminEcrRepository', {
                repositoryName: adminRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            // SSM Parameters for admin ECR discovery
            const adminEcrSsmPrefix = `/shared/ecr-admin/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmAdminEcrRepositoryUri', {
                parameterName: `${adminEcrSsmPrefix}/repository-uri`,
                stringValue: this.adminEcrRepository.repositoryUri,
                description: `Admin ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminEcrRepositoryArn', {
                parameterName: `${adminEcrSsmPrefix}/repository-arn`,
                stringValue: this.adminEcrRepository.repositoryArn,
                description: `Admin ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminEcrRepositoryName', {
                parameterName: `${adminEcrSsmPrefix}/repository-name`,
                stringValue: this.adminEcrRepository.repositoryName,
                description: `Admin ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // Admin/tucaken-app ECR Outputs
            new cdk.CfnOutput(this, 'AdminEcrRepositoryUri', {
                value: this.adminEcrRepository.repositoryUri,
                description: 'tucaken-app ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'AdminEcrRepositoryArn', {
                value: this.adminEcrRepository.repositoryArn,
                description: 'tucaken-app ECR Repository ARN',
            });
        }

        // =====================================================================
        // ECR Repository (public-api) — BFF for portfolio visitors
        // Read-only API: GET /articles, GET /articles/:slug, GET /health
        // SSM params stored under /shared/ecr-public-api/{env}/ for CI discovery.
        // =====================================================================
        if (props.createPublicApiEcrRepository !== false) {
            const publicApiRepoName = props.publicApiEcrRepositoryName ?? 'public-api';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.publicApiEcrRepository = new ecr.Repository(this, 'PublicApiEcrRepository', {
                repositoryName: publicApiRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            // SSM Parameters for public-api ECR discovery
            const publicApiEcrSsmPrefix = `/shared/ecr-public-api/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmPublicApiEcrRepositoryUri', {
                parameterName: `${publicApiEcrSsmPrefix}/repository-uri`,
                stringValue: this.publicApiEcrRepository.repositoryUri,
                description: `public-api BFF ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmPublicApiEcrRepositoryArn', {
                parameterName: `${publicApiEcrSsmPrefix}/repository-arn`,
                stringValue: this.publicApiEcrRepository.repositoryArn,
                description: `public-api BFF ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmPublicApiEcrRepositoryName', {
                parameterName: `${publicApiEcrSsmPrefix}/repository-name`,
                stringValue: this.publicApiEcrRepository.repositoryName,
                description: `public-api BFF ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // public-api ECR Outputs
            new cdk.CfnOutput(this, 'PublicApiEcrRepositoryUri', {
                value: this.publicApiEcrRepository.repositoryUri,
                description: 'public-api BFF ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'PublicApiEcrRepositoryArn', {
                value: this.publicApiEcrRepository.repositoryArn,
                description: 'public-api BFF ECR Repository ARN',
            });
        }

        // =====================================================================
        // ECR Repository (admin-api) — BFF for authenticated admin operations
        // Write-heavy: publish articles, presign S3 uploads, trigger Lambdas.
        // Protected by Cognito JWT; IngressRoute priority 200 (/api/admin/*).
        // SSM params stored under /shared/ecr-admin-api/{env}/ for CI discovery.
        // =====================================================================
        if (props.createAdminApiEcrRepository !== false) {
            const adminApiRepoName = props.adminApiEcrRepositoryName ?? 'admin-api';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.adminApiEcrRepository = new ecr.Repository(this, 'AdminApiEcrRepository', {
                repositoryName: adminApiRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            // SSM Parameters for admin-api ECR discovery
            const adminApiEcrSsmPrefix = `/shared/ecr-admin-api/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmAdminApiEcrRepositoryUri', {
                parameterName: `${adminApiEcrSsmPrefix}/repository-uri`,
                stringValue: this.adminApiEcrRepository.repositoryUri,
                description: `admin-api BFF ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminApiEcrRepositoryArn', {
                parameterName: `${adminApiEcrSsmPrefix}/repository-arn`,
                stringValue: this.adminApiEcrRepository.repositoryArn,
                description: `admin-api BFF ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminApiEcrRepositoryName', {
                parameterName: `${adminApiEcrSsmPrefix}/repository-name`,
                stringValue: this.adminApiEcrRepository.repositoryName,
                description: `admin-api BFF ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // admin-api ECR Outputs
            new cdk.CfnOutput(this, 'AdminApiEcrRepositoryUri', {
                value: this.adminApiEcrRepository.repositoryUri,
                description: 'admin-api BFF ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'AdminApiEcrRepositoryArn', {
                value: this.adminApiEcrRepository.repositoryArn,
                description: 'admin-api BFF ECR Repository ARN (Cognito-protected)',
            });
        }

        // =====================================================================
        // ECR Repository (ingestion) — Phase 3 K8s Job image
        // One-shot pod created on demand by admin-api; replaces the legacy
        // 3-Lambda chain (Trigger → Fetcher → Worker + S3 staging).
        // SSM params stored under /shared/ecr-ingestion/{env}/ for CI discovery.
        // =====================================================================
        if (props.createIngestionEcrRepository !== false) {
            const ingestionRepoName = props.ingestionEcrRepositoryName ?? 'ingestion';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.ingestionEcrRepository = new ecr.Repository(this, 'IngestionEcrRepository', {
                repositoryName: ingestionRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            const ingestionEcrSsmPrefix = `/shared/ecr-ingestion/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmIngestionEcrRepositoryUri', {
                parameterName: `${ingestionEcrSsmPrefix}/repository-uri`,
                stringValue: this.ingestionEcrRepository.repositoryUri,
                description: `ingestion ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmIngestionEcrRepositoryArn', {
                parameterName: `${ingestionEcrSsmPrefix}/repository-arn`,
                stringValue: this.ingestionEcrRepository.repositoryArn,
                description: `ingestion ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmIngestionEcrRepositoryName', {
                parameterName: `${ingestionEcrSsmPrefix}/repository-name`,
                stringValue: this.ingestionEcrRepository.repositoryName,
                description: `ingestion ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new cdk.CfnOutput(this, 'IngestionEcrRepositoryUri', {
                value: this.ingestionEcrRepository.repositoryUri,
                description: 'ingestion K8s Job ECR Repository URI for docker push/pull',
            });
        }

        // =====================================================================
        // ECR Repository (ontology-importer) — Tier 2 ontology auto-import CronJob
        // Scheduled pod that auto-imports ontology data, alongside ingestion.
        // SSM params stored under /shared/ecr-ontology-importer/{env}/ for CI discovery.
        // =====================================================================
        if (props.createOntologyImporterEcrRepository !== false) {
            const ontologyImporterRepoName = props.ontologyImporterEcrRepositoryName ?? 'ontology-importer';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.ontologyImporterEcrRepository = new ecr.Repository(this, 'OntologyImporterEcrRepository', {
                repositoryName: ontologyImporterRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            const ontologyImporterEcrSsmPrefix = `/shared/ecr-ontology-importer/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmOntologyImporterEcrRepositoryUri', {
                parameterName: `${ontologyImporterEcrSsmPrefix}/repository-uri`,
                stringValue: this.ontologyImporterEcrRepository.repositoryUri,
                description: `ontology-importer ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmOntologyImporterEcrRepositoryArn', {
                parameterName: `${ontologyImporterEcrSsmPrefix}/repository-arn`,
                stringValue: this.ontologyImporterEcrRepository.repositoryArn,
                description: `ontology-importer ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmOntologyImporterEcrRepositoryName', {
                parameterName: `${ontologyImporterEcrSsmPrefix}/repository-name`,
                stringValue: this.ontologyImporterEcrRepository.repositoryName,
                description: `ontology-importer ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new cdk.CfnOutput(this, 'OntologyImporterEcrRepositoryUri', {
                value: this.ontologyImporterEcrRepository.repositoryUri,
                description: 'ontology-importer CronJob ECR Repository URI for docker push/pull',
            });
        }

        // =====================================================================
        // S3 Bucket (ontology-importer Bedrock batch I/O)
        // Holds pooled input JSONL written by run-import and the output JSONL
        // written by Bedrock CreateModelInvocationJob. 14-day lifecycle keeps
        // storage costs flat — followup CronJob reads results within minutes,
        // so longer retention is unnecessary. SSM param under
        //   /shared/ontology-importer/{env}/batch-bucket
        // for chart discovery.
        // =====================================================================
        if (props.createOntologyImporterBatchBucket !== false) {
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;
            this.ontologyImporterBatchBucket = new s3.Bucket(this, 'OntologyImporterBatchBucket', {
                bucketName: `ontology-importer-batch-${props.targetEnvironment}`,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                autoDeleteObjects: !isProduction,
                lifecycleRules: [
                    { id: 'expire-batch-io', expiration: cdk.Duration.days(14) },
                ],
            });
            NagSuppressions.addResourceSuppressions(this.ontologyImporterBatchBucket, [
                {
                    id: 'AwsSolutions-S1',
                    reason:
                        'Transient Bedrock batch I/O bucket (14-day lifecycle expiry, BLOCK_ALL public, enforceSSL, ' +
                        'S3-managed encryption). Server access logs would require a second always-on bucket purely ' +
                        'for ephemeral JSONL records that are gone within two weeks — no audit value. CloudTrail data ' +
                        'events on the bucket provide the API-level audit trail if needed.',
                },
            ]);
            new ssm.StringParameter(this, 'SsmOntologyImporterBatchBucket', {
                parameterName: `/shared/ontology-importer/${props.targetEnvironment}/batch-bucket`,
                stringValue: this.ontologyImporterBatchBucket.bucketName,
                description: `ontology-importer Bedrock batch bucket for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });
        }

        // =====================================================================
        // ECR Repository (article-pipeline) — Phase 4 K8s Job image
        // Replaces BedrockPipelineStack (4 Lambdas + Step Functions).
        // SSM params stored under /shared/ecr-article-pipeline/{env}/ for CI discovery.
        // =====================================================================
        if (props.createArticlePipelineEcrRepository !== false) {
            const articlePipelineRepoName = props.articlePipelineEcrRepositoryName ?? 'article-pipeline';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.articlePipelineEcrRepository = new ecr.Repository(this, 'ArticlePipelineEcrRepository', {
                repositoryName: articlePipelineRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            const articlePipelineEcrSsmPrefix = `/shared/ecr-article-pipeline/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmArticlePipelineEcrRepositoryUri', {
                parameterName: `${articlePipelineEcrSsmPrefix}/repository-uri`,
                stringValue: this.articlePipelineEcrRepository.repositoryUri,
                description: `article-pipeline ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmArticlePipelineEcrRepositoryArn', {
                parameterName: `${articlePipelineEcrSsmPrefix}/repository-arn`,
                stringValue: this.articlePipelineEcrRepository.repositoryArn,
                description: `article-pipeline ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmArticlePipelineEcrRepositoryName', {
                parameterName: `${articlePipelineEcrSsmPrefix}/repository-name`,
                stringValue: this.articlePipelineEcrRepository.repositoryName,
                description: `article-pipeline ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new cdk.CfnOutput(this, 'ArticlePipelineEcrRepositoryUri', {
                value: this.articlePipelineEcrRepository.repositoryUri,
                description: 'article-pipeline K8s Job ECR Repository URI for docker push/pull',
            });
        }

        // =====================================================================
        // ECR Repository (job-strategist) — Phase 4 K8s Job image
        // Replaces StrategistPipelineStack (Analysis + Coaching state machines).
        // Image is consumed by both the strategist analysis Job and the coach Job
        // (admin-api selects the entrypoint at Job creation time).
        // SSM params stored under /shared/ecr-job-strategist/{env}/ for CI discovery.
        // =====================================================================
        if (props.createJobStrategistEcrRepository !== false) {
            const jobStrategistRepoName = props.jobStrategistEcrRepositoryName ?? 'job-strategist';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.jobStrategistEcrRepository = new ecr.Repository(this, 'JobStrategistEcrRepository', {
                repositoryName: jobStrategistRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            const jobStrategistEcrSsmPrefix = `/shared/ecr-job-strategist/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmJobStrategistEcrRepositoryUri', {
                parameterName: `${jobStrategistEcrSsmPrefix}/repository-uri`,
                stringValue: this.jobStrategistEcrRepository.repositoryUri,
                description: `job-strategist ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmJobStrategistEcrRepositoryArn', {
                parameterName: `${jobStrategistEcrSsmPrefix}/repository-arn`,
                stringValue: this.jobStrategistEcrRepository.repositoryArn,
                description: `job-strategist ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmJobStrategistEcrRepositoryName', {
                parameterName: `${jobStrategistEcrSsmPrefix}/repository-name`,
                stringValue: this.jobStrategistEcrRepository.repositoryName,
                description: `job-strategist ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new cdk.CfnOutput(this, 'JobStrategistEcrRepositoryUri', {
                value: this.jobStrategistEcrRepository.repositoryUri,
                description: 'job-strategist K8s Job ECR Repository URI for docker push/pull',
            });
        }

        // =====================================================================
        // ECR Repository (resume-import-processor) — PDF/DOCX → Bedrock → pgvector Job
        // Image is consumed by K8s Jobs created by admin-api after a user uploads
        // their resume. SSM params stored under
        // /shared/ecr-resume-import-processor/{env}/ for CI discovery.
        // =====================================================================
        if (props.createResumeImportProcessorEcrRepository !== false) {
            const repoName = props.resumeImportProcessorEcrRepositoryName ?? 'resume-import-processor';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.resumeImportProcessorEcrRepository = new ecr.Repository(this, 'ResumeImportProcessorEcrRepository', {
                repositoryName: repoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            const ssmPrefix = `/shared/ecr-resume-import-processor/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmResumeImportProcessorEcrRepositoryUri', {
                parameterName: `${ssmPrefix}/repository-uri`,
                stringValue: this.resumeImportProcessorEcrRepository.repositoryUri,
                description: `resume-import-processor ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmResumeImportProcessorEcrRepositoryArn', {
                parameterName: `${ssmPrefix}/repository-arn`,
                stringValue: this.resumeImportProcessorEcrRepository.repositoryArn,
                description: `resume-import-processor ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmResumeImportProcessorEcrRepositoryName', {
                parameterName: `${ssmPrefix}/repository-name`,
                stringValue: this.resumeImportProcessorEcrRepository.repositoryName,
                description: `resume-import-processor ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new cdk.CfnOutput(this, 'ResumeImportProcessorEcrRepositoryUri', {
                value: this.resumeImportProcessorEcrRepository.repositoryUri,
                description: 'resume-import-processor K8s Job ECR Repository URI for docker push/pull',
            });
        }

        // =====================================================================
        // ECR Repository (platform-job-watcher) — K8s Deployment
        // Image is consumed by the platform-job-watcher Deployment.
        // SSM params stored under /shared/ecr-platform-job-watcher/{env}/ for CI discovery.
        // =====================================================================
        if (props.enablePlatformJobWatcherEcrRepository !== false) {
            const repoName = props.platformJobWatcherEcrRepositoryName ?? 'platform-job-watcher';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.platformJobWatcherEcrRepository = new ecr.Repository(this, 'PlatformJobWatcherEcrRepository', {
                repositoryName: repoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            const ssmPrefix = `/shared/ecr-platform-job-watcher/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmPlatformJobWatcherEcrRepositoryUri', {
                parameterName: `${ssmPrefix}/repository-uri`,
                stringValue: this.platformJobWatcherEcrRepository.repositoryUri,
                description: `platform-job-watcher ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmPlatformJobWatcherEcrRepositoryArn', {
                parameterName: `${ssmPrefix}/repository-arn`,
                stringValue: this.platformJobWatcherEcrRepository.repositoryArn,
                description: `platform-job-watcher ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmPlatformJobWatcherEcrRepositoryName', {
                parameterName: `${ssmPrefix}/repository-name`,
                stringValue: this.platformJobWatcherEcrRepository.repositoryName,
                description: `platform-job-watcher ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new cdk.CfnOutput(this, 'PlatformJobWatcherEcrRepositoryUri', {
                value: this.platformJobWatcherEcrRepository.repositoryUri,
                description: 'platform-job-watcher K8s Deployment ECR Repository URI for docker push/pull',
            });
        }

        // =====================================================================
        // ECR Repository (synthetic-monitor) — API-level synthetic probe CronJob
        // Image is consumed by the synthetic-monitor CronJob in the monitoring
        // chart (rolled by ArgoCD Image Updater). SSM params stored under
        // /shared/ecr-synthetic-monitor/{env}/ for CI discovery.
        // =====================================================================
        if (props.createSyntheticMonitorEcrRepository !== false) {
            const repoName = props.syntheticMonitorEcrRepositoryName ?? 'synthetic-monitor';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.syntheticMonitorEcrRepository = new ecr.Repository(this, 'SyntheticMonitorEcrRepository', {
                repositoryName: repoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            const ssmPrefix = `/shared/ecr-synthetic-monitor/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmSyntheticMonitorEcrRepositoryUri', {
                parameterName: `${ssmPrefix}/repository-uri`,
                stringValue: this.syntheticMonitorEcrRepository.repositoryUri,
                description: `synthetic-monitor ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmSyntheticMonitorEcrRepositoryArn', {
                parameterName: `${ssmPrefix}/repository-arn`,
                stringValue: this.syntheticMonitorEcrRepository.repositoryArn,
                description: `synthetic-monitor ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmSyntheticMonitorEcrRepositoryName', {
                parameterName: `${ssmPrefix}/repository-name`,
                stringValue: this.syntheticMonitorEcrRepository.repositoryName,
                description: `synthetic-monitor ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new cdk.CfnOutput(this, 'SyntheticMonitorEcrRepositoryUri', {
                value: this.syntheticMonitorEcrRepository.repositoryUri,
                description: 'synthetic-monitor CronJob ECR Repository URI for docker push/pull',
            });
        }

        // =====================================================================
        // ECR Repository (wiki-mcp) — FastMCP K8s pod serving portfolio KB
        // MCP tools + REST endpoints for Lambda constraint retrieval.
        // SSM params stored under /shared/ecr-wiki-mcp/{env}/ for CI discovery.
        // Opt-in: createWikiMcpEcrRepository must be explicitly set to true.
        // =====================================================================
        if (props.createWikiMcpEcrRepository === true) {
            const wikiMcpRepoName = props.wikiMcpEcrRepositoryName ?? 'wiki-mcp';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.wikiMcpEcrRepository = new ecr.Repository(this, 'WikiMcpEcrRepository', {
                repositoryName: wikiMcpRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            // SSM Parameters for wiki-mcp ECR discovery
            const wikiMcpEcrSsmPrefix = `/shared/ecr-wiki-mcp/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmWikiMcpEcrRepositoryUri', {
                parameterName: `${wikiMcpEcrSsmPrefix}/repository-uri`,
                stringValue: this.wikiMcpEcrRepository.repositoryUri,
                description: `wiki-mcp ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmWikiMcpEcrRepositoryArn', {
                parameterName: `${wikiMcpEcrSsmPrefix}/repository-arn`,
                stringValue: this.wikiMcpEcrRepository.repositoryArn,
                description: `wiki-mcp ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmWikiMcpEcrRepositoryName', {
                parameterName: `${wikiMcpEcrSsmPrefix}/repository-name`,
                stringValue: this.wikiMcpEcrRepository.repositoryName,
                description: `wiki-mcp ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // wiki-mcp ECR Outputs
            new cdk.CfnOutput(this, 'WikiMcpEcrRepositoryUri', {
                value: this.wikiMcpEcrRepository.repositoryUri,
                description: 'wiki-mcp ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'WikiMcpEcrRepositoryArn', {
                value: this.wikiMcpEcrRepository.repositoryArn,
                description: 'wiki-mcp ECR Repository ARN',
            });
        }

        // =====================================================================
        // SSM Parameters for cross-project VPC sharing
        // Using SSM instead of CloudFormation exports to decouple stacks.
        // Consuming stacks use Vpc.fromLookup() with tags - no CF dependencies.
        // =====================================================================
        const ssmPrefix = `/shared/vpc/${props.targetEnvironment}`;

        new ssm.StringParameter(this, 'SsmVpcId', {
            parameterName: `${ssmPrefix}/vpc-id`,
            stringValue: this.vpc.vpcId,
            description: `Shared VPC ID for ${props.targetEnvironment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmVpcCidr', {
            parameterName: `${ssmPrefix}/vpc-cidr`,
            stringValue: this.vpc.vpcCidrBlock,
            description: `Shared VPC CIDR for ${props.targetEnvironment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // Store subnet IDs in SSM
        const publicSubnets = this.vpc.publicSubnets;
        publicSubnets.forEach((subnet, idx) => {
            new ssm.StringParameter(this, `SsmPublicSubnet${idx + 1}`, {
                parameterName: `${ssmPrefix}/public-subnet-${idx + 1}-id`,
                stringValue: subnet.subnetId,
                description: `Public Subnet ${idx + 1} ID`,
                tier: ssm.ParameterTier.STANDARD,
            });
        });

        new ssm.StringParameter(this, 'SsmPublicSubnetIds', {
            parameterName: `${ssmPrefix}/public-subnet-ids`,
            stringValue: publicSubnets.map(s => s.subnetId).join(','),
            description: 'All public subnet IDs (comma-separated)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // Isolated (data-tier) subnet IDs — consumed by PlatformRdsStack via
        // deploy-time SSM dynamic references (no Vpc.fromLookup, no context cache).
        const isolatedSubnets = this.vpc.isolatedSubnets;
        isolatedSubnets.forEach((subnet, idx) => {
            new ssm.StringParameter(this, `SsmIsolatedSubnet${idx + 1}`, {
                parameterName: `${ssmPrefix}/isolated-subnet-${idx + 1}-id`,
                stringValue: subnet.subnetId,
                description: `Isolated Subnet ${idx + 1} ID`,
                tier: ssm.ParameterTier.STANDARD,
            });
        });

        new ssm.StringParameter(this, 'SsmIsolatedSubnetIds', {
            parameterName: `${ssmPrefix}/isolated-subnet-ids`,
            stringValue: isolatedSubnets.map(s => s.subnetId).join(','),
            description: 'All isolated subnet IDs (comma-separated)',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmAvailabilityZones', {
            parameterName: `${ssmPrefix}/availability-zones`,
            stringValue: publicSubnets.map(s => s.availabilityZone).join(','),
            description: 'Availability zones (comma-separated)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =====================================================================
        // Stack outputs (for visibility only - NO exportName to avoid coupling)
        // =====================================================================
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpc.vpcId,
            description: 'Shared VPC ID (also in SSM: ' + ssmPrefix + '/vpc-id)',
        });

        new cdk.CfnOutput(this, 'VpcCidr', {
            value: this.vpc.vpcCidrBlock,
            description: 'Shared VPC CIDR',
        });

        new cdk.CfnOutput(this, 'PublicSubnetIds', {
            value: publicSubnets.map(s => s.subnetId).join(','),
            description: 'All public subnet IDs (comma-separated)',
        });

        new cdk.CfnOutput(this, 'AvailabilityZones', {
            value: publicSubnets.map(s => s.availabilityZone).join(','),
            description: 'Availability zones (comma-separated)',
        });

        new cdk.CfnOutput(this, 'VpcLookupName', {
            value: `shared-vpc-${props.targetEnvironment}`,
            description: 'Use this Name tag with Vpc.fromLookup() to reference this VPC',
        });
    }

    private configureGatewayEndpoints(config?: GatewayEndpointConfig): void {
        const enableS3 = config?.enableS3Endpoint !== false;
        const enableDynamoDb = config?.enableDynamoDbEndpoint !== false;

        if (enableS3) {
            (this as { s3Endpoint?: ec2.GatewayVpcEndpoint }).s3Endpoint =
                this.vpc.addGatewayEndpoint('S3Endpoint', {
                    service: ec2.GatewayVpcEndpointAwsService.S3,
                    subnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
                });
        }

        if (enableDynamoDb) {
            (this as { dynamoDbEndpoint?: ec2.GatewayVpcEndpoint }).dynamoDbEndpoint =
                this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
                    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
                    subnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
                });
        }
    }

    private configureFlowLogs(config: FlowLogConfig): void {
        if (config.encryptionKey) {
            (this as { flowLogEncryptionKey?: kms.IKey }).flowLogEncryptionKey = config.encryptionKey;
        } else if (config.createEncryptionKey !== false) {
            (this as { flowLogEncryptionKey?: kms.IKey }).flowLogEncryptionKey = new kms.Key(this, 'FlowLogKey', {
                alias: `vpc-flow-logs-${this.targetEnvironment}`,
                description: 'KMS key for VPC Flow Logs encryption',
                enableKeyRotation: true,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            });

            this.flowLogEncryptionKey!.addToResourcePolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
                actions: [
                    'kms:Encrypt*',
                    'kms:Decrypt*',
                    'kms:ReEncrypt*',
                    'kms:GenerateDataKey*',
                    'kms:Describe*',
                ],
                resources: ['*'],
                conditions: {
                    ArnLike: {
                        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
                    },
                },
            }));
        }

        const logGroup = new logs.LogGroup(this, 'FlowLogGroup', {
            logGroupName: config.logGroupName ?? `/vpc/shared-${this.environment}/flow-logs`,
            retention: config.retentionDays ?? logs.RetentionDays.ONE_MONTH,
            encryptionKey: this.flowLogEncryptionKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        (this as { flowLogGroup?: logs.ILogGroup }).flowLogGroup = logGroup;

        this.vpc.addFlowLog('FlowLog', {
            trafficType: ec2.FlowLogTrafficType.ALL,
            destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup),
        });
    }
}
