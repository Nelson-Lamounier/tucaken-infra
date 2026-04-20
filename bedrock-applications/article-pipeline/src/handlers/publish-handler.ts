/**
 * @format
 * Publish Handler — Admin-Invoked Article Approval/Rejection
 *
 * This Lambda is invoked by the Next.js admin dashboard (via AWS SDK)
 * when an administrator approves or rejects an article from the review queue.
 *
 * It is NOT part of the Step Functions state machine. It runs separately,
 * triggered by the admin's action in the dashboard.
 *
 * Versioning: The admin specifies which version to approve/reject.
 * On approval:
 *   - Copy MDX from review/v{n}/{slug}.mdx → published/{slug}.mdx
 *   - Copy MDX to content/v{n}/{slug}.mdx (immutable snapshot)
 *   - Update VERSION#v{n} record → status='published'
 *   - Update METADATA record → status='published', publishedVersion=n
 *   - Mark any previously published version as 'superseded'
 *   - Fire ISR revalidation
 *
 * On rejection:
 *   - Copy MDX from review/v{n}/{slug}.mdx → archived/v{n}/{slug}.mdx
 *   - Update VERSION#v{n} record → status='rejected'
 *   - METADATA status unchanged
 */

import {
    S3Client,
    CopyObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    UpdateCommand,
    QueryCommand,
    GetCommand,
} from '@aws-sdk/lib-dynamodb';

import { log } from '../../../shared/src/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Actions available to the admin for article review.
 */
export type PublishAction = 'approve' | 'reject';

/**
 * Input event from the admin dashboard.
 */
export interface PublishHandlerInput {
    /** Article slug to approve or reject */
    readonly slug: string;
    /** Version number to approve or reject */
    readonly version: number;
    /** Pipeline execution ID for audit trail */
    readonly pipelineId?: string;
    /** Admin action: approve or reject */
    readonly action: PublishAction;
}

/**
 * Output response to the admin dashboard.
 */
export interface PublishHandlerOutput {
    /** Whether the operation succeeded */
    readonly success: boolean;
    /** Article slug processed */
    readonly slug: string;
    /** Version processed */
    readonly version: number;
    /** Action performed */
    readonly action: PublishAction;
    /** New article status */
    readonly status: string;
    /** Human-readable message */
    readonly message: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/** S3 bucket for article content */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

/** DynamoDB table for article metadata */
const TABLE_NAME = process.env.PIPELINE_TABLE_NAME ?? process.env.TABLE_NAME ?? '';

/** S3 prefixes */
const REVIEW_PREFIX = process.env.REVIEW_PREFIX ?? 'review/';
const PUBLISHED_PREFIX = process.env.PUBLISHED_PREFIX ?? 'published/';
const CONTENT_PREFIX = process.env.CONTENT_PREFIX ?? 'content/';
const ARCHIVED_PREFIX = process.env.ARCHIVED_PREFIX ?? 'archived/';

/** ISR revalidation endpoint (Next.js app) */
const ISR_ENDPOINT = process.env.ISR_ENDPOINT ?? '';

/** Runtime environment */
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

// =============================================================================
// CLIENTS
// =============================================================================

const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// S3 OPERATIONS
// =============================================================================

/**
 * Copy an S3 object from one key to another within the same bucket.
 *
 * @param bucket - S3 bucket name
 * @param sourceKey - Source object key
 * @param destKey - Destination object key
 */
async function copyS3Object(bucket: string, sourceKey: string, destKey: string): Promise<void> {
    log('INFO', 'S3 copy', { handler: 'publish', sourceKey, destKey });
    await s3Client.send(new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceKey}`,
        Key: destKey,
    }));
}

/**
 * Delete an S3 object.
 *
 * @param bucket - S3 bucket name
 * @param key - Object key to delete
 */
async function deleteS3Object(bucket: string, key: string): Promise<void> {
    log('INFO', 'S3 delete', { handler: 'publish', key });
    await s3Client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
}

// =============================================================================
// DYNAMODB OPERATIONS
// =============================================================================

/**
 * Update a VERSION#v<n> record status in DynamoDB.
 *
 * @param slug - Article slug
 * @param version - Version number
 * @param status - New status
 * @param timestampField - Field to set with current timestamp
 */
async function updateVersionStatus(
    slug: string,
    version: number,
    status: string,
    timestampField: string,
): Promise<void> {
    const now = new Date().toISOString();
    const versionSk = `VERSION#v${version}`;

    log('INFO', 'DynamoDB version status update', { handler: 'publish', slug, versionSk, status });

    await ddbClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: `ARTICLE#${slug}`,
            sk: versionSk,
        },
        UpdateExpression: `SET #status = :status, ${timestampField} = :ts, updatedAt = :ts`,
        ExpressionAttributeNames: {
            '#status': 'status',
        },
        ExpressionAttributeValues: {
            ':status': status,
            ':ts': now,
        },
    }));
}

