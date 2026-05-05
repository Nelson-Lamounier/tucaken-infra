#!/usr/bin/env node
/**
 * @format
 * CDK Multi-Project Infrastructure Entry Point
 *
 * Slim orchestrator: parses project/environment, delegates ALL context
 * resolution (VPC, env vars, secrets, CloudFront) to the project factory,
 * then applies cross-cutting aspects (tagging, compliance, DynamoDB guard).
 *
 * Usage:
 *   npx cdk synth -c project=monitoring -c environment=dev
 *   npx cdk synth -c project=kubernetes -c environment=dev
 *   npx cdk synth -c project=org -c environment=prod -c hostedZoneIds=Z123 -c trustedAccountIds=111,222
 */

import * as path from 'path';

// Load .env from monorepo root — must be before any app imports that call
// fromEnv() at module load time (configurations.ts evaluates eagerly).
// CI sets env vars via workflow env: blocks, so this is a no-op in CI.
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import * as cdk from 'aws-cdk-lib/core';

import { applyCdkNag, applyCommonSuppressions, CompliancePack, TaggingAspect } from '../lib/aspects';
import { isValidEnvironment, resolveEnvironment } from '../lib/config';
import { isValidProject, getProjectConfig, Project } from '../lib/config/projects';
import { getProjectFactoryFromContext } from '../lib/factories/project-registry';

const app = new cdk.App();

// ============================================================================
// 1. Parse & Validate Project + Environment
// ============================================================================

const projectContext = app.node.tryGetContext('project') as string | undefined;
const environmentContext = app.node.tryGetContext('environment') as string | undefined;

if (!projectContext || !isValidProject(projectContext)) {
    throw new Error(
        'Project context required. Use: -c project=kubernetes|shared|org|bedrock|self-healing -c environment=dev|staging|prod'
    );
}

if (!environmentContext || !isValidEnvironment(environmentContext)) {
    throw new Error(
        `Environment required. Use: -c project=${projectContext} -c environment=dev|staging|prod`
    );
}

const environment = resolveEnvironment(environmentContext);
const projectConfig = getProjectConfig(projectContext as Project);

// ============================================================================
// 1b. Fail-loud assertion — AWS_ACCOUNT_ID must be present.
//
// Synth time is the right place to fail. If we let a missing AWS_ACCOUNT_ID
// silently default (e.g., to a CDK_DEFAULT_ACCOUNT picked up from the
// caller's CLI credentials), we risk synthesizing a template that targets
// the wrong account.
//
// MANAGEMENT env additionally needs ROOT_ACCOUNT — we don't enforce that
// here because not every project requires the root account ARN.
// ============================================================================
if (!process.env.AWS_ACCOUNT_ID) {
    throw new Error(
        'AWS_ACCOUNT_ID env var is required. Set it in .env (local) or via ' +
        'GH Environment vars.AWS_ACCOUNT_ID (CI). Never hardcode account IDs.'
    );
}

console.log(`=== Project: ${projectConfig.namespace} | Environment: ${environment} ===`);

// ============================================================================
// 2. Create All Stacks
//
// ALL config flows via a single mechanism — no bridging needed in app.ts:
//   CI:    GitHub vars/secrets → workflow env: block → process.env
//   Local: .env file → dotenv → process.env
//
// Edge config (DOMAIN_NAME, HOSTED_ZONE_ID, CROSS_ACCOUNT_ROLE_ARN),
// email/secrets (NOTIFICATION_EMAIL, SES_FROM_EMAIL, VERIFICATION_SECRET),
// and all other values are resolved by typed config via fromEnv().
// CDK context is reserved for structural routing only (project, environment).
// ============================================================================

const factory = getProjectFactoryFromContext(projectContext, environment);
const { stacks } = factory.createAllStacks(app, {
    environment,
});

// ============================================================================
// 4. Cross-Cutting Aspects
// ============================================================================

// Infrastructure version — MUST be stable (not a git SHA or timestamp).
// Changing this value mutates the 'version' tag on launch templates,
// creating a new LT version that triggers ASG rolling replacement of
// all EC2 instances. Only bump when intentionally releasing infra changes.
const INFRA_VERSION = process.env.INFRA_VERSION ?? '1.0.0';

stacks.forEach(stack => {
    cdk.Aspects.of(stack).add(new TaggingAspect({
        environment,
        project: projectConfig.namespace?.toLowerCase() || projectConfig.displayName.toLowerCase(),
        owner: 'nelson-l',
        component: inferComponent(stack.stackName),
        version: INFRA_VERSION,
        costCentre: inferCostCentre(stack.stackName),
    }));
});

/**
 * Infer the component tag from a stack name.
 * Maps stack names to infrastructure layers for Cost Explorer grouping.
 */
function inferComponent(stackName: string): string {
    const name = stackName.toLowerCase();
    if (name.includes('data') || name.includes('storage')) return 'data';
    if (name.includes('edge') || name.includes('api') || name.includes('cloudfront')) return 'networking';
    if (name.includes('iam') || name.includes('dns') || name.includes('role')) return 'iam';
    if (name.includes('goldenami') || name.includes('ssm')) return 'tooling';
    if (name.includes('finops') || name.includes('budget')) return 'finops';
    if (name.includes('security')) return 'security';
    return 'compute';
}

/**
 * Infer the cost-centre from a stack name.
 * Maps stack names to FinOps cost-allocation categories.
 */
function inferCostCentre(stackName: string): 'infrastructure' | 'platform' | 'application' {
    const name = stackName.toLowerCase();
    if (name.includes('vpc') || name.includes('infra') || name.includes('dns') || name.includes('edge')) return 'infrastructure';
    if (name.includes('api') || name.includes('bedrock') || name.includes('content')) return 'application';
    return 'platform';
}

// CDK-Nag compliance checks
const enableNagChecks = app.node.tryGetContext('nagChecks') !== 'false';
if (enableNagChecks) {
    applyCdkNag(app, {
        packs: [CompliancePack.AWS_SOLUTIONS],
        verbose: false,
        reports: true,
    });
    stacks.forEach(stack => applyCommonSuppressions(stack));
}

// ============================================================================
// 4. Summary
// ============================================================================

const stackNames = stacks.map(s => `  - ${s.stackName}`).join('\n');
console.log(`\nStacks created:\n${stackNames}\n`);
