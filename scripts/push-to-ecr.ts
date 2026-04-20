#!/usr/bin/env tsx
/**
 * ECR Push Script
 *
 * Build and push Next.js Docker image to Amazon ECR,
 * then optionally sync static assets to S3.
 *
 * Auth modes:
 *   - CI/Pipeline: Uses OIDC (credentials from env vars, no --profile needed)
 *   - Local/Manual: Uses AWS CLI profile (--profile flag)
 *
 * Usage:
 *   Local:    npx tsx scripts/push-to-ecr.ts --env dev --profile dev-account
 *   Pipeline: npx tsx scripts/push-to-ecr.ts --env development --skip-build --ecr-url <uri> --image-name <name>
 */

import { join, resolve } from 'path'
import { existsSync, rmSync, mkdirSync } from 'fs'
import logger from '@repo/script-utils/logger.js'
import {
  parseArgs,
  buildAwsConfig,
  getSSMParameter,
  exec,
  execStream,
  resolveAuth,
} from '@repo/script-utils/aws.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'tag', description: 'Docker image tag', hasValue: true, default: 'latest' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'repo', description: 'ECR repository name', hasValue: true, default: 'nextjs-frontend' },
    { name: 'env', description: 'Environment: dev, staging, prod', hasValue: true, default: 'dev' },
    { name: 'skip-build', description: 'Skip Docker build (use existing image)', hasValue: false, default: false },
    { name: 'skip-sync', description: 'Skip S3 static asset sync', hasValue: false, default: false },
    { name: 'ecr-url', description: 'Pre-resolved ECR URL (skip SSM lookup)', hasValue: true },
    { name: 'image-name', description: 'Pre-built image name (use with --skip-build)', hasValue: true },
  ],
  'Build and push Docker image to ECR, then sync static assets to S3',
)

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const config = buildAwsConfig(args)
  const auth = resolveAuth(config.profile)
  const imageTag = args.tag as string
  const repoName = args.repo as string
  const skipBuild = args['skip-build'] as boolean
  const skipSync = args['skip-sync'] as boolean
  const ecrUrlArg = args['ecr-url'] as string | undefined
  const imageNameArg = args['image-name'] as string | undefined

  const projectRoot = join(__dirname, '..')

  logger.header('🚀 Next.js ECR Push Script')
  logger.config('Configuration', {
    'Auth Mode': auth.mode,
    'AWS Region': config.region,
    'Environment': config.environment,
    'Repository': repoName,
    'Image Tag': imageTag,
    'Skip Build': String(skipBuild),
  })

  const totalSteps = 5

  // ─── Step 1: Resolve ECR URL ────────────────────────────────────────
  let repoUri: string

  if (ecrUrlArg) {
    logger.step(1, totalSteps, 'Using provided ECR URL...')
    repoUri = ecrUrlArg
    logger.success(`ECR URL: ${repoUri}`)
  } else {
    logger.step(1, totalSteps, 'Discovering ECR URL...')

    const ssmParam = `/shared/ecr/${config.environment}/repository-uri`
    console.log(`   Looking up: ${ssmParam}`)

    const ssmValue = await getSSMParameter(ssmParam, config)
    if (ssmValue) {
      repoUri = ssmValue
      logger.success(`ECR URL: ${repoUri}`)
    } else {
      logger.fatal(
        `ECR repository URI not found in SSM: ${ssmParam}\n` +
        '   Use --ecr-url to provide it manually.',
      )
    }
  }

  // ─── Step 2: Docker login to ECR ────────────────────────────────────
  logger.step(2, totalSteps, 'Authenticating with ECR...')

  const registryUrl = repoUri.split('/')[0]
  const profileFlag = config.profile ? `--profile ${config.profile}` : ''

  exec(
    `aws ecr get-login-password --region ${config.region} ${profileFlag} | ` +
    `docker login --username AWS --password-stdin ${registryUrl}`,
    { silent: true },
  )
  logger.success('Docker authenticated with ECR')

  // ─── Step 3: Build Docker image (skippable in CI) ──────────────────
  let localImage: string

  if (skipBuild) {
    logger.step(3, totalSteps, 'Skipping Docker build (--skip-build)')
    localImage = imageNameArg || `${repoName}:${imageTag}`

    // Verify image exists locally
    try {
      exec(`docker image inspect ${localImage}`, { silent: true })
      logger.success(`Using existing image: ${localImage}`)
    } catch {
      logger.fatal(`Image not found locally: ${localImage}`)
    }
  } else {
    logger.step(3, totalSteps, 'Building Docker image...')
    localImage = `${repoName}:${imageTag}`

    // Fetch API URL from SSM for build-time injection
    console.log('   Fetching API URL from SSM...')
    const apiUrl = await getSSMParameter(
      `/nextjs/${config.environment}/api-gateway-url`,
      config,
    )

    if (apiUrl) {
      logger.success(`API URL: ${apiUrl}`)
    } else {
      logger.warn('API URL not found in SSM, build will use file fallback')
    }

    execStream(
      `docker build ` +
      `--platform linux/amd64 ` +
      `--build-arg NODE_ENV=production ` +
      `--build-arg NEXT_TELEMETRY_DISABLED=1 ` +
      `--build-arg NEXT_PUBLIC_API_URL="${apiUrl || ''}" ` +
      `-t "${localImage}" .`,
      { cwd: projectRoot },
    )
    logger.success(`Docker image built: ${localImage}`)
  }

  // ─── Step 4: Tag and push to ECR ───────────────────────────────────
  logger.step(4, totalSteps, 'Tagging and pushing to ECR...')

  const ecrImage = `${repoUri}:${imageTag}`
  exec(`docker tag ${localImage} ${ecrImage}`)
  execStream(`docker push ${ecrImage}`)
  logger.success(`Pushed: ${ecrImage}`)

  // ─── Step 5: Sync static assets to S3 ──────────────────────────────
  if (skipSync) {
    logger.step(5, totalSteps, 'Skipping S3 sync (--skip-sync)')
  } else {
    logger.step(5, totalSteps, 'Syncing static assets to S3...')

    // Clear stale local .next/static to avoid hash mismatches
    const localStaticDir = join(projectRoot, '.next', 'static')
    rmSync(localStaticDir, { recursive: true, force: true })
    mkdirSync(join(projectRoot, '.next'), { recursive: true })

    // Extract static assets from the Docker image
    try {
      const containerId = exec(
        `docker create ${localImage}`,
        { silent: true },
      )
      exec(
        `docker cp ${containerId}:/app/.next/static ${localStaticDir}`,
        { silent: true },
      )
      exec(`docker rm ${containerId}`, { silent: true })
      logger.success('Extracted static assets from Docker image')
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to extract static assets: ${msg}`)
    }

    // Delegate to sync script
    const syncScript = join(__dirname, 'sync-static-to-s3.ts')
    if (existsSync(syncScript)) {
      const syncArgs = `--env "${config.environment}" --region "${config.region}"`
      const profileArg = config.profile ? ` --profile "${config.profile}"` : ''
      execStream(`npx tsx ${syncScript} ${syncArgs}${profileArg}`)
    } else {
      logger.warn('sync-static-to-s3.ts not found. Skipping S3 sync.')
    }
  }

  logger.summary('Push Complete!', {
    'Image URI': `${repoUri}:${imageTag}`,
  })

  logger.nextSteps([
    `Deploy to ECS: npx tsx scripts/update-ecs-task.ts --env ${config.environment}`,
  ])
}

main().catch((error) => {
  logger.fatal(`ECR push failed: ${error.message}`)
})
