/**
 * @format
 * Bedrock Data Stack
 *
 * Stateful resources for the Bedrock Agent project.
 * Owns the S3 bucket used as a Knowledge Base data source.
 *
 * Lifecycle: independent of Agent/API stacks — data persists across
 * agent redeployments.
 */

import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { ApplicationInferenceProfile } from '../../constructs/observability/application-inference-profile';

/**
 * Props for BedrockDataStack
 */
export interface BedrockDataStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Whether to create a customer-managed KMS key for S3 encryption */
    readonly createEncryptionKey: boolean;
    /** Removal policy for the S3 bucket */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** System inference profile ARN for Haiku 4.5 (used as CopyFrom source) */
    readonly haikuProfileSourceArn: string;
    /** System inference profile ARN for Sonnet 4.6 (used as CopyFrom source) */
    readonly sonnetProfileSourceArn: string;
    /** Runtime environment name (for profile tags) */
    readonly environmentName: string;
    /**
     * Email address to notify when the Bedrock monthly spend reaches budget thresholds.
     *
     * When provided, creates a `CfnBudget` that fires at 80 % and 100 % of
     * `monthlyBudgetUsd`. Notifications use AWS Budgets built-in email delivery
     * (no SNS topic needed).
     *
     * @default undefined — no budget alarm created
     */
    readonly budgetAlertEmail?: string;
    /**
     * Monthly Bedrock spend limit in USD.
     *
     * @default 20
     */
    readonly monthlyBudgetUsd?: number;
}

/**
 * Data Stack for Bedrock Agent.
 *
 * Creates the S3 bucket that serves as the data source for the
 * Bedrock Knowledge Base. Publishes bucket identifiers to SSM
 * for cross-stack discovery.
 */
export class BedrockDataStack extends cdk.Stack {
    /** The S3 bucket for Knowledge Base documents */
    public readonly dataBucket: s3.Bucket;

    /** S3 bucket for server access logs */
    public readonly accessLogsBucket: s3.Bucket;

    /** Optional KMS encryption key (production only) */
    public readonly encryptionKey?: kms.Key;

    /** The bucket name (for SSM export) */
    public readonly bucketName: string;

    /** Application Inference Profile ARN — Article Pipeline Haiku 4.5 */
    public readonly articleHaikuProfileArn: string;
    /** Application Inference Profile ARN — Article Pipeline Sonnet 4.6 */
    public readonly articleSonnetProfileArn: string;
    /** Application Inference Profile ARN — Strategist Pipeline Haiku 4.5 */
    public readonly strategistHaikuProfileArn: string;
    /** Application Inference Profile ARN — Strategist Pipeline Sonnet 4.6 */
    public readonly strategistSonnetProfileArn: string;

