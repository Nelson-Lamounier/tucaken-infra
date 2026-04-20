#!/usr/bin/env tsx
/**
 * Test Articles API Endpoints
 *
 * Runs a series of HTTP requests against the articles API to verify
 * it's responding correctly. Reads API URL from .env.local.
 *
 * Usage: npx tsx scripts/test-api.ts
 */

import { readFileSync, existsSync } from 'fs'
import chalk from 'chalk'
import logger from '@repo/script-utils/logger.js'

// ========================================
// Configuration
// ========================================

function getApiUrl(): string {
  const envFile = '.env.local'

  if (!existsSync(envFile)) {
    logger.fatal(
      'NEXT_PUBLIC_API_URL not set in .env.local\n' +
      '\n' +
      'Please set NEXT_PUBLIC_API_URL in .env.local:\n' +
      '  NEXT_PUBLIC_API_URL=https://your-api-id.execute-api.eu-west-1.amazonaws.com/api',
    )
  }

  const content = readFileSync(envFile, 'utf-8')
  const match = content.match(/^NEXT_PUBLIC_API_URL=(.+)$/m)

  if (!match || !match[1].trim()) {
    logger.fatal(
      'NEXT_PUBLIC_API_URL not set in .env.local\n' +
      '\n' +
      'Please set NEXT_PUBLIC_API_URL in .env.local:\n' +
      '  NEXT_PUBLIC_API_URL=https://your-api-id.execute-api.eu-west-1.amazonaws.com/api',
    )
  }

  return match[1].trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '')
}

// ========================================
// Test Helpers
// ========================================

interface TestResult {
  name: string
  passed: boolean
  status?: number
  detail?: string
}

async function testEndpoint(
  name: string,
  url: string,
  options?: { showBody?: boolean; headersOnly?: boolean },
): Promise<TestResult> {
  logger.divider()
  console.log(`${name}`)
  logger.divider()
  console.log('')
  console.log(`Request:`)
  console.log(`  ${url}`)
  console.log('')

  try {
    const response = await fetch(url)

    if (options?.headersOnly) {
      console.log('Response Headers:')
      response.headers.forEach((value, key) => {
        console.log(`  ${key}: ${value}`)
      })
    } else {
      console.log('Response:')
      const text = await response.text()
      try {
        const json = JSON.parse(text)
        console.log(JSON.stringify(json, null, 2))
      } catch {
        console.log(text.slice(0, 500))
      }
    }

    console.log('')

    return {
      name,
      passed: response.ok,
      status: response.status,
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`Error: ${msg}`))
    console.log('')
    return { name, passed: false, detail: msg }
  }
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const apiUrl = getApiUrl()

  logger.header('🧪 Testing Articles API')
  console.log(`API Base URL: ${apiUrl}`)
  console.log('')

  const results: TestResult[] = []

  // Test 1: List all articles
  results.push(
    await testEndpoint('Test 1: GET /articles', `${apiUrl}/articles`),
  )

  // Test 2: Get specific article
  const slug = 'aws-devops-pro-exam-failure-to-success'
  results.push(
    await testEndpoint(`Test 2: GET /articles/${slug}`, `${apiUrl}/articles/${slug}`),
  )

  // Test 3: Get articles by tag
  const tag = 'aws'
  results.push(
    await testEndpoint(`Test 3: GET /articles/tag/${tag}`, `${apiUrl}/articles/tag/${tag}`),
  )

  // Test 4: Check response headers
  results.push(
    await testEndpoint(
      'Test 4: Check Response Headers',
      `${apiUrl}/articles`,
      { headersOnly: true },
    ),
  )

  // Summary
  logger.header('📊 Test Results')

  const passed = results.filter((r) => r.passed).length
  const total = results.length

  for (const result of results) {
    const icon = result.passed ? '✅' : '❌'
    const status = result.status ? ` (HTTP ${result.status})` : ''
    console.log(`  ${icon} ${result.name}${status}`)
  }
  console.log('')

  if (passed === total) {
    logger.success(`All ${total} tests passed!`)
  } else {
    logger.warn(`${passed}/${total} tests passed`)
  }
}

main().catch((error) => {
  logger.fatal(`API test failed: ${error.message}`)
})
