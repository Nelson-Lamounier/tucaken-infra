#!/usr/bin/env npx tsx
/**
 * Pipeline Setup Script
 *
 * Pre-flight configuration for Kubernetes deployment pipelines.
 * Consolidates commit information, AWS account validation, and edge
 * configuration resolution into a single typed script — replacing
 * three inline shell steps.
 *
 * Usage:
 *   npx tsx scripts/ci/pipeline-setup.ts
 *
 * Environment Variables (read from GitHub Actions `env:` block):
 *   AWS_ACCOUNT_ID      — Target AWS account ID (from vars.AWS_ACCOUNT_ID)
 *   INPUT_DOMAIN        — Domain from workflow input (optional)
 *   INPUT_HZ_ID         — Hosted Zone ID from workflow input (optional)
 *   INPUT_ROLE_ARN      — Cross-account role ARN from workflow input (optional)
 *   VARS_DOMAIN         — Domain from GitHub environment vars (fallback)
 *   VARS_HZ_ID          — Hosted Zone ID from environment vars (fallback)
 *   VARS_ROLE_ARN       — Cross-account role ARN from environment vars (fallback)
 *   GITHUB_SHA          — Full commit SHA (injected by runner)
 *
 * Outputs (written to $GITHUB_OUTPUT):
 *   short-sha           — First 8 characters of the commit SHA
 *   domain-name         — Resolved domain name
 *   hosted-zone-id      — Resolved Route53 hosted zone ID
 *   cross-account-role-arn — Resolved cross-account IAM role ARN
 *
 * @module
 */

import { setOutput } from '@repo/script-utils/github.js';
import { maskSecret } from '@repo/script-utils/github.js';
import logger from '@repo/script-utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AWS_ACCOUNT_ID_REGEX = /^\d{12}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read an environment variable, returning an empty string if unset.
 *
 * @param name - Environment variable name
 * @returns The value or empty string
 */
function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/**
 * Resolve a value from an input variable, falling back to a vars variable.
 *
 * @param inputName - Environment variable name for the workflow input
 * @param varsName  - Environment variable name for the GitHub vars fallback
 * @returns The resolved value (may be empty)
 */
function resolveWithFallback(inputName: string, varsName: string): string {
  const input = env(inputName);
  return input !== '' ? input : env(varsName);
}

// ---------------------------------------------------------------------------
// Step 1: Commit Information
// ---------------------------------------------------------------------------

/**
 * Extract short SHA from the full commit SHA.
 * Sets the `short-sha` output for downstream steps.
 */
function recordCommitInfo(): void {
  const fullSha = env('GITHUB_SHA');
  if (fullSha === '') {
    logger.warn('GITHUB_SHA not set — running outside CI?');
    return;
  }

  const shortSha = fullSha.slice(0, 8);
  setOutput('short-sha', shortSha);
  logger.keyValue('Commit', shortSha);
}

// ---------------------------------------------------------------------------
// Step 2: AWS Account ID Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the AWS Account ID is a 12-digit number and mask it.
 *
 * @throws Exits with code 1 if the account ID is missing or invalid
 */
function validateAccountId(): void {
  const accountId = env('AWS_ACCOUNT_ID');

  if (accountId === '') {
    logger.error('AWS_ACCOUNT_ID variable not configured');
    process.exit(1);
  }

  if (!AWS_ACCOUNT_ID_REGEX.test(accountId)) {
    logger.error('Invalid AWS account ID format (expected 12 digits)');
    process.exit(1);
  }

  maskSecret(accountId);
  logger.success('AWS Account ID validated');
}

// ---------------------------------------------------------------------------
// Step 3: Edge Configuration Resolution
// ---------------------------------------------------------------------------

/** Resolved edge configuration values */
interface EdgeConfig {
  domainName: string;
  hostedZoneId: string;
  crossAccountRoleArn: string;
}

/**
 * Resolve edge configuration from inputs with vars fallback.
 * Masks all resolved values and writes them as step outputs for
 * the downstream synth step.
 *
 * @throws Exits with code 1 if any required value is missing
 */
function resolveEdgeConfig(): EdgeConfig {
  const domainName = resolveWithFallback('INPUT_DOMAIN', 'VARS_DOMAIN');
  const hostedZoneId = resolveWithFallback('INPUT_HZ_ID', 'VARS_HZ_ID');
  const crossAccountRoleArn = resolveWithFallback('INPUT_ROLE_ARN', 'VARS_ROLE_ARN');

  // Validate all required
  if (domainName === '') {
    logger.error('No domain name. Set DOMAIN_NAME in the GitHub environment');
    process.exit(1);
  }
  if (hostedZoneId === '') {
    logger.error('No hosted zone ID. Set HOSTED_ZONE_ID in the GitHub environment');
    process.exit(1);
  }
  if (crossAccountRoleArn === '') {
    logger.error('No cross-account role. Set DNS_VALIDATION_ROLE in the GitHub environment');
    process.exit(1);
  }

  // Write outputs BEFORE masking — masking before setOutput causes GitHub Actions
  // to store '***' or '' in the output context, making values unavailable to
  // downstream steps (documented GitHub Actions limitation).
  setOutput('domain-name', domainName);
  setOutput('hosted-zone-id', hostedZoneId);
  setOutput('cross-account-role-arn', crossAccountRoleArn);

  // Mask after writing so log display is still redacted.
  maskSecret(domainName);
  maskSecret(hostedZoneId);
  maskSecret(crossAccountRoleArn);

  logger.success('Edge config resolved');
  return { domainName, hostedZoneId, crossAccountRoleArn };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  logger.header('Pipeline Setup');

  recordCommitInfo();
  validateAccountId();
  resolveEdgeConfig();

  logger.blank();
  logger.success('Pipeline setup complete');
}

main();
