/**
 * @format
 * EKS Pod Identity Stack — IAM-to-ServiceAccount associations.
 *
 * One IAM role per binding (least-privilege per purpose), each linked to a
 * Kubernetes ServiceAccount via `CfnPodIdentityAssociation`. Replaces IRSA.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 4
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';


import { type PodIdentityBinding } from '../../config/eks';
import { type Environment } from '../../config/environments';

export interface EksPodIdentityStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly bindings: readonly PodIdentityBinding[];
    readonly karpenterInterruptionQueueArn: string;
    readonly workerNodeRoleArn: string;
    readonly hostedZoneIds: readonly string[];
    /**
     * Cross-account role ARN that holds the actual Route53 write permissions
     * (e.g. arn:aws:iam::<mgmt>:role/Route53DnsValidationRole). When set,
     * ExternalDNS gets `sts:AssumeRole` on this role and writes records via
     * the assumed identity (configured in EksAddonsStack via
     * `--aws-assume-role`). When unset, ExternalDNS falls back to direct
     * writes against `hostedZoneIds` in this account.
     */
    readonly crossAccountDnsRoleArn?: string;
    /** SNS topic ARN that Grafana publishes alerts to. Required when a grafana-alerting binding is present. */
    readonly grafanaAlertingTopicArn?: string;
}

export class EksPodIdentityStack extends cdk.Stack {
    public readonly roles: Record<string, iam.Role> = {};

    constructor(scope: Construct, id: string, props: EksPodIdentityStackProps) {
        super(scope, id, props);

        // vpc-cni + kube-proxy moved to EksSystemNodeGroupStack so they are
        // installed in parallel with the MNG — nodes need the CNI to reach
        // Ready, which is a prerequisite for this stack to deploy.

        new eks.CfnAddon(this, 'PodIdentityAgent', {
            clusterName: props.cluster.clusterName,
            addonName: 'eks-pod-identity-agent',
            resolveConflicts: 'OVERWRITE',
        });

        // CoreDNS — EKS auto-installs the Deployment without our system
        // toleration. Default scheduling fails on a single-pool cluster
        // where every node has `dedicated=system:NoSchedule`. Pending
        // CoreDNS → no cluster DNS → every Helm chart that resolves an
        // AWS endpoint at boot (Karpenter, ALB controller, ESO) fails
        // its API connectivity check and CrashLoops, which in turn
        // causes the Helm `wait: true` custom resource to time out and
        // rolls the addons stack back. Managed addon with explicit
        // tolerations side-steps the issue and stays put across stack
        // rollbacks because it lives here, not in EksAddonsStack.
        new eks.CfnAddon(this, 'CoreDns', {
            clusterName: props.cluster.clusterName,
            addonName: 'coredns',
            resolveConflicts: 'OVERWRITE',
            configurationValues: JSON.stringify({
                tolerations: [
                    { key: 'dedicated', value: 'system', effect: 'NoSchedule' },
                    { key: 'CriticalAddonsOnly', operator: 'Exists' },
                ],
            }),
        });


        const podIdentityPrincipal = new iam.ServicePrincipal('pods.eks.amazonaws.com');

        for (const b of props.bindings) {
            const role = new iam.Role(this, `Role-${b.purpose}`, {
                assumedBy: podIdentityPrincipal,
                description: `Pod Identity role for ${b.namespace}/${b.serviceAccount}`,
            });
            // EKS Pod Identity requires `sts:TagSession` on top of the default
            // `sts:AssumeRole` so the service can attach session tags
            // (eks-cluster-arn, kubernetes-namespace, etc). Without it, the
            // PodIdentityAssociation create call rejects the role with
            // "Trust policy of the role provided is invalid".
            role.assumeRolePolicy?.addStatements(
                new iam.PolicyStatement({
                    actions: ['sts:TagSession'],
                    principals: [podIdentityPrincipal],
                }),
            );
            this.attachPurposePolicies(role, b.purpose, props);
            this.roles[b.purpose] = role;

            new eks.CfnPodIdentityAssociation(this, `Assoc-${b.purpose}`, {
                clusterName: props.cluster.clusterName,
                namespace: b.namespace,
                serviceAccount: b.serviceAccount,
                roleArn: role.roleArn,
            });
        }
    }

