/**
 * @format
 * Version History Handler — Article Version Query Endpoint
 *
 * Lambda handler that returns the complete version history for a
 * given article slug. Used by the admin dashboard to display all
 * pipeline runs, their QA scores, status, and timestamps.
 *
 * This handler is invoked via AWS SDK Lambda.invoke() from the
 * Next.js admin dashboard, similar to the publish-handler.
 *
 * Query pattern: pk = ARTICLE#<slug>, sk begins_with VERSION#
 * Results are returned in descending order (newest first).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { log } from '../../../shared/src/index.js';
import type { ArticleVersionRecord } from '../../../shared/src/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Input event from the admin dashboard.
 */
export interface VersionHistoryInput {
    /** Article slug to query version history for */
    readonly slug: string;
    /** Maximum number of versions to return (default: 20) */
    readonly limit?: number;
}

/**
 * Output response to the admin dashboard.
 */
export interface VersionHistoryOutput {
    /** Whether the query succeeded */
    readonly success: boolean;
    /** Article slug queried */
    readonly slug: string;
    /** Total number of versions found */
    readonly totalVersions: number;
    /** Version records (newest first) */
    readonly versions: ArticleVersionRecord[];
    /** Error message if failed */
    readonly message?: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/** DynamoDB table for article metadata */
const TABLE_NAME = process.env.PIPELINE_TABLE_NAME ?? process.env.TABLE_NAME ?? '';

/** Default and maximum number of versions to return */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// =============================================================================
// CLIENTS
// =============================================================================

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for querying article version history.
 *
 * Returns all VERSION#v<n> records for a given article slug,
 * sorted by version number in descending order (newest first).
 *
 * @param event - Version history query input
 * @returns Version history response with all version records
 */
export const handler = async (event: VersionHistoryInput): Promise<VersionHistoryOutput> => {
    const { slug } = event;
    const limit = Math.min(event.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    log('INFO', 'Querying version history', { handler: 'version-history', slug, limit });

    if (!TABLE_NAME) {
        log('ERROR', 'TABLE_NAME not configured', { handler: 'version-history' });
        return {
            success: false,
            slug,
            totalVersions: 0,
            versions: [],
            message: 'TABLE_NAME not configured',
        };
    }

    try {
        const result = await ddbClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk': `ARTICLE#${slug}`,
                ':skPrefix': 'VERSION#',
            },
            ScanIndexForward: false, // descending — newest version first
            Limit: limit,
        }));

        const versions = (result.Items ?? []) as ArticleVersionRecord[];

        log('INFO', 'Version history query complete', { handler: 'version-history', slug, count: versions.length });

        return {
            success: true,
            slug,
            totalVersions: versions.length,
            versions,
        };
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log('ERROR', 'Version history query failed', { handler: 'version-history', slug, error: err.message });

        return {
            success: false,
            slug,
            totalVersions: 0,
            versions: [],
            message: `Failed to query version history: ${err.message}`,
        };
    }
};
