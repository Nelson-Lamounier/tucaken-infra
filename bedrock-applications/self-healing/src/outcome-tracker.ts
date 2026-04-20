/**
 * @format
 * Remediation Outcome Tracker Lambda
 *
 * Triggered by EventBridge when a CloudWatch alarm transitions from ALARM → OK.
 * Correlates the resolution with a recent agent invocation in the outcomes
 * DynamoDB table to measure remediation effectiveness.
 *
 * Emits CloudWatch metrics:
 * - RemediationSuccess (1): Alarm resolved within look-back window of an agent invocation
 * - RemediationFailure (0): Alarm resolved but no recent agent invocation was found
 *
 * @see SH-R5 in docs/self_healing_design_review.md
 */

import {
    CloudWatchClient,
    PutMetricDataCommand,
    type MetricDatum,
} from '@aws-sdk/client-cloudwatch';
import {
    DynamoDBClient,
    QueryCommand,
    UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

import { log } from '../../../shared/src/index.js';

// =============================================================================
// Configuration
// =============================================================================

/** DynamoDB table for remediation outcomes */
const OUTCOMES_TABLE_NAME = process.env.OUTCOMES_TABLE_NAME ?? '';

/** CloudWatch metric namespace */
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? 'SelfHealing';

/** Look-back window: how far back to search for a matching invocation (30 min) */
const LOOKBACK_WINDOW_MS = 30 * 60 * 1000;

// =============================================================================
// AWS Clients
// =============================================================================

const dynamodb = new DynamoDBClient({});
const cloudwatch = new CloudWatchClient({});

// =============================================================================
// Types
// =============================================================================

/** EventBridge CloudWatch Alarm state change event */
interface AlarmOkEvent {
    readonly source?: string;
    readonly 'detail-type'?: string;
    readonly detail?: {
        readonly alarmName?: string;
        readonly state?: {
            readonly value?: string;
            readonly reason?: string;
        };
        readonly [key: string]: unknown;
    };
    readonly time?: string;
    readonly [key: string]: unknown;
}



// =============================================================================
// Handler
// =============================================================================

/**
 * Process an ALARM → OK transition event.
 *
 * Queries the outcomes table for a recent agent invocation matching the alarm,
 * updates the record with resolution time, and emits a success/failure metric.
 *
 * @param event - EventBridge CloudWatch Alarm state change event (state = OK)
 * @returns Status response
 */
export async function handler(event: AlarmOkEvent): Promise<{ statusCode: number; body: string }> {
    const alarmName = event.detail?.alarmName;
    const resolvedAt = event.time ?? new Date().toISOString();

    if (!alarmName) {
        log('WARN', 'Received event without alarmName, skipping');
        return { statusCode: 400, body: 'Missing alarmName' };
    }

    log('INFO', 'Processing alarm resolution', { alarmName, resolvedAt });

    try {
        // Query for recent invocations matching this alarm (last 30 min)
        const cutoffTime = new Date(Date.now() - LOOKBACK_WINDOW_MS).toISOString();

        const queryResult = await dynamodb.send(new QueryCommand({
            TableName: OUTCOMES_TABLE_NAME,
            KeyConditionExpression: 'alarmName = :alarm',
            FilterExpression: 'invokedAt >= :cutoff AND attribute_not_exists(resolvedAt)',
            ExpressionAttributeValues: {
                ':alarm': { S: alarmName },
                ':cutoff': { S: cutoffTime },
            },
            ScanIndexForward: false,
            Limit: 1,
        }));

        const items = queryResult.Items ?? [];

        if (items.length > 0) {
            // Match found — update with resolution time
            const item = items[0];
            const correlationId = item['correlationId']?.S ?? '';
            const invokedAt = item['invokedAt']?.S ?? '';

            const invokedAtMs = new Date(invokedAt).getTime();
            const resolvedAtMs = new Date(resolvedAt).getTime();
            const durationToResolveMs = resolvedAtMs - invokedAtMs;

            await dynamodb.send(new UpdateItemCommand({
                TableName: OUTCOMES_TABLE_NAME,
                Key: {
                    alarmName: { S: alarmName },
                    correlationId: { S: correlationId },
                },
                UpdateExpression: 'SET resolvedAt = :resolvedAt, durationToResolveMs = :duration',
                ExpressionAttributeValues: {
                    ':resolvedAt': { S: resolvedAt },
                    ':duration': { N: durationToResolveMs.toString() },
                },
            }));

            log('INFO', 'Remediation outcome: SUCCESS', {
                alarmName,
                correlationId,
                durationToResolveMs,
            });

            await emitMetric('RemediationSuccess', 1, alarmName);
        } else {
            // No matching invocation — alarm resolved without agent help (or outside window)
            log('INFO', 'No recent agent invocation found for alarm', { alarmName });
            await emitMetric('RemediationFailure', 0, alarmName);
        }

        return { statusCode: 200, body: 'OK' };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log('ERROR', 'Failed to process alarm resolution', { alarmName, error });
        return { statusCode: 500, body: error };
    }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Emit a CloudWatch metric for remediation outcome tracking.
 *
 * @param metricName - Metric name (RemediationSuccess or RemediationFailure)
 * @param value - Metric value (1 = success, 0 = failure)
 * @param alarmName - Alarm name dimension
 */
async function emitMetric(metricName: string, value: number, alarmName: string): Promise<void> {
    const datum: MetricDatum = {
        MetricName: metricName,
        Value: value,
        Unit: 'Count',
        Dimensions: [
            { Name: 'AlarmName', Value: alarmName },
        ],
        Timestamp: new Date(),
    };

    await cloudwatch.send(new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [datum],
    }));
}