    private attachPurposePolicies(
        role: iam.Role,
        purpose: PodIdentityBinding['purpose'],
        props: EksPodIdentityStackProps,
    ): void {
        switch (purpose) {
            case 'karpenter':
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'sqs:ReceiveMessage',
                            'sqs:DeleteMessage',
                            'sqs:GetQueueAttributes',
                        ],
                        resources: [props.karpenterInterruptionQueueArn],
                    }),
                );
                // EKS control-plane introspection — Karpenter calls
                // DescribeCluster at startup to resolve the cluster endpoint
                // and CA cert. Without this, the controller crashes with
                // 'failed to resolve cluster endpoint'.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: ['eks:DescribeCluster'],
                        resources: ['*'],
                    }),
                );
                // Karpenter v1 manages EC2 instance profiles for nodes it
                // launches — creates one per EC2NodeClass, attaches the
                // worker node role, deletes on NodePool teardown. All these
                // actions must succeed or Karpenter blocks scheduling.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'iam:CreateInstanceProfile',
                            'iam:DeleteInstanceProfile',
                            'iam:GetInstanceProfile',
                            'iam:ListInstanceProfiles',
                            'iam:TagInstanceProfile',
                            'iam:AddRoleToInstanceProfile',
                            'iam:RemoveRoleFromInstanceProfile',
                        ],
                        resources: ['*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'ec2:RunInstances',
                            'ec2:CreateTags',
                            'ec2:CreateLaunchTemplate',
                            'ec2:CreateFleet',
                            'ec2:DescribeInstances',
                            'ec2:DescribeImages',
                            'ec2:DescribeInstanceTypes',
                            'ec2:DescribeInstanceTypeOfferings',
                            'ec2:DescribeSubnets',
                            'ec2:DescribeSecurityGroups',
                            'ec2:DescribeAvailabilityZones',
                            'ec2:DescribeSpotPriceHistory',
                            'ec2:DescribeLaunchTemplates',
                            'ec2:DescribeLaunchTemplateVersions',
                            'ec2:TerminateInstances',
                            'ec2:DeleteLaunchTemplate',
                            'pricing:GetProducts',
                        ],
                        resources: ['*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: ['iam:PassRole'],
                        resources: [props.workerNodeRoleArn],
                    }),
                );
                // Karpenter resolves AMI aliases (e.g. `al2023@latest`) by
                // reading EKS-published SSM parameters under
                // /aws/service/eks/optimized-ami/*. Without this, alias
                // discovery silently returns zero AMIs and EC2NodeClass
                // stays AMIsReady=Unknown ("DependenciesNotReady"), which
                // blocks every NodePool from provisioning.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: ['ssm:GetParameter'],
                        resources: [
                            `arn:aws:ssm:${cdk.Stack.of(this).region}::parameter/aws/service/eks/optimized-ami/*`,
                            `arn:aws:ssm:${cdk.Stack.of(this).region}::parameter/aws/service/bottlerocket/*`,
                        ],
                    }),
                );
                break;
            case 'alb-controller': {
                // Vendored AWS-published IAM policy for the AWS Load Balancer
                // Controller. The previous minimal V1 policy was missing
                // ec2:CreateSecurityGroup et al., which blocked NLB IP-mode
                // provisioning for any LoadBalancer Service. The vendored
                // file is updated by re-fetching from
                // https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/<TAG>/docs/install/iam_policy.json
                const policyPath = path.join(
                    __dirname, 'iam-policies', 'aws-load-balancer-controller.json',
                );
                const policyDoc = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
                    Statement: Record<string, unknown>[];
                };
                for (const statement of policyDoc.Statement) {
                    role.addToPolicy(iam.PolicyStatement.fromJson(statement));
                }
                break;
            }
            case 'external-dns':
                if (props.crossAccountDnsRoleArn) {
                    // Cross-account zones (e.g. dev cluster writing into mgmt-account
                    // hosted zones). ExternalDNS calls sts:AssumeRole into this role
                    // and the role's own policy handles route53:ChangeResourceRecordSets
                    // on the target zones. Local role keeps no R53 perms.
                    //
                    // TagSession is required because Pod Identity's session tags
                    // (eks-cluster-arn, kubernetes-namespace, etc.) are part of every
                    // STS request — without it the cross-account assume fails:
                    //   AccessDenied: ... not authorized to perform: sts:TagSession
                    role.addToPolicy(
                        new iam.PolicyStatement({
                            actions: ['sts:AssumeRole', 'sts:TagSession'],
                            resources: [props.crossAccountDnsRoleArn],
                        }),
                    );
                } else if (props.hostedZoneIds.length > 0) {
                    // Same-account zones — write records directly.
                    role.addToPolicy(
                        new iam.PolicyStatement({
                            actions: ['route53:ChangeResourceRecordSets'],
                            resources: props.hostedZoneIds.map(
                                (z) => `arn:aws:route53:::hostedzone/${z}`,
                            ),
                        }),
                    );
                    role.addToPolicy(
                        new iam.PolicyStatement({
                            actions: ['route53:ListHostedZones', 'route53:ListResourceRecordSets'],
                            resources: ['*'],
                        }),
                    );
                }
                break;
            case 'external-secrets':
                role.addToPolicy(
                    new iam.PolicyStatement({
                        actions: [
                            'ssm:GetParameter',
                            'ssm:GetParameters',
                            'ssm:GetParametersByPath',
                            'secretsmanager:GetSecretValue',
                            'secretsmanager:DescribeSecret',
                            'kms:Decrypt',
                        ],
                        resources: ['*'],
                    }),
                );
                break;
            case 'ebs-csi':
                role.addManagedPolicy(
                    iam.ManagedPolicy.fromAwsManagedPolicyName(
                        'service-role/AmazonEBSCSIDriverPolicy',
                    ),
                );
                break;
            case 'grafana-alerting':
                if (props.grafanaAlertingTopicArn) {
                    role.addToPolicy(
                        new iam.PolicyStatement({
                            sid: 'GrafanaPublishAlerts',
                            actions: ['sns:Publish'],
                            resources: [props.grafanaAlertingTopicArn],
                        }),
                    );
                }
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'GrafanaCloudWatchRead',
                        actions: [
                            'cloudwatch:GetMetricData',
                            'cloudwatch:GetMetricStatistics',
                            'cloudwatch:ListMetrics',
                            'cloudwatch:DescribeAlarms',
                            'cloudwatch:ListTagsForResource',
                            'logs:StartQuery',
                            'logs:StopQuery',
                            'logs:GetQueryResults',
                            'logs:DescribeLogGroups',
                            'logs:GetLogEvents',
                            'logs:FilterLogEvents',
                        ],
                        resources: ['*'],
                    }),
                );
                break;
            case 'ingestion':
                // Bedrock InvokeModel for chunk enrichment (BedrockChunkEnricher)
                // and embeddings (TitanEmbeddingProvider). Scoped to all foundation
                // models and inference profiles — ingestion is model-agnostic.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'IngestionBedrockInvoke',
                        actions: [
                            'bedrock:InvokeModel',
                            'bedrock:InvokeModelWithResponseStream',
                        ],
                        resources: [
                            'arn:aws:bedrock:*::foundation-model/*',
                            `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
                        ],
                    }),
                );
                break;
            case 'job-strategist':
            case 'article-pipeline':
                // Bedrock InvokeModel for Claude research + strategist agents.
                // bedrock:Rerank for semantic reranking of retrieved passages
                // (RdsVectorStore.rerank — falls back to cosine top-K when absent,
                // but reranking improves retrieval quality significantly).
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'PipelineBedrockInvoke',
                        actions: [
                            'bedrock:InvokeModel',
                            'bedrock:InvokeModelWithResponseStream',
                        ],
                        resources: [
                            'arn:aws:bedrock:*::foundation-model/*',
                            `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
                        ],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'PipelineBedrockRerank',
                        actions: ['bedrock:Rerank'],
                        resources: [
                            'arn:aws:bedrock:*::foundation-model/*',
                            `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
                        ],
                    }),
                );
                break;
            case 'admin-api':
                // S3 access for presigned upload URLs (resume-imports) and
                // direct asset operations (articles). Bucket name is published
                // by ai-applications/infra bedrock/ai-content-stack at runtime
                // via SSM → ESO; scoped to * for dev since the ARN is not
                // available at CDK synthesis time.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'AdminApiS3Assets',
                        actions: [
                            's3:PutObject',
                            's3:GetObject',
                            's3:DeleteObject',
                        ],
                        resources: ['arn:aws:s3:::*/*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'AdminApiS3ListBucket',
                        actions: ['s3:ListBucket'],
                        resources: ['arn:aws:s3:::*'],
                    }),
                );
                // Cognito admin operations for the account-termination flow:
                //   AdminDisableUser — called from POST /api/admin/me/delete
                //                      to block login during the soft-delete
                //                      grace window.
                //   AdminEnableUser  — called from POST /api/admin/users/:id/restore
                //                      (support tool) to undo the disable.
                //   AdminDeleteUser  — called by the daily account-sweep
                //                      CronJob after the 30-day grace expires.
                //                      Frees the email for re-registration.
                // Scoped to all user pools in this account/region — the
                // specific pool ARN is not available at CDK synthesis time
                // (pool is created in a sibling stack with cross-stack ARN
                // imports adding deploy ordering complexity). Wildcard is
                // acceptable because the only resource type covered is
                // userpool and the account boundary already isolates dev/prod.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'AdminApiCognitoAccountTermination',
                        actions: [
                            'cognito-idp:AdminDisableUser',
                            'cognito-idp:AdminEnableUser',
                            'cognito-idp:AdminDeleteUser',
                        ],
                        resources: [
                            `arn:aws:cognito-idp:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:userpool/*`,
                        ],
                    }),
                );
                break;
            case 'image-updater':
                // ArgoCD Image Updater polls ECR for new image tags using
                // newest-build strategy (compares imagePushedAt timestamps).
                // GetAuthorizationToken is account-scoped (no resource ARN).
                // DescribeImages + ListImages cover the polling cycle.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'ImageUpdaterEcrRead',
                        actions: [
                            'ecr:GetAuthorizationToken',
                        ],
                        resources: ['*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'ImageUpdaterEcrDescribe',
                        actions: [
                            'ecr:DescribeRepositories',
                            'ecr:DescribeImages',
                            'ecr:ListImages',
                        ],
                        resources: [
                            `arn:aws:ecr:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:repository/*`,
                        ],
                    }),
                );
                break;
            case 'headlamp-token-pusher':
                // PostSync Job (charts/headlamp-config) reads the non-expiring
                // headlamp-viewer-token K8s Secret and pushes its value to SSM
                // so ops can retrieve the dashboard token without kubectl access.
                // Scoped to the single parameter — no wildcard.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'HeadlampPushViewerToken',
                        actions: ['ssm:PutParameter'],
                        resources: [
                            `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/k8s/${props.targetEnvironment}/headlamp-viewer-token`,
                        ],
                    }),
                );
                break;

            case 'admin-api':
                // S3 access for article assets (images, uploads). Bucket name is
                // environment-specific and resolved at runtime from env vars — kept
                // as a prefix wildcard to avoid a circular dependency on DataStack.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'AdminApiS3Assets',
                        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                        resources: ['arn:aws:s3:::*/*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'AdminApiS3ListBucket',
                        actions: ['s3:ListBucket'],
                        resources: ['arn:aws:s3:::*'],
                    }),
                );
                break;

            case 'image-updater':
                // ArgoCD Image Updater reads ECR to discover new image tags.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'ImageUpdaterEcrRead',
                        actions: ['ecr:GetAuthorizationToken'],
                        resources: ['*'],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'ImageUpdaterEcrDescribe',
                        actions: [
                            'ecr:BatchGetImage',
                            'ecr:GetDownloadUrlForLayer',
                            'ecr:DescribeImages',
                            'ecr:DescribeRepositories',
                            'ecr:ListImages',
                        ],
                        resources: [
                            `arn:aws:ecr:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:repository/*`,
                        ],
                    }),
                );
                break;

            case 'headlamp-token-pusher':
                // PostSync Job writes both SA tokens to SSM so operators can
                // retrieve them without kubectl. Scoped to the two token paths
                // for this environment only.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'HeadlampPushTokens',
                        actions: ['ssm:PutParameter'],
                        resources: [
                            `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/k8s/${props.targetEnvironment}/headlamp-viewer-token`,
                            `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/k8s/${props.targetEnvironment}/headlamp-admin-token`,
                        ],
                    }),
                );
                break;

            case 'ingestion':
                // Ingestion Jobs call Bedrock for chunk enrichment (skill/tech
                // extraction). Cross-region inference profiles route across eu-*
                // regions — both the profile ARN and the underlying foundation
                // model ARNs must be allowed for the request to succeed.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'IngestionBedrockInvoke',
                        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                        resources: [
                            `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
                            'arn:aws:bedrock:*::foundation-model/*',
                        ],
                    }),
                );
                break;

            case 'job-strategist':
                // Job-strategist K8s Jobs invoke Bedrock for multi-agent research
                // (JD analysis, gap identification, resume tailoring). Uses the
                // same eu.* cross-region inference profile as ingestion.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'JobStrategistBedrockInvoke',
                        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                        resources: [
                            `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
                            'arn:aws:bedrock:*::foundation-model/*',
                        ],
                    }),
                );
                break;

            case 'article-pipeline':
                // Article-pipeline K8s Jobs invoke Bedrock for content generation
                // and read draft markdown files from the shared S3 assets bucket.
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'ArticlePipelineBedrockInvoke',
                        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                        resources: [
                            `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
                            'arn:aws:bedrock:*::foundation-model/*',
                        ],
                    }),
                );
                role.addToPolicy(
                    new iam.PolicyStatement({
                        sid: 'ArticlePipelineS3DraftRead',
                        actions: ['s3:GetObject'],
                        resources: ['arn:aws:s3:::*/*'],
                    }),
                );
                break;
        }
    }
}
