/**
 * @format
 * Kubernetes Data Stack
 *
 * Consolidated data/storage resources for the K8s-hosted Next.js application.
 * This stack manages S3 assets and access logs.
 *
 * Domain: Data Layer (rarely changes)
 *
 * Resources:
 * 1. S3 Assets Bucket — Storage for images and media (read by in-cluster workloads via IAM)
 * 2. S3 Access Logs Bucket — Server access logs for the assets bucket
 * 3. SSM Parameters — Cross-stack references (bucket name, region)
 * 4. CloudFormation Outputs — exports for downstream stacks (Base, Edge, AppIam)
 *
 * NOTE: DynamoDB is now consolidated in the Bedrock AiContentStack
 * (`bedrock-{env}-ai-content`). The old `nextjs-personal-portfolio-{env}`
 * table was removed as part of the content pipeline consolidation.
 *
 * Configuration:
 * - Resource names imported from `../../config/nextjs` (nextjsResourceNames)
 * - SSM paths imported from `../../config` (nextjsSsmPaths)
 * - Environment-specific behaviour from `../../config/nextjs` (getNextJsConfigs)
 *
 * CI Integration:
 * - Unit tests: `tests/unit/stacks/kubernetes/data-stack.test.ts` (35 assertions)
 * - Integration tests: `tests/integration/kubernetes/data-stack.integration.test.ts`
 *   Post-deployment verification via `verify-data-stack` job in `_deploy-kubernetes.yml`.
 *   Gates the Base stack deploy — if data resources aren't healthy, the pipeline halts.
 *
 * NOTE: ECR has been migrated to SharedVpcStack. Applications discover
 *       ECR via SSM: /shared/ecr/{env}/repository-*
 *
 * @example
 * ```typescript
 * const dataStack = new KubernetesDataStack(app, 'K8s-Data-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     projectName: 'k8s',
 * });
 * ```
 */

import { NagSuppressions } from "cdk-nag";

import * as cdk from "aws-cdk-lib";

import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";

import { Construct } from "constructs";

import { applyCommonSuppressions } from "../../aspects/cdk-nag-aspect";
import {
  Environment,
  isProductionEnvironment,
  environmentRemovalPolicy,
  S3_INCOMPLETE_UPLOAD_EXPIRATION_DAYS,
  S3_CORS_DEFAULTS,
  S3_STORAGE_TRANSITION_DAYS,
  nextjsSsmPaths,
} from "../../config";
import { getNextJsConfigs } from "../../config/nextjs";
import {
  nextjsResourceNames,
} from "../../config/nextjs";
import { SsmParameterStoreConstruct } from "../../constructs/ssm";
import {
  S3BucketConstruct,
} from "../../constructs/storage";

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Props for KubernetesDataStack
 */
export interface KubernetesDataStackProps extends cdk.StackProps {
  /** Target environment */
  readonly targetEnvironment: Environment;

  /** Project name @default 'k8s' */
  readonly projectName?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * KubernetesDataStack — Data layer for K8s-hosted application
 *
 * Creates S3 storage resources in a single deployment unit.
 * SSM parameters publish resource identifiers for zero-coupling
 * cross-stack discovery (no CloudFormation exports for runtime use).
 *
 * NOTE: DynamoDB article data is now consolidated in the Bedrock
 * AiContentStack (`bedrock-{env}-ai-content`). The old PortfolioTable
 * was removed as part of the content pipeline consolidation.
 *
 * S3 Assets Bucket:
 * - Stores article images, diagrams, and media files
 * - Versioning enabled for content recovery
 * - Block public access (read by in-cluster workloads via task-role IAM)
 * - Lifecycle policies for cost optimisation
 *
 * SSM Parameters (published via SsmParameterStoreConstruct for-loop):
 * - assets-bucket-name — bucket name for asset reads
 * - aws-region — deployment region for SDK clients
 *
 * ═══════════════════════════════════════════════════════════════════
 * ⚠️ S3 CONSTRUCT ID WARNING
 *
 * Even with removalPolicy: RETAIN, renaming a construct ID in CDK
 * will ORPHAN the old resource and CREATE a new, empty one.
 * Never change S3 construct IDs without a migration plan.
 * ═══════════════════════════════════════════════════════════════════
 */
export class KubernetesDataStack extends cdk.Stack {
  // S3
  public readonly assetsBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;

  // SSM
  public readonly ssmPrefix: string;

