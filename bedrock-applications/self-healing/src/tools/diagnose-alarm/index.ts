/**
 * @format
 * Diagnose Alarm — MCP Tool Lambda
 *
 * Queries CloudWatch for alarm configuration and recent metric data,
 * returning a structured diagnostic report for the self-healing agent.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - alarmName (string, required): CloudWatch Alarm name to diagnose
 *
 * Output:
 *   - Alarm configuration (metric, threshold, comparison operator)
 *   - Current alarm state and reason
 *   - Recent metric datapoints (last 30 minutes)
 *   - Affected resources (extracted from alarm dimensions)
 */

import {
    CloudWatchClient,
    DescribeAlarmsCommand,
    GetMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import type {
    MetricAlarm,
    MetricDataResult,
} from '@aws-sdk/client-cloudwatch';

import { log } from '../../../../shared/src/index.js';

const cw = new CloudWatchClient({});

/** Duration of metric lookback window in milliseconds (30 minutes) */
const LOOKBACK_MS = 30 * 60 * 1000;

/** Maximum datapoints to request per metric query */
const MAX_DATAPOINTS = 30;

/**
 * MCP tool input schema
 */
interface DiagnoseInput {
    readonly alarmName: string;
}

/**
 * Structured diagnostic report returned by this tool
 */
interface DiagnosticReport {
    readonly alarmName: string;
    readonly exists: boolean;
    readonly state?: string;
    readonly stateReason?: string;
    readonly metric?: {
        readonly namespace: string;
        readonly name: string;
        readonly statistic: string;
        readonly period: number;
        readonly dimensions: Record<string, string>;
    };
    readonly threshold?: {
        readonly value: number;
        readonly comparisonOperator: string;
        readonly evaluationPeriods: number;
        readonly datapointsToAlarm: number;
    };
    readonly recentDatapoints?: number[];
    readonly affectedResources?: string[];
    readonly error?: string;
}

/**
 * Extract alarm configuration into a clean report structure.
 *
 * @param alarm - The CloudWatch MetricAlarm descriptor
 * @returns Partial diagnostic report with config details
 */
function extractAlarmConfig(alarm: MetricAlarm): Partial<DiagnosticReport> {
    const dimensions: Record<string, string> = {};
    for (const dim of alarm.Dimensions ?? []) {
        if (dim.Name && dim.Value) {
            dimensions[dim.Name] = dim.Value;
        }
    }

    const affectedResources = Object.entries(dimensions)
        .filter(([key]) => ['InstanceId', 'VolumeId', 'LoadBalancer', 'AutoScalingGroupName'].includes(key))
        .map(([key, value]) => `${key}: ${value}`);

    return {
        state: alarm.StateValue,
        stateReason: alarm.StateReason,
        metric: {
            namespace: alarm.Namespace ?? 'unknown',
            name: alarm.MetricName ?? 'unknown',
            statistic: alarm.Statistic ?? alarm.ExtendedStatistic ?? 'unknown',
            period: alarm.Period ?? 0,
            dimensions,
        },
        threshold: {
            value: alarm.Threshold ?? 0,
            comparisonOperator: alarm.ComparisonOperator ?? 'unknown',
            evaluationPeriods: alarm.EvaluationPeriods ?? 0,
            datapointsToAlarm: alarm.DatapointsToAlarm ?? alarm.EvaluationPeriods ?? 0,
        },
        affectedResources,
    };
}

/**
 * Fetch recent metric datapoints for the alarm's metric.
 *
 * @param alarm - The CloudWatch MetricAlarm descriptor
 * @returns Array of recent metric values
 */
async function fetchRecentDatapoints(alarm: MetricAlarm): Promise<number[]> {
    if (!alarm.Namespace || !alarm.MetricName) {
        return [];
    }

    const now = new Date();
    const start = new Date(now.getTime() - LOOKBACK_MS);

    const result = await cw.send(new GetMetricDataCommand({
        StartTime: start,
        EndTime: now,
        MetricDataQueries: [{
            Id: 'diagnosis',
            MetricStat: {
                Metric: {
                    Namespace: alarm.Namespace,
                    MetricName: alarm.MetricName,
                    Dimensions: alarm.Dimensions,
                },
                Period: alarm.Period ?? 300,
                Stat: alarm.Statistic ?? 'Average',
            },
            ReturnData: true,
        }],
        MaxDatapoints: MAX_DATAPOINTS,
    }));

    const metricData: MetricDataResult | undefined = result.MetricDataResults?.[0];
    return metricData?.Values ?? [];
}

/**
 * Lambda handler — diagnose a CloudWatch Alarm.
 *
 * @param event - MCP tool invocation event with `alarmName` input
 * @returns Structured diagnostic report
 */
export async function handler(event: DiagnoseInput): Promise<DiagnosticReport> {
    const { alarmName } = event;

    if (!alarmName) {
        return {
            alarmName: 'unknown',
            exists: false,
            error: 'Missing required input: alarmName',
        };
    }

    log('INFO', 'Diagnosing alarm', { alarmName });

    try {
        const alarmsResponse = await cw.send(new DescribeAlarmsCommand({
            AlarmNames: [alarmName],
            AlarmTypes: ['MetricAlarm'],
        }));

        const alarm = alarmsResponse.MetricAlarms?.[0];

        if (!alarm) {
            return {
                alarmName,
                exists: false,
                error: `Alarm '${alarmName}' not found`,
            };
        }

        const config = extractAlarmConfig(alarm);
        const recentDatapoints = await fetchRecentDatapoints(alarm);

        const report: DiagnosticReport = {
            alarmName,
            exists: true,
            ...config,
            recentDatapoints,
        };

        log('INFO', 'Diagnosis complete', {
            alarmName,
            state: report.state,
            datapointCount: recentDatapoints.length,
        });

        return report;
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log('ERROR', 'Diagnosis failed', { alarmName, error });

        return {
            alarmName,
            exists: false,
            error,
        };
    }
}
