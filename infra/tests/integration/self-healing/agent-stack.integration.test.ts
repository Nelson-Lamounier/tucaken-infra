/**
 * @format
 * Self-Healing Agent Stack — Post-Deployment Smoke Test
 *
 * Runs AFTER the SelfHealing-Gateway and SelfHealing-Agent stacks are
 * deployed via CI (deploy-self-healing.yml). Calls real AWS APIs to
 * verify that all resources exist and are correctly wired.
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by both stacks
 *   2. Use those values to verify actual AWS resources
 *
 * Environment Variables:
 *   CDK_ENV    — Target environment (default: development)
 *   AWS_REGION — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test self-healing development
 */

import {
    EventBridgeClient,
    ListRulesCommand,
    DescribeRuleCommand,
} from '@aws-sdk/client-eventbridge';
import type { Rule } from '@aws-sdk/client-eventbridge';
import {
    LambdaClient,
    GetFunctionCommand,
    GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import type { FunctionConfiguration } from '@aws-sdk/client-lambda';
import {
    S3Client,
    HeadBucketCommand,
    GetBucketEncryptionCommand,
} from '@aws-sdk/client-s3';
import {
    SNSClient,
    GetTopicAttributesCommand,
} from '@aws-sdk/client-sns';
import {
    SQSClient,
    GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';

import type { DeployableEnvironment } from '../../../lib/config';
import { Environment } from '../../../lib/config';
import { selfHealingSsmPaths, selfHealingSsmPrefix } from '../../../lib/config/ssm-paths';
import type { SelfHealingSsmPaths } from '../../../lib/config/ssm-paths';
import { flatName } from '../../../lib/utilities/naming';

// =============================================================================
// Rule 4: Environment Variable Parsing — No Silent `as` Casts
// =============================================================================

/**
 * Parse and validate CDK_ENV environment variable.
 * Throws a descriptive error for invalid values.
 */
function parseEnvironment(raw: string): DeployableEnvironment {
    const valid = [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION] as const satisfies readonly DeployableEnvironment[];
    if (!valid.includes(raw as DeployableEnvironment)) {
        throw new Error(`Invalid CDK_ENV: "${raw}". Expected one of: ${valid.join(', ')}`);
    }
    return raw as DeployableEnvironment;
}

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = parseEnvironment(process.env.CDK_ENV ?? 'development');
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const SSM_PATHS = selfHealingSsmPaths(CDK_ENV);
const PREFIX = selfHealingSsmPrefix(CDK_ENV);
const NAME_PREFIX = flatName('self-healing', '', CDK_ENV);

// =============================================================================
// Rule 3: Magic Values — Named Constants Only
// =============================================================================

/** Expected number of SSM parameters published by both stacks */
const EXPECTED_SSM_PARAM_COUNT = 5;

/** Expected Lambda runtime */
const EXPECTED_RUNTIME = 'nodejs22.x';

/** Development-specific defaults (overridden per-env in allocations) */
const DEV_RESERVED_CONCURRENCY = 1;
const DEV_TIMEOUT_SECONDS = 120;

/** Lambda environment variables that MUST be set */
const REQUIRED_ENV_VARS = [
    'GATEWAY_URL',
    'FOUNDATION_MODEL',
    'DRY_RUN',
    'SYSTEM_PROMPT',
    'MEMORY_BUCKET',
] as const;

// =============================================================================
// AWS SDK Clients (shared across tests)
// =============================================================================

const ssm = new SSMClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const sns = new SNSClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const events = new EventBridgeClient({ region: REGION });

// =============================================================================
// Rule 2: Non-Null Assertions — Use a `requireParam` Helper
// =============================================================================

/**
 * Retrieve a required SSM parameter from the cached map.
 * Throws a descriptive error if the parameter is missing or empty.
 *
 * @param params - The SSM parameter Map<path, value>
 * @param path - The full SSM path to look up
 * @returns The parameter value (guaranteed non-empty)
 * @throws Error if the parameter is missing or empty
 */
function requireParam(params: Map<string, string>, path: string): string {
    const value = params.get(path);
    if (!value) throw new Error(`Missing required SSM parameter: ${path}`);
    return value;
}

// =============================================================================
// SSM Parameter Cache (loaded once at module level — Rule 1)
// =============================================================================

/**
 * Load all SSM parameters under the self-healing prefix in one paginated call.
 */
async function loadSsmParameters(): Promise<Map<string, string>> {
    const params = new Map<string, string>();
    let nextToken: string | undefined;

    do {
        const response = await ssm.send(
            new GetParametersByPathCommand({
                Path: PREFIX,
                Recursive: true,
                WithDecryption: true,
                NextToken: nextToken,
            }),
        );

        for (const param of response.Parameters ?? []) {
            if (param.Name && param.Value) {
                params.set(param.Name, param.Value);
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);

    return params;
}

// =============================================================================
// Module-Level Cached State (Rule 1 + Rule 10)
// =============================================================================

let ssmParams: Map<string, string>;
let lambdaConfig: FunctionConfiguration;
let lambdaEnvVars: Record<string, string>;
let eventBridgeRule: Rule | undefined;

// =============================================================================
// Top-Level beforeAll — Fetch All Module-Level Resources Once
// =============================================================================

beforeAll(async () => {
    // --- SSM Parameters (gate for everything else) ---
    ssmParams = await loadSsmParameters();

    // --- Lambda Configuration ---
    const functionName = requireParam(ssmParams, SSM_PATHS.agentLambdaName);
    const configResponse = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: functionName }),
    );
    lambdaConfig = configResponse;
    lambdaEnvVars = configResponse.Environment?.Variables ?? {};

    // --- EventBridge Rules ---
    const ruleName = `${NAME_PREFIX}-alarm-trigger`;
    const { Rules } = await events.send(
        new ListRulesCommand({ NamePrefix: ruleName }),
    );
    eventBridgeRule = (Rules ?? []).find((r: Rule) => r.Name === ruleName);
});

// =============================================================================
// Tests
// =============================================================================

describe('SelfHealingPipeline — Post-Deploy Smoke Test', () => {

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const expectedPaths = [
            'gatewayUrl',
            'gatewayId',
            'agentLambdaArn',
            'agentLambdaName',
            'agentDlqUrl',
        ] satisfies Array<keyof SelfHealingSsmPaths>;

        it('should have at least the expected number of SSM parameters published', () => {
            expect(ssmParams.size).toBeGreaterThanOrEqual(EXPECTED_SSM_PARAM_COUNT);
        });

        it.each(expectedPaths)(
            'should have a non-empty value for %s',
            (key) => {
                const path = SSM_PATHS[key];
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.length).toBeGreaterThan(0);
            },
        );

        it('should have a valid Gateway URL format', () => {
            const url = requireParam(ssmParams, SSM_PATHS.gatewayUrl);
            expect(url).toMatch(/^https:\/\//);
        });

        it('should have a valid Lambda ARN format', () => {
            const arn = requireParam(ssmParams, SSM_PATHS.agentLambdaArn);
            expect(arn).toMatch(/^arn:aws:lambda:/);
        });
    });

    // =========================================================================
    // Lambda — Configuration
    // Depends on: lambdaConfig populated in top-level beforeAll
    // =========================================================================
    describe('Agent Lambda — Configuration', () => {
        it('should exist and return configuration', () => {
            expect(lambdaConfig).toBeDefined();
            expect(lambdaConfig.FunctionName).toBeTruthy();
        });

        it('should use the expected runtime', () => {
            expect(lambdaConfig.Runtime).toBe(EXPECTED_RUNTIME);
        });

        // Dev-only assertions guarded at describe level (Rule 11)
        const devDescribe = CDK_ENV === Environment.DEVELOPMENT ? describe : describe.skip;

        devDescribe('Development-specific configuration', () => {
            it('should have the expected reserved concurrency', async () => {
                const functionName = requireParam(ssmParams, SSM_PATHS.agentLambdaName);
                const resp = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
                expect(resp.Concurrency?.ReservedConcurrentExecutions).toBe(DEV_RESERVED_CONCURRENCY);
            });

            it('should have the expected timeout', () => {
                expect(lambdaConfig.Timeout).toBe(DEV_TIMEOUT_SECONDS);
            });
        });

        it('should have a DLQ configured', () => {
            expect(lambdaConfig.DeadLetterConfig?.TargetArn).toBeTruthy();
        });
    });

    // =========================================================================
    // Lambda — Environment Variables
    // Depends on: lambdaEnvVars populated in top-level beforeAll
    // =========================================================================
    describe('Agent Lambda — Environment Variables', () => {
        it.each(REQUIRED_ENV_VARS)(
            'should have %s environment variable set',
            (envVar) => {
                expect(lambdaEnvVars[envVar]).toBeDefined();
                expect(lambdaEnvVars[envVar].length).toBeGreaterThan(0);
            },
        );

        // Dev-only assertions guarded at describe level (Rule 11)
        const devEnvDescribe = CDK_ENV === Environment.DEVELOPMENT ? describe : describe.skip;

        devEnvDescribe('Development-specific environment variables', () => {
            it('should have DRY_RUN set to "true"', () => {
                expect(lambdaEnvVars['DRY_RUN']).toBe('true');
            });
        });

        it('should have GATEWAY_URL matching the SSM parameter', () => {
            const ssmGatewayUrl = requireParam(ssmParams, SSM_PATHS.gatewayUrl);
            expect(lambdaEnvVars['GATEWAY_URL']).toBe(ssmGatewayUrl);
        });
    });

    // =========================================================================
    // EventBridge Rule
    // Depends on: eventBridgeRule populated in top-level beforeAll
    // =========================================================================
    describe('EventBridge — Alarm Trigger Rule', () => {
        it('should exist', () => {
            expect(eventBridgeRule).toBeDefined();
        });

        it('should be enabled', () => {
            expect(eventBridgeRule!.State).toBe('ENABLED');
        });

        it('should target CloudWatch alarm state changes', async () => {
            const { EventPattern } = await events.send(
                new DescribeRuleCommand({ Name: eventBridgeRule!.Name }),
            );
            expect(EventPattern).toBeDefined();

            const pattern = JSON.parse(EventPattern!) as Record<string, unknown>;
            expect(pattern['source']).toContain('aws.cloudwatch');
            expect(pattern['detail-type']).toContain('CloudWatch Alarm State Change');
        });
    });

    // =========================================================================
    // SQS — Dead Letter Queue
    // =========================================================================
    describe('SQS — Dead Letter Queue', () => {
        it('should exist and be accessible', async () => {
            const dlqUrl = requireParam(ssmParams, SSM_PATHS.agentDlqUrl);
            const { Attributes } = await sqs.send(
                new GetQueueAttributesCommand({
                    QueueUrl: dlqUrl,
                    AttributeNames: ['QueueArn'],
                }),
            );
            expect(Attributes).toBeDefined();
            expect(Attributes!['QueueArn']).toMatch(/^arn:aws:sqs:/);
        });
    });

    // =========================================================================
    // SNS — Reports Topic
    // =========================================================================
    describe('SNS — Remediation Reports Topic', () => {
        let topicArn: string | undefined;

        beforeAll(() => {
            topicArn = lambdaEnvVars['SNS_TOPIC_ARN'];
        });

        it('should exist and be accessible (if enabled)', async () => {
            // SNS topic is optional — only exists when notification email is configured.
            if (!topicArn) return;

            const { Attributes } = await sns.send(
                new GetTopicAttributesCommand({ TopicArn: topicArn }),
            );
            expect(Attributes).toBeDefined();
            expect(Attributes!['TopicArn']).toBe(topicArn);
        });
    });

    // =========================================================================
    // S3 — Conversation Memory Bucket
    // =========================================================================
    describe('S3 — Agent Memory Bucket', () => {
        it('should exist and be accessible', async () => {
            const bucketName = lambdaEnvVars['MEMORY_BUCKET'];
            expect(bucketName).toBeTruthy();

            // HeadBucket succeeds if the bucket exists and we have access
            await expect(
                s3.send(new HeadBucketCommand({ Bucket: bucketName })),
            ).resolves.toBeDefined();
        });

        it('should have encryption enabled', async () => {
            const bucketName = lambdaEnvVars['MEMORY_BUCKET'];
            expect(bucketName).toBeTruthy();

            const { ServerSideEncryptionConfiguration } = await s3.send(
                new GetBucketEncryptionCommand({ Bucket: bucketName }),
            );
            expect(ServerSideEncryptionConfiguration?.Rules).toBeDefined();
            expect(ServerSideEncryptionConfiguration!.Rules!.length).toBeGreaterThan(0);
        });
    });
});