  // Environment
  public readonly targetEnvironment: Environment;

  constructor(scope: Construct, id: string, props: KubernetesDataStackProps) {
    super(scope, id, {
      ...props,
    });

    const { targetEnvironment, projectName = "k8s" } = props;

    this.targetEnvironment = targetEnvironment;
    const paths = nextjsSsmPaths(targetEnvironment, projectName);
    this.ssmPrefix = paths.prefix;

    // Get project-specific configuration
    const nextjsConfig = getNextJsConfigs(targetEnvironment);
    const isProduction = isProductionEnvironment(targetEnvironment);

    // Environment-aware settings
    const removalPolicy = environmentRemovalPolicy(targetEnvironment);

    // =================================================================
    // NOTE: ECR has been migrated to SharedVpcStack
    // Applications discover ECR via SSM: /shared/ecr/{env}/repository-*
    // =================================================================

    // =================================================================
    // NOTE: DynamoDB has been consolidated to AiContentStack
    // Articles, metadata, and content are now in bedrock-{env}-ai-content
    // =================================================================

    // =================================================================
    // S3 ACCESS LOGS BUCKET
    // =================================================================

    const accessLogsBucketConstruct = new S3BucketConstruct(
      this,
      "AccessLogsBucket",
      {
        environment: targetEnvironment,
        config: {
          bucketName: `${projectName}-access-logs-${targetEnvironment}`,
          purpose: "access-logs",
          encryption: s3.BucketEncryption.S3_MANAGED,
          removalPolicy,
          autoDeleteObjects: !isProduction,
          versioned: true,
          lifecycleRules: [
            {
              id: "delete-old-logs",
              enabled: true,
              expiration: cdk.Duration.days(90),
              noncurrentVersionExpiration: cdk.Duration.days(30),
            },
          ],
        },
      },
    );
    this.accessLogsBucket = accessLogsBucketConstruct.bucket;

    const cfnAccessLogsBucket = this.accessLogsBucket.node
      .defaultChild as cdk.CfnResource;
    cfnAccessLogsBucket.addMetadata("checkov", {
      skip: [
        {
          id: "CKV_AWS_18",
          comment:
            "Access-logs destination bucket cannot log to itself — AWS limitation",
        },
      ],
    });

    // =================================================================
    // S3 ASSETS BUCKET
    // =================================================================

    const storageTransitions: s3.Transition[] | undefined = nextjsConfig.s3
      .enableIntelligentTiering
      ? [
          {
            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
            transitionAfter: cdk.Duration.days(S3_STORAGE_TRANSITION_DAYS),
          },
        ]
      : undefined;

    const assetsBucketConstruct = new S3BucketConstruct(this, "AssetsBucket", {
      environment: targetEnvironment,
      config: {
        bucketName: nextjsResourceNames(projectName, targetEnvironment)
          .assetsBucketName,
        purpose: "article-assets",
        versioned: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy,
        autoDeleteObjects: !isProduction,
        accessLogsBucket: this.accessLogsBucket,
        accessLogsPrefix: "assets-bucket/",
        lifecycleRules: [
          {
            id: "archive-old-versions",
            enabled: true,
            noncurrentVersionExpiration: cdk.Duration.days(
              nextjsConfig.s3.versionExpirationDays,
            ),
            transitions: storageTransitions,
          },
          {
            id: "delete-incomplete-uploads",
            enabled: true,
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(
              S3_INCOMPLETE_UPLOAD_EXPIRATION_DAYS,
            ),
          },
        ],
        cors: [
          {
            allowedMethods: [
              s3.HttpMethods.GET,
              s3.HttpMethods.PUT,
              s3.HttpMethods.POST,
            ],
            allowedOrigins: [...nextjsConfig.s3.corsOrigins],
            allowedHeaders: [...S3_CORS_DEFAULTS.allowedHeaders],
            maxAge: S3_CORS_DEFAULTS.maxAgeSeconds,
          },
        ],
      },
    });

    this.assetsBucket = assetsBucketConstruct.bucket;

    // NOTE: The CloudFront OAC bucket policy was removed on 2026-06-16 — the
    // CloudFront edge was retired in the EKS migration (verified: no
    // distributions exist in this account; the edge is now the shared ALB).
    // Assets are read by in-cluster workloads via their own task-role IAM,
    // not by a CloudFront service principal. Reinstate an OAC grant here only
    // if a CloudFront distribution is ever reintroduced.

    // =================================================================
    // SSM PARAMETERS FOR CROSS-STACK REFERENCES
    //
    // Uses SsmParameterStoreConstruct (L3) to batch-create parameters
    // from a flat record. Construct IDs and descriptions are
    // auto-generated from the SSM path.
    //
    // NOTE: DynamoDB table name SSM param is no longer written here.
    // It now lives at /bedrock-{env}/content-table-name, written by
    // AiContentStack. ExternalSecrets in nextjs / tucaken-app namespaces
    // resolve this path via the aws-ssm ClusterSecretStore and inject the
    // table name into the pod's ConfigMap-backed Secret.
    //
    // Consumer stacks discover these via nextjsSsmPaths().
    // =================================================================

    new SsmParameterStoreConstruct(this, "SsmParams", {
      parameters: {
        [paths.assetsBucketName]: this.assetsBucket.bucketName,
        [paths.awsRegion]: cdk.Stack.of(this).region,
      },
    });

    // =================================================================
    // MONITORING ADMIN IP ALLOWLIST (allow-ipv4, allow-ipv6)
    //
    // These SSM parameters are managed exclusively by the SSM
    // automation pipeline (_deploy-ssm-automation.yml → "Write Admin
    // IPs to SSM") using `aws ssm put-parameter --overwrite`.
    //
    // Previously created here as CDK StringParameter resources, but
    // that caused "already exists" conflicts when both pipelines ran.
    // Single ownership via the SSM pipeline is idempotent and avoids
    // CloudFormation resource conflicts.
    //
    // Paths (consumed by bootstrap_argocd.py Step 5b):
    //   /k8s/{env}/monitoring/allow-ipv4
    //   /k8s/{env}/monitoring/allow-ipv6
    // =================================================================

    // =================================================================
    // CDK NAG SUPPRESSIONS & TAGS
    // =================================================================

    applyCommonSuppressions(this);

    if (!isProduction) {
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/${this.stackName}/Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler`,
        [
          {
            id: "AwsSolutions-L1",
            reason:
              "CDK-managed Lambda runtime for S3 auto-delete, not customizable",
          },
        ],
        true,
      );
    }

    NagSuppressions.addResourceSuppressions(this.accessLogsBucket, [
      {
        id: "AwsSolutions-S1",
        reason: "Access logs bucket cannot log to itself - AWS limitation",
      },
    ]);

    // NOTE: AwsCustomResource Lambda suppression removed — SSM now uses native StringParameter

    // Stack tags

    // =================================================================
    // STACK OUTPUTS
    // =================================================================

    const exportPrefix = `${targetEnvironment}-${projectName}`;

    this._emitOutputs([
      {
        id: "AssetsBucketName",
        value: this.assetsBucket.bucketName,
        description: "S3 bucket name for article images and media",
        exportName: `${exportPrefix}-assets-bucket-name`,
      },
      {
        id: "AssetsBucketArn",
        value: this.assetsBucket.bucketArn,
        description: "S3 bucket ARN for IAM policies",
        exportName: `${exportPrefix}-assets-bucket-arn`,
      },
      {
        id: "AssetsBucketRegionalDomainName",
        value: this.assetsBucket.bucketRegionalDomainName,
        description: "S3 bucket regional domain name (asset origin)",
        exportName: `${exportPrefix}-assets-bucket-domain`,
      },
      {
        id: "SsmParameterPrefix",
        value: this.ssmPrefix,
        description: "SSM parameter path prefix for this environment",
      },
    ]);
  }

  // =========================================================================
  // CROSS-STACK GRANT HELPERS
  // =========================================================================

  /**
   * Grant S3 read access to the assets bucket.
   *
   * @example
   * ```typescript
   * dataStack.grantAssetsBucketRead(computeRole);
   * ```
   */
  public grantAssetsBucketRead(grantee: iam.IGrantable): iam.Grant {
    return this.assetsBucket.grantRead(grantee);
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Emit CloudFormation stack outputs from a data-driven array.
   * Each entry creates one `CfnOutput` with value, description,
   * and an optional cross-stack exportName.
   */
  private _emitOutputs(
    outputs: {
      id: string;
      value: string;
      description: string;
      exportName?: string;
    }[],
  ): void {
    for (const output of outputs) {
      new cdk.CfnOutput(this, output.id, {
        value: output.value,
        description: output.description,
        ...(output.exportName ? { exportName: output.exportName } : {}),
      });
    }
  }
}