    constructor(scope: Construct, id: string, props: BedrockDataStackProps) {
        super(scope, id, props);

        const { namePrefix, createEncryptionKey, removalPolicy } = props;

        // =================================================================
        // KMS Encryption Key (production only)
        // =================================================================
        if (createEncryptionKey) {
            this.encryptionKey = new kms.Key(this, 'DataBucketKey', {
                alias: `${namePrefix}-data-bucket`,
                description: `KMS key for ${namePrefix} Knowledge Base data bucket`,
                enableKeyRotation: true,
                removalPolicy,
            });
        }

        // =================================================================
        // S3 Bucket — Access Logs (required by AwsSolutions-S1)
        // =================================================================
        this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
            bucketName: `${namePrefix}-access-logs`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy,
            autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(90),
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(30),
                        },
                    ],
                },
            ],
        });

        // =================================================================
        // S3 Bucket — Knowledge Base Data Source
        // =================================================================
        this.dataBucket = new s3.Bucket(this, 'DataBucket', {
            bucketName: `${namePrefix}-kb-data`,
            encryption: this.encryptionKey
                ? s3.BucketEncryption.KMS
                : s3.BucketEncryption.S3_MANAGED,
            encryptionKey: this.encryptionKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true,
            removalPolicy,
            autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
            serverAccessLogsBucket: this.accessLogsBucket,
            serverAccessLogsPrefix: 'data-bucket/',
        });
        this.bucketName = this.dataBucket.bucketName;

        // =================================================================
        // Application Inference Profiles — FinOps Cost Attribution
        //
        // Each profile wraps a system-defined inference profile with
        // cost-allocation tags, enabling per-pipeline billing in
        // AWS Cost Explorer.
        // =================================================================
        const profileTags = (component: string): cdk.CfnTag[] => [
            { key: 'project', value: 'bedrock' },
            { key: 'cost-centre', value: 'application' },
            { key: 'component', value: component },
            { key: 'environment', value: props.environmentName },
            { key: 'owner', value: 'nelson-l' },
            { key: 'managed-by', value: 'cdk' },
        ];

        const articleHaikuProfile = new ApplicationInferenceProfile(this, 'ArticleHaikuProfile', {
            profileName: `${namePrefix}-article-haiku`,
            modelSourceArn: props.haikuProfileSourceArn,
            description: 'Article pipeline research agent Haiku 4.5',
            tags: profileTags('article-pipeline'),
        });
        this.articleHaikuProfileArn = articleHaikuProfile.profileArn;

        const articleSonnetProfile = new ApplicationInferenceProfile(this, 'ArticleSonnetProfile', {
            profileName: `${namePrefix}-article-sonnet`,
            modelSourceArn: props.sonnetProfileSourceArn,
            description: 'Article pipeline writer and QA agents Sonnet 4.6',
            tags: profileTags('article-pipeline'),
        });
        this.articleSonnetProfileArn = articleSonnetProfile.profileArn;

        const strategistHaikuProfile = new ApplicationInferenceProfile(this, 'StrategistHaikuProfile', {
            profileName: `${namePrefix}-strategist-haiku`,
            modelSourceArn: props.haikuProfileSourceArn,
            description: 'Strategist pipeline research resume builder and coach Haiku 4.5',
            tags: profileTags('strategist'),
        });
        this.strategistHaikuProfileArn = strategistHaikuProfile.profileArn;

        const strategistSonnetProfile = new ApplicationInferenceProfile(this, 'StrategistSonnetProfile', {
            profileName: `${namePrefix}-strategist-sonnet`,
            modelSourceArn: props.sonnetProfileSourceArn,
            description: 'Strategist pipeline writer agent Sonnet 4.6',
            tags: profileTags('strategist'),
        });
        this.strategistSonnetProfileArn = strategistSonnetProfile.profileArn;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'BucketNameParam', {
            parameterName: `/${namePrefix}/data-bucket-name`,
            stringValue: this.dataBucket.bucketName,
            description: `Knowledge Base data bucket name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'BucketArnParam', {
            parameterName: `/${namePrefix}/data-bucket-arn`,
            stringValue: this.dataBucket.bucketArn,
            description: `Knowledge Base data bucket ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Monthly Budget Alarm — FinOps Guardrail (Gap C3)
        //
        // Creates an AWS Budgets cost alert scoped to the Amazon Bedrock
        // service. Fires SNS email notifications at 80 % (FORECASTED) and
        // 100 % (ACTUAL) of the monthly limit so spend spikes are caught
        // before the period ends.
        //
        // Only created when budgetAlertEmail is provided — omit in local/test
        // stacks to avoid stray budget resources.
        // =================================================================
        if (props.budgetAlertEmail) {
            const budgetAmountUsd = props.monthlyBudgetUsd ?? 20;

            new budgets.CfnBudget(this, 'BedrockMonthlyBudget', {
                budget: {
                    budgetName: `${namePrefix}-bedrock-monthly`,
                    budgetType: 'COST',
                    timeUnit: 'MONTHLY',
                    budgetLimit: {
                        amount: budgetAmountUsd,
                        unit: 'USD',
                    },
                    costFilters: {
                        // Scope to Bedrock service costs only
                        Service: ['Amazon Bedrock'],
                    },
                },
                notificationsWithSubscribers: [
                    {
                        notification: {
                            comparisonOperator: 'GREATER_THAN',
                            notificationType: 'FORECASTED',
                            threshold: 80,
                            thresholdType: 'PERCENTAGE',
                        },
                        subscribers: [{
                            address: props.budgetAlertEmail,
                            subscriptionType: 'EMAIL',
                        }],
                    },
                    {
                        notification: {
                            comparisonOperator: 'GREATER_THAN',
                            notificationType: 'ACTUAL',
                            threshold: 100,
                            thresholdType: 'PERCENTAGE',
                        },
                        subscribers: [{
                            address: props.budgetAlertEmail,
                            subscriptionType: 'EMAIL',
                        }],
                    },
                ],
            });
        }

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'DataBucketName', {
            value: this.dataBucket.bucketName,
            description: 'Knowledge Base data bucket name',
        });

        new cdk.CfnOutput(this, 'DataBucketArn', {
            value: this.dataBucket.bucketArn,
            description: 'Knowledge Base data bucket ARN',
        });

        new cdk.CfnOutput(this, 'AccessLogsBucketName', {
            value: this.accessLogsBucket.bucketName,
            description: 'Server access logs bucket name',
        });
    }
}