/**
 * Promote a version to published state in METADATA.
 *
 * Updates the METADATA record with the published version's details,
 * points to the published/ S3 prefix, and marks any previously
 * published version as 'superseded'.
 *
 * @param slug - Article slug
 * @param version - Version being published
 */
async function promoteVersionToMetadata(
    slug: string,
    version: number,
): Promise<void> {
    const now = new Date().toISOString();
    const datePrefix = now.slice(0, 10);
    const pk = `ARTICLE#${slug}`;

    // =====================================================================
    // Read the VERSION record being published so we can copy its
    // consumer-facing article fields (title, description, tags, etc.)
    // into METADATA. This ensures METADATA always reflects the
    // published version's data — not a stale or skeleton record.
    // =====================================================================
    const versionRecord = await ddbClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: `VERSION#v${version}` },
    }));
    const vr = versionRecord.Item;

    if (!vr) {
        log('WARN', 'VERSION record not found — METADATA will be updated without article fields', {
            handler: 'publish', slug, version,
        });
    }

    // Find any currently published VERSION record to supersede
    const existingPublished = await ddbClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        FilterExpression: '#status = :published',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
            ':pk': pk,
            ':skPrefix': 'VERSION#',
            ':published': 'published',
        },
        ProjectionExpression: 'sk',
    }));

    // Mark previously published versions as superseded
    if (existingPublished.Items && existingPublished.Items.length > 0) {
        for (const item of existingPublished.Items) {
            const oldSk = item.sk as string;
            if (oldSk !== `VERSION#v${version}`) {
                log('INFO', 'Superseding previous version', { handler: 'publish', oldSk });
                await ddbClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { pk, sk: oldSk },
                    UpdateExpression: 'SET #status = :superseded, updatedAt = :now',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: {
                        ':superseded': 'superseded',
                        ':now': now,
                    },
                }));
            }
        }
    }

    // Update METADATA record — promote version to published state
    // and copy consumer-facing fields from the VERSION record.
    log('INFO', 'Updating METADATA to published', {
        handler: 'publish',
        slug,
        version,
        title: String(vr?.title ?? slug),
    });
    await ddbClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: 'METADATA' },
        UpdateExpression: [
            'SET #status = :published',
            'publishedVersion = :version',
            'publishedAt = :now',
            'updatedAt = :now',
            'contentRef = :contentRef',
            'gsi1pk = :gsi1pk',
            'gsi1sk = :gsi1sk',
            // Consumer-facing article fields from VERSION record
            'title = :title',
            'description = :description',
            'tags = :tags',
            'category = :category',
            'slug = :slug',
            'readingTimeMinutes = :readingTime',
            'aiSummary = :aiSummary',
            '#d = :publishDate',
            'version = :version',
            'entityType = :entityType',
        ].join(', '),
        ExpressionAttributeNames: {
            '#status': 'status',
            '#d': 'date',
        },
        ExpressionAttributeValues: {
            ':published': 'published',
            ':version': version,
            ':now': now,
            ':contentRef': `s3://${ASSETS_BUCKET}/${PUBLISHED_PREFIX}${slug}.mdx`,
            ':gsi1pk': 'STATUS#published',
            ':gsi1sk': `${datePrefix}#${slug}`,
            ':title': (vr?.title as string | undefined) ?? slug,
            ':description': (vr?.description as string | undefined) ?? '',
            ':tags': (vr?.tags as string[] | undefined) ?? [],
            ':category': (vr?.category as string | undefined) ?? '',
            ':slug': slug,
            ':readingTime': (vr?.readingTime as number | undefined) ?? 0,
            ':aiSummary': (vr?.aiSummary as string | undefined) ?? '',
            ':publishDate': (vr?.publishDate as string | undefined) ?? datePrefix,
            ':entityType': 'ARTICLE_METADATA',
        },
    }));
}

// =============================================================================
// ISR REVALIDATION
// =============================================================================

/**
 * Trigger ISR revalidation for the published article.
 *
 * Posts to the Next.js /api/revalidate endpoint to bust the cache
 * for the article page, making it immediately available.
 *
 * @param slug - Article slug to revalidate
 */
