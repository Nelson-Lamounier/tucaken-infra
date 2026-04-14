/**
 * @format
 * Kubernetes Application IAM Stack
 *
 * Attaches application-specific IAM policies (DynamoDB, S3, Secrets Manager,
 * SSM) to the instance role created by KubernetesControlPlaneStack.
 *
 * This stack is fully decoupled from the compute lifecycle. Adding a
 * DynamoDB table or S3 bucket only requires redeploying this stack,
 * not the underlying infrastructure.
 *
 * Key design decisions:
 * - Imports the instance role via direct cross-stack reference (loose coupling)
 * - All grants are conditional — no-op when props are absent
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

import { KubernetesControlPlaneStack } from './control-plane-stack';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesAppIamStack.
 *
 * All grant props are optional — omit to run the stack in
 * monitoring-only mode (no application IAM grants attached).
 */
export interface KubernetesAppIamStackProps extends cdk.StackProps {
    /** Reference to the control plane stack (for instance role) */
    readonly controlPlaneStack: KubernetesControlPlaneStack;

    /**
     * Instance role of the general-pool worker ASG.
     *
     * Application pods (admin-api, public-api, start-admin) run on worker nodes,
     * not the control plane. DynamoDB, S3, and Lambda grants must be attached to
     * the worker node instance role so pods can reach AWS services via IMDS.
     */
    readonly workerPoolRole: iam.IRole;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration (resolved from config layer) */
    readonly configs: K8sConfigs;

    /** SSM parameter prefix */
    readonly ssmPrefix: string;

    // =========================================================================
    // Application-tier grants (all optional)
    // =========================================================================

    /** DynamoDB table ARNs to grant read access (SSR queries) */
    readonly dynamoTableArns?: string[];

    /**
     * DynamoDB table ARNs to grant write access (admin operations).
     *
     * These tables receive UpdateItem and DeleteItem permissions
     * for admin operations such as article publishing and deletion.
     * This is a separate grant from read access to maintain the
     * principle of least privilege and clear audit trail.
     */
    readonly dynamoWriteTableArns?: string[];

    /** SSM path for DynamoDB KMS key ARN (customer-managed key) */
    readonly dynamoKmsKeySsmPath?: string;

    /** S3 bucket ARNs to grant read access (static assets) */
    readonly s3ReadBucketArns?: string[];

    /**
     * S3 bucket ARNs to grant write access (admin media uploads).
     *
     * These buckets receive PutObject and DeleteObject permissions
     * for admin operations such as uploading article images and videos
     * from the admin panel. Separate from read access to maintain
     * the principle of least privilege.
     */
    readonly s3WriteBucketArns?: string[];

    /** SSM parameter path wildcard for Next.js env vars */
    readonly ssmParameterPath?: string;

    /**
     * SSM parameter path wildcard for Bedrock infrastructure.
     *
     * Grants `ssm:GetParameter` for resolving Bedrock resource names
     * (S3 bucket, DynamoDB table, Lambda ARN) when the admin dashboard
     * triggers the article publishing pipeline.
     *
     * @example '/bedrock-dev/*'
     */
    readonly bedrockSsmPath?: string;

    /** Secrets Manager path pattern for Next.js auth secrets */
    readonly secretsManagerPathPattern?: string;

    /**
     * Lambda function ARNs to grant invocation access.
     *
     * Grants `lambda:InvokeFunction` for the admin-api BFF to trigger
     * the Bedrock publish, article, and strategist pipeline functions
     * via the EC2 instance role — no static Lambda credentials stored
     * in Kubernetes Secrets.
     *
     * @example ['arn:aws:lambda:eu-west-1:123:function:bedrock-dev-publish']
     */
    readonly lambdaInvokeArns?: string[];
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Application IAM Stack
 *
 * Decouples application-specific IAM grants from the compute infrastructure.
 * When you add a new DynamoDB table or S3 bucket, only this stack needs
 * redeployment — the ASG, Launch Template, and AMI remain untouched.
 */
export class KubernetesAppIamStack extends cdk.Stack {

    constructor(scope: Construct, id: string, props: KubernetesAppIamStackProps) {
        super(scope, id, props);

        // Import the instance roles from the control plane and worker pool stacks.
        // Application pods (admin-api, public-api, start-admin) run on worker nodes —
        // grants must land on the worker role. The control plane role also receives
        // the same grants for deploy.py bootstrap scripts (S3/SSM access).
        const controlPlaneRole = props.controlPlaneStack.instanceRole;
        const workerRole = props.workerPoolRole;

        const grantProps = {
            region: this.region,
            account: this.account,
            dynamoTableArns: props.dynamoTableArns,
            dynamoWriteTableArns: props.dynamoWriteTableArns,
            dynamoKmsKeySsmPath: props.dynamoKmsKeySsmPath,
            s3ReadBucketArns: props.s3ReadBucketArns,
            s3WriteBucketArns: props.s3WriteBucketArns,
            ssmParameterPath: props.ssmParameterPath,
            bedrockSsmPath: props.bedrockSsmPath,
            secretsManagerPathPattern: props.secretsManagerPathPattern,
            lambdaInvokeArns: props.lambdaInvokeArns,
        };

        // =====================================================================
        // Application-tier IAM grants
        //
        // Granted to both roles:
        //   - Worker node role  — pods (admin-api, public-api) use IMDS to access
        //                         DynamoDB, S3, and Lambda via the worker role.
        //   - Control plane role — deploy.py bootstrap scripts running via SSM
        //                          Automation need S3/SSM access on the control plane.
        //
        // All grants are conditional — no-op if the corresponding props are absent.
        // =====================================================================
        grantApplicationPermissions(workerRole, grantProps);
        grantApplicationPermissions(controlPlaneRole, grantProps);

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'InstanceRoleArn', {
            value: controlPlaneRole.roleArn,
            description: 'Control plane instance role ARN receiving application-tier grants',
        });
        new cdk.CfnOutput(this, 'WorkerRoleArn', {
            value: workerRole.roleArn,
            description: 'Worker node instance role ARN receiving application-tier grants',
        });
    }
}

