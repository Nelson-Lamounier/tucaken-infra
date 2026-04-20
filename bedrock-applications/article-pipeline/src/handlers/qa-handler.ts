/**
 * @format
 * QA Handler — Step Functions Entry Point
 *
 * Lambda handler invoked by Step Functions as the third stage
 * in the multi-agent pipeline. Validates the Writer's output,
 * writes the article to a version-scoped review/ S3 prefix,
 * and updates the VERSION#v<n> record in DynamoDB.
 *
 * Versioning: This handler writes to VERSION#v<n> records only.
 * The METADATA record is updated with latestVersion pointer but
 * its status is NOT changed — it preserves published state.
 *
 * This is the terminal Step Functions state for content generation.
 * The Publish Handler is invoked separately by the admin dashboard.
 *
 * Input: { context: PipelineContext, research: ..., writer: ... }
 * Output: PipelineOutput with pass/fail verdict and article status
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { executeQaAgent, QA_PASS_THRESHOLD } from '../agents/qa-agent.js';
import { log } from '../../../shared/src/index.js';
import type {
    ArticleStatus,
    PipelineOutput,
    QaHandlerInput,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** S3 bucket for article content */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

/** DynamoDB table for article metadata */
const TABLE_NAME = process.env.PIPELINE_TABLE_NAME ?? process.env.TABLE_NAME ?? '';

/** S3 prefix for articles awaiting review */
const REVIEW_PREFIX = process.env.REVIEW_PREFIX ?? 'review/';

/** Runtime environment */
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

// =============================================================================
// CLIENTS
// =============================================================================

const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// S3 + DYNAMODB PERSISTENCE
// =============================================================================

/**
 * Write the article MDX to a version-scoped review/ S3 prefix.
 *
 * Articles are written to review/v{n}/{slug}.mdx pending manual approval.
 * The Publish Handler later copies them to content/v{n}/ when approved.
 *
 * @param bucket - S3 bucket name
 * @param slug - Article slug
 * @param version - Article version number
 * @param content - Full MDX content
 */
async function writeToReviewPrefix(
    bucket: string,
    slug: string,
    version: number,
    content: string,
): Promise<void> {
    const key = `${REVIEW_PREFIX}v${version}/${slug}.mdx`;
    log('INFO', 'Writing review content to S3', { handler: 'qa', bucket, key });

    await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: 'text/mdx',
    }));
}

/**
 * Update the VERSION#v<n> record in DynamoDB with QA results.
 *
 * This updates the immutable version snapshot created by the trigger
 * handler with QA scores, article metadata, and final status.
 * The METADATA record is NOT overwritten — only a latestVersion
 * pointer is updated to help the dashboard find the newest version.
 *
 * @param tableName - DynamoDB table name
 * @param output - Complete pipeline output
 */
async function writeVersionToDynamoDB(
    tableName: string,
    output: PipelineOutput,
): Promise<void> {
    const { writer, qa, context, articleStatus } = output;
    const now = new Date().toISOString();
    const datePrefix = now.slice(0, 10);
    const versionSk = `VERSION#v${context.version}`;

    const item = {
        // CRITICAL: Use the pipeline's authoritative slug (from context),
        // NOT the writer's metadata slug. The writer derives its own slug
        // from the article title, which may differ from the original S3 key.
        pk: `ARTICLE#${context.slug}`,
        sk: versionSk,
        version: context.version,
        status: articleStatus,
        // Article metadata (from writer)
        title: writer.data.metadata.title,
        description: writer.data.metadata.description,
        tags: writer.data.metadata.tags,
        slug: context.slug,
        publishDate: writer.data.metadata.publishDate,
        readingTime: writer.data.metadata.readingTime,
        category: writer.data.metadata.category,
        aiSummary: writer.data.metadata.aiSummary,
        technicalConfidence: qa.data.confidenceOverride, // QA overrides Writer's score
        skillsDemonstrated: writer.data.metadata.skillsDemonstrated,
        processingNote: writer.data.metadata.processingNote,
        shotListCount: writer.data.shotList.length,
        contentRef: `s3://${ASSETS_BUCKET}/${REVIEW_PREFIX}v${context.version}/${context.slug}.mdx`,
        // Pipeline metadata
        pipelineId: context.pipelineId,
        pipelineRetryAttempt: context.retryAttempt,
        pipelineCostUsd: context.cumulativeCostUsd,
        pipelineTokens: context.cumulativeTokens,
        // QA metadata
        qaScore: qa.data.overallScore,
        qaRecommendation: qa.data.recommendation,
        qaSummary: qa.data.summary,
        qaDimensions: qa.data.dimensions,
        // Timestamps
        createdAt: context.startedAt,
        updatedAt: now,
        environment: ENVIRONMENT,
        // GSI1 — STATUS index for dashboard queries (includes version)
        gsi1pk: `STATUS#${articleStatus}`,
        gsi1sk: `${datePrefix}#${context.slug}#v${context.version}`,
    };

    log('INFO', 'Writing DynamoDB VERSION record', {
        handler: 'qa',
        versionSk,
        status: articleStatus,
        qaScore: qa.data.overallScore,
    });

    await ddbClient.send(new PutCommand({
        TableName: tableName,
        Item: item,
    }));

    // =====================================================================
    // Upsert METADATA with all consumer-facing article fields.
    //
    // This ensures that pipeline-generated articles have a complete
    // METADATA record immediately — the admin dashboard and public site
    // read title, description, tags, etc. directly from METADATA.
    //
    // CRITICAL: Both gsi1pk AND gsi1sk MUST be set together.
    // DynamoDB GSIs require both the partition key and sort key to be
    // present on an item for it to be projected into the index. If
    // either is missing, the item is invisible to GSI queries — which
    // is how the frontend's admin dashboard discovers articles.
    // =====================================================================
    const metadataGsi1sk = `${datePrefix}#${context.slug}`;
    log('INFO', 'Upserting METADATA record', {
        handler: 'qa',
        latestVersion: context.version,
        status: articleStatus,
        title: writer.data.metadata.title,
        gsi1pk: `STATUS#${articleStatus}`,
        gsi1sk: metadataGsi1sk,
    });
    await ddbClient.send(new UpdateCommand({
        TableName: tableName,
        Key: {
            pk: `ARTICLE#${context.slug}`,
            sk: 'METADATA',
        },
        UpdateExpression: [
            'SET latestVersion = :v',
            'updatedAt = :now',
            'gsi1pk = :gsi1pk',
            'gsi1sk = :gsi1sk',
            // Consumer-facing article fields
            'slug = :slug',
            'title = :title',
            'description = :description',
            'tags = :tags',
            'category = :category',
            'contentRef = :contentRef',
            'aiSummary = :aiSummary',
            'readingTimeMinutes = :readingTime',
            '#s = :status',
            'version = :version',
            'entityType = :entityType',
            '#d = :publishDate',
        ].join(', '),
        ExpressionAttributeNames: {
            '#s': 'status',
            '#d': 'date',
        },
        ExpressionAttributeValues: {
            ':v': context.version,
            ':now': now,
            ':gsi1pk': `STATUS#${articleStatus}`,
            ':gsi1sk': metadataGsi1sk,
            ':slug': context.slug,
            ':title': writer.data.metadata.title,
            ':description': writer.data.metadata.description,
            ':tags': writer.data.metadata.tags,
            ':category': writer.data.metadata.category,
            ':contentRef': `s3://${ASSETS_BUCKET}/${REVIEW_PREFIX}v${context.version}/${context.slug}.mdx`,
            ':aiSummary': writer.data.metadata.aiSummary,
            ':readingTime': writer.data.metadata.readingTime,
            ':status': articleStatus,
            ':version': context.version,
            ':entityType': 'ARTICLE_METADATA',
            ':publishDate': writer.data.metadata.publishDate,
        },
    }));
}

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for the QA Agent.
 *
 * Validates the Writer's output, determines the article status,
 * writes to version-scoped S3 review prefix, and persists the
 * VERSION#v<n> record to DynamoDB.
 *
 * @param event - Step Functions input with context, research, and writer results
 * @returns Complete pipeline output with pass/fail verdict
 */