async function triggerIsrRevalidation(slug: string): Promise<void> {
    if (!ISR_ENDPOINT) {
        log('INFO', 'ISR revalidation skipped — no ISR_ENDPOINT configured', { handler: 'publish' });
        return;
    }

    const url = `${ISR_ENDPOINT}?path=/articles/${slug}`;
    log('INFO', 'Triggering ISR revalidation', { handler: 'publish', url });

    try {
        const response = await fetch(url, { method: 'POST' });
        log('INFO', 'ISR response received', { handler: 'publish', statusCode: response.status });
    } catch (error) {
        // ISR failure is non-fatal — the page will be regenerated on next request
        log('WARN', 'ISR revalidation failed (non-fatal)', { handler: 'publish', error: String(error) });
    }
}

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for article approval/rejection.
 *
 * Invoked by the Next.js admin dashboard via AWS SDK Lambda.invoke().
 *
 * @param event - Publish action event with slug, version, and action
 * @returns Operation result for the admin dashboard
 */
export const handler = async (event: PublishHandlerInput): Promise<PublishHandlerOutput> => {
    const { slug, version, action, pipelineId } = event;

    log('INFO', `${action.toUpperCase()} article`, {
        handler: 'publish',
        slug,
        version,
        action,
        pipelineId: pipelineId ?? 'N/A',
    });

    // Version-scoped review key
    const reviewKey = `${REVIEW_PREFIX}v${version}/${slug}.mdx`;

    try {
        if (action === 'approve') {
            const publishedKey = `${PUBLISHED_PREFIX}${slug}.mdx`;
            const contentKey = `${CONTENT_PREFIX}v${version}/${slug}.mdx`;

            // 1. Copy to published/ (overwrite live) and content/v{n}/ (immutable)
            await Promise.all([
                copyS3Object(ASSETS_BUCKET, reviewKey, publishedKey),
                copyS3Object(ASSETS_BUCKET, reviewKey, contentKey),
            ]);

            // 2. Delete from review/v{n}/
            await deleteS3Object(ASSETS_BUCKET, reviewKey);

            // 3. Update VERSION record → published
            await updateVersionStatus(slug, version, 'published', 'publishedAt');

            // 4. Promote to METADATA + supersede old published versions
            await promoteVersionToMetadata(slug, version);

            // 5. Trigger ISR revalidation
            await triggerIsrRevalidation(slug);

            // 6. Emit approval metric
            const emf = {
                _aws: {
                    Timestamp: Date.now(),
                    CloudWatchMetrics: [{
                        Namespace: 'BedrockMultiAgent',
                        Dimensions: [['Environment']],
                        Metrics: [{ Name: 'ArticlePublished', Unit: 'Count' }],
                    }],
                },
                Environment: ENVIRONMENT,
                Slug: slug,
                Version: version,
                ArticlePublished: 1,
            };
            console.log(JSON.stringify(emf));

            return {
                success: true,
                slug,
                version,
                action,
                status: 'published',
                message: `Article "${slug}" v${version} published successfully`,
            };
        } else {
            // Reject flow — version-scoped archiving
            const archivedKey = `${ARCHIVED_PREFIX}v${version}/${slug}.mdx`;

            // 1. Copy to archived/v{n}/
            await copyS3Object(ASSETS_BUCKET, reviewKey, archivedKey);

            // 2. Delete from review/v{n}/
            await deleteS3Object(ASSETS_BUCKET, reviewKey);

            // 3. Update VERSION record → rejected (METADATA untouched)
            await updateVersionStatus(slug, version, 'rejected', 'rejectedAt');

            // 4. Emit rejection metric
            const emf = {
                _aws: {
                    Timestamp: Date.now(),
                    CloudWatchMetrics: [{
                        Namespace: 'BedrockMultiAgent',
                        Dimensions: [['Environment']],
                        Metrics: [{ Name: 'ArticleRejected', Unit: 'Count' }],
                    }],
                },
                Environment: ENVIRONMENT,
                Slug: slug,
                Version: version,
                ArticleRejected: 1,
            };
            console.log(JSON.stringify(emf));

            return {
                success: true,
                slug,
                version,
                action,
                status: 'rejected',
                message: `Article "${slug}" v${version} rejected and archived`,
            };
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log('ERROR', `Failed to ${action} article`, { handler: 'publish', slug, version, error: err.message });

        return {
            success: false,
            slug,
            version,
            action,
            status: 'error',
            message: `Failed to ${action} article: ${err.message}`,
        };
    }
};