// =============================================================================
// APPLICATION IAM GRANTS (inlined — single consumer)
// =============================================================================

interface ApplicationIamGrantsProps {
    readonly region: string;
    readonly account: string;
    readonly dynamoTableArns?: string[];
    readonly dynamoWriteTableArns?: string[];
    readonly dynamoKmsKeySsmPath?: string;
    readonly s3ReadBucketArns?: string[];
    readonly s3WriteBucketArns?: string[];
    readonly ssmParameterPath?: string;
    readonly bedrockSsmPath?: string;
    readonly secretsManagerPathPattern?: string;
    /** Lambda ARNs granted invocation access (admin-api BFF pipeline triggers). */
    readonly lambdaInvokeArns?: string[];
}

/**
 * Grant application-tier IAM permissions to the instance role.
 *
 * Permissions (all conditional — no-op if corresponding props are absent):
 * - DynamoDB read (SSR data queries)
 * - DynamoDB write (admin operations — UpdateItem, DeleteItem)
 * - DynamoDB KMS decrypt (customer-managed keys)
 * - S3 read (static assets)
 * - SSM parameter read (application env vars)
 * - Secrets Manager read (auth secrets)
 */
function grantApplicationPermissions(
    role: iam.IRole,
    props: ApplicationIamGrantsProps,
): void {
    const { region, account } = props;

    if (props.ssmParameterPath) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmNextJsParameterRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:GetParametersByPath',
            ],
            resources: [
                `arn:aws:ssm:${region}:${account}:parameter${props.ssmParameterPath}`,
            ],
        }));
    }

    if (props.bedrockSsmPath) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmBedrockParameterRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:GetParameters',
            ],
            resources: [
                `arn:aws:ssm:${region}:${account}:parameter${props.bedrockSsmPath}`,
            ],
        }));
    }

    if (props.dynamoTableArns && props.dynamoTableArns.length > 0) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'DynamoDbRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:Scan',
                'dynamodb:BatchGetItem',
            ],
            resources: [
                ...props.dynamoTableArns,
                ...props.dynamoTableArns.map(arn => `${arn}/index/*`),
            ],
        }));
    }

    if (props.dynamoWriteTableArns && props.dynamoWriteTableArns.length > 0) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'DynamoDbAdminWrite',
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
            ],
            resources: [
                ...props.dynamoWriteTableArns,
                ...props.dynamoWriteTableArns.map(arn => `${arn}/index/*`),
            ],
        }));
    }

    if (props.dynamoKmsKeySsmPath) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'DynamoKmsDecrypt',
            effect: iam.Effect.ALLOW,
            actions: [
                'kms:Decrypt',
                'kms:DescribeKey',
            ],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'kms:ViaService': `dynamodb.${region}.amazonaws.com`,
                },
            },
        }));
    }

    if (props.s3ReadBucketArns && props.s3ReadBucketArns.length > 0) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'S3Read',
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:ListBucket',
            ],
            resources: [
                ...props.s3ReadBucketArns,
                ...props.s3ReadBucketArns.map(arn => `${arn}/*`),
            ],
        }));
    }

    if (props.s3WriteBucketArns && props.s3WriteBucketArns.length > 0) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'S3AdminMediaWrite',
            effect: iam.Effect.ALLOW,
            actions: [
                's3:PutObject',
                's3:DeleteObject',
            ],
            resources: [
                ...props.s3WriteBucketArns.map(arn => `${arn}/*`),
            ],
        }));
    }

    if (props.secretsManagerPathPattern) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'secretsmanager:GetSecretValue',
            ],
            resources: [
                `arn:aws:secretsmanager:${region}:${account}:secret:${props.secretsManagerPathPattern}`,
            ],
        }));
    }

    if (props.lambdaInvokeArns && props.lambdaInvokeArns.length > 0) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'AdminApiBffLambdaInvoke',
            effect: iam.Effect.ALLOW,
            actions: [
                // Synchronous invocation for online requests
                'lambda:InvokeFunction',
                // Async (Event) invocation used by article publish pipeline
                'lambda:InvokeAsync',
            ],
            resources: props.lambdaInvokeArns,
        }));
    }
}
