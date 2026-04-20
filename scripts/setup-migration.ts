#!/usr/bin/env tsx
/**
 * Migration Setup Script
 *
 * Pre-migration checks and configuration for article migration to DynamoDB.
 * Consolidates the previous setup-migration.sh and list-profiles.sh scripts.
 *
 * Features:
 *   - Verifies AWS credentials and lists available profiles
 *   - Checks DynamoDB table existence
 *   - Checks S3 bucket existence
 *   - Checks Node.js dependencies
 *   - Creates .env.migration configuration file
 *
 * Usage:
 *   npx tsx scripts/setup-migration.ts [--profile dev-account]
 *   npx tsx scripts/setup-migration.ts --list-profiles
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb'
import {
  S3Client,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'
import {
  STSClient,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-providers'
import logger from '@repo/script-utils/logger.js'
import { parseArgs, buildAwsConfig, exec } from '@repo/script-utils/aws.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'env', description: 'Environment: dev, staging, prod', hasValue: true, default: 'dev' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'table', description: 'DynamoDB table name', hasValue: true },
    { name: 'bucket', description: 'S3 bucket name', hasValue: true },
    { name: 'list-profiles', description: 'List available AWS profiles and exit', hasValue: false, default: false },
  ],
  'Setup and verify prerequisites for article migration',
)

// ========================================
// Profile Listing
// ========================================

async function listProfiles(): Promise<void> {
  logger.header('AWS Profile Helper')

  const credentialsFile = join(process.env.HOME || '~', '.aws', 'credentials')
  if (!existsSync(credentialsFile)) {
    logger.fatal(
      'No AWS credentials file found at ~/.aws/credentials\n' +
      '\n' +
      'Set up AWS credentials:\n' +
      '  $ aws configure',
    )
  }

  const content = readFileSync(credentialsFile, 'utf-8')
  const profiles = content
    .split('\n')
    .filter((line) => line.match(/^\[.+\]$/))
    .map((line) => line.replace(/[[\]]/g, ''))

  if (profiles.length === 0) {
    logger.fatal('No profiles found in ~/.aws/credentials')
  }

  if (process.env.AWS_PROFILE) {
    console.log(`Current profile: ${process.env.AWS_PROFILE} ✓`)
    console.log('')
  }

  for (const profile of profiles) {
    logger.divider()
    console.log(`Profile: ${profile}`)
    logger.divider()

    try {
      const sts = new STSClient({
        region: 'eu-west-1',
        credentials: fromIni({ profile }),
      })
      const identity = await sts.send(new GetCallerIdentityCommand({}))
      console.log(`  Status: ✓ Valid`)
      console.log(`  Account: ${identity.Account}`)
      console.log(`  Identity: ${identity.Arn}`)

      try {
        const region = exec(`aws configure get region --profile ${profile}`, { silent: true })
        console.log(`  Region: ${region}`)
      } catch {
        console.log(`  Region: not set`)
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  Status: ✗ Invalid or expired`)
      console.log(`  Error: ${msg.split('\n')[0]}`)
    }
    console.log('')
  }

  logger.divider()
  console.log('')
  console.log('To use a profile for migration:')
  console.log('  $ npx tsx scripts/setup-migration.ts --profile your-profile-name')
  console.log('')
}

// ========================================
// Main Setup
// ========================================

async function main(): Promise<void> {
  // Handle --list-profiles
  if (args['list-profiles']) {
    await listProfiles()
    return
  }

  const config = buildAwsConfig(args)
  const tableName =
    (args.table as string) ||
    process.env.DYNAMODB_TABLE_NAME ||
    `nextjs-personal-portfolio-${config.environment}`
  const bucketName =
    (args.bucket as string) ||
    process.env.S3_BUCKET_NAME ||
    `nextjs-article-assets-${config.environment}`

  logger.header('📋 Article Migration - Setup')
  logger.config('Configuration', {
    'AWS Region': config.region,
    ...(config.profile ? { 'AWS Profile': config.profile } : {}),
    'DynamoDB Table': tableName,
    'S3 Bucket': bucketName,
  })

  const totalSteps = 4

  // Step 1: Check AWS credentials
  logger.step(1, totalSteps, 'Checking AWS credentials...')

  const sts = new STSClient({
    region: config.region,
    credentials: config.credentials,
  })

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}))
    logger.success('AWS credentials configured')
    console.log(`  Account: ${identity.Account}`)
    console.log(`  Identity: ${identity.Arn}`)
  } catch {
    logger.fail('AWS credentials not configured')
    console.log('')
    console.log('Options:')
    console.log('  1. Use a profile: npx tsx scripts/setup-migration.ts --profile your-profile')
    console.log('  2. List profiles: npx tsx scripts/setup-migration.ts --list-profiles')
    console.log('  3. Configure AWS CLI: aws configure')
    process.exit(1)
  }
  console.log('')

  // Step 2: Check DynamoDB table
  logger.step(2, totalSteps, 'Checking DynamoDB table...')

  const dynamodb = new DynamoDBClient({
    region: config.region,
    credentials: config.credentials,
  })

  try {
    await dynamodb.send(
      new DescribeTableCommand({ TableName: tableName }),
    )
    logger.success(`DynamoDB table '${tableName}' exists`)
  } catch {
    logger.fail(`DynamoDB table '${tableName}' not found`)
    console.log('Please create the table first or use --table to specify a different name')
    process.exit(1)
  }
  console.log('')

  // Step 3: Check S3 bucket
  logger.step(3, totalSteps, 'Checking S3 bucket...')

  const s3 = new S3Client({
    region: config.region,
    credentials: config.credentials,
  })

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }))
    logger.success(`S3 bucket '${bucketName}' exists`)
  } catch {
    logger.fail(`S3 bucket '${bucketName}' not found`)
    console.log('Please create the bucket first or use --bucket to specify a different name')
    process.exit(1)
  }
  console.log('')

  // Step 4: Check dependencies
  logger.step(4, totalSteps, 'Checking Node.js dependencies...')

  if (!existsSync('node_modules/@aws-sdk/client-dynamodb')) {
    logger.warn('Installing dependencies...')
    exec('yarn install', { silent: true })
    logger.success('Dependencies installed')
  } else {
    logger.success('Dependencies already installed')
  }
  console.log('')

  // Create .env.migration file
  console.log('Creating .env.migration file...')
  const envContent = [
    '# Article Migration Configuration',
    `# Generated: ${new Date().toISOString()}`,
    '',
    '# Required',
    `AWS_REGION=${config.region}`,
    `DYNAMODB_TABLE_NAME=${tableName}`,
    `S3_BUCKET_NAME=${bucketName}`,
    '',
    '# AWS Profile (if using named profiles)',
    config.profile ? `AWS_PROFILE=${config.profile}` : '# AWS_PROFILE=',
    '',
    '# For testing only',
    '# DRY_RUN=true',
    '',
  ].join('\n')

  writeFileSync('.env.migration', envContent)
  logger.success('Created .env.migration')

  logger.summary('Setup Complete!', {
    'Table': tableName,
    'Bucket': bucketName,
    'Config File': '.env.migration',
  })

  logger.nextSteps([
    'Load environment: export $(cat .env.migration | xargs)',
    'Preview migration: yarn migrate:articles:dry-run',
    'Run migration: yarn migrate:articles',
  ])
}

main().catch((error) => {
  logger.fatal(`Setup failed: ${error.message}`)
})