export const handler = async (event: QaHandlerInput): Promise<PipelineOutput> => {
    log('INFO', 'QA handler invoked', {
        handler: 'qa',
        pipelineId: event.context.pipelineId,
        slug: event.context.slug,
        version: event.context.version,
        retryAttempt: event.context.retryAttempt,
    });

    // Slug-divergence guard: warn if the Writer AI generated a different
    // slug than the pipeline's authoritative context.slug (derived from the
    // S3 filename). The context.slug is ALWAYS used for DDB operations.
    const writerSlug = event.writer?.data?.metadata?.slug;
    if (writerSlug && writerSlug !== event.context.slug) {
        log('WARN', 'Slug divergence detected', {
            handler: 'qa',
            contextSlug: event.context.slug,
            writerSlug,
        });
    }

    // 1. Execute QA Agent
    const qa = await executeQaAgent(
        event.context,
        event.writer.data,
        event.research.data.technicalFacts,
        event.research.data.mode,
    );

    // 2. Determine article status
    const passed = qa.data.overallScore >= QA_PASS_THRESHOLD;
    const articleStatus: ArticleStatus = passed ? 'review' : 'flagged';

    log('INFO', 'QA verdict determined', {
        handler: 'qa',
        score: qa.data.overallScore,
        threshold: QA_PASS_THRESHOLD,
        passed,
        articleStatus,
    });

    // 3. Build pipeline output
    const output: PipelineOutput = {
        context: event.context,
        research: event.research,
        writer: event.writer,
        qa,
        passed,
        articleStatus,
    };

    // 4. Write MDX to version-scoped review/ S3 prefix
    await writeToReviewPrefix(
        ASSETS_BUCKET,
        event.context.slug,
        event.context.version,
        event.writer.data.content,
    );

    // 5. Write VERSION record to DynamoDB + update METADATA.latestVersion
    await writeVersionToDynamoDB(TABLE_NAME, output);

    // 6. Emit pipeline-level EMF metrics
    const pipelineEmf = {
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
                {
                    Namespace: 'BedrockMultiAgent',
                    Dimensions: [['Environment']],
                    Metrics: [
                        { Name: 'PipelineCompleted', Unit: 'Count' },
                        { Name: 'PipelineCostUsd', Unit: 'None' },
                        { Name: 'PipelineQaScore', Unit: 'None' },
                        { Name: 'PipelineRetryCount', Unit: 'Count' },
                        { Name: 'PipelinePassed', Unit: 'Count' },
                    ],
                },
            ],
        },
        Environment: ENVIRONMENT,
        Slug: event.context.slug,
        Version: event.context.version,
        PipelineCompleted: 1,
        PipelineCostUsd: event.context.cumulativeCostUsd,
        PipelineQaScore: qa.data.overallScore,
        PipelineRetryCount: event.context.retryAttempt,
        PipelinePassed: passed ? 1 : 0,
    };
    console.log(JSON.stringify(pipelineEmf));

    return output;
};
