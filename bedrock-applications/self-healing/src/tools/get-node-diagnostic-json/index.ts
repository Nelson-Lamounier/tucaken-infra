/**
 * @format
 * Get Node Diagnostic JSON — MCP Tool Lambda
 *
 * Fetches the machine-readable `run_summary.json` from a Kubernetes
 * node via SSM SendCommand. This file is persisted by the Python
 * StepRunner during the bootstrap process and contains:
 *
 * - Overall bootstrap status (success/failed)
 * - Failure classification code (AMI_MISMATCH, S3_FORBIDDEN, etc.)
 * - Per-step timing, status, and error details
 *
 * The self-healing agent uses this data to determine the root cause
 * of a bootstrap failure without parsing unstructured CloudWatch logs.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - instanceId (string, required): EC2 instance ID to diagnose
 *
 * Output:
 *   - instanceId: The target instance
 *   - found: Whether run_summary.json exists on the node
 *   - summary: Parsed run_summary.json content
 *   - failureCode: Machine-readable failure classification
 *   - failedSteps: Array of step names that failed
 */

import {
    SSMClient,
    SendCommandCommand,
    GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';

import { log } from '../../../../shared/src/index.js';

const ssm = new SSMClient({});

/** Path to the run_summary.json file on the node */
const RUN_SUMMARY_PATH = '/opt/k8s-bootstrap/run_summary.json';

/** Maximum time to wait for SSM command completion (milliseconds) */
const SSM_POLL_TIMEOUT_MS = 20_000;

/** Poll interval for SSM command status (milliseconds) */
const SSM_POLL_INTERVAL_MS = 2_000;

// =============================================================================
// Types
// =============================================================================

/**
 * MCP tool input schema
 */
interface DiagnosticInput {
    readonly instanceId: string;
}

/**
 * Per-step status from the Python bootstrap StepRunner
 */
interface BootstrapStepSummary {
    readonly step_name: string;
    readonly status: string;
    readonly started_at: string;
    readonly completed_at: string;
    readonly duration_seconds: number;
    readonly error: string;
    readonly details: Record<string, unknown>;
}

/**
 * Parsed run_summary.json shape
 */
interface RunSummary {
    readonly updated_at: string;
    readonly overall_status: string;
    readonly failure_code: string | null;
    readonly total_steps: number;
    readonly failed_steps: string[];
    readonly steps: BootstrapStepSummary[];
}

/**
 * Structured diagnostic report returned by this tool
 */
interface DiagnosticReport {
    readonly instanceId: string;
    readonly found: boolean;
    readonly summary?: RunSummary;
    readonly failureCode?: string;
    readonly failedSteps?: string[];
    readonly error?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Sleep for a given number of milliseconds.
 *
 * @param ms - Duration to sleep
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a shell command on a node via SSM SendCommand.
 *
 * @param instanceId - EC2 instance ID to target
 * @param command - Shell command to run
 * @returns stdout output or undefined on failure
 */
async function ssmExec(
    instanceId: string,
    command: string,
): Promise<string | undefined> {
    const sendResult = await ssm.send(
        new SendCommandCommand({
            InstanceIds: [instanceId],
            DocumentName: 'AWS-RunShellScript',
            Parameters: { commands: [command] },
            TimeoutSeconds: 20,
        }),
    );

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) return undefined;

    const maxAttempts = Math.ceil(SSM_POLL_TIMEOUT_MS / SSM_POLL_INTERVAL_MS);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(SSM_POLL_INTERVAL_MS);

        try {
            const invocation = await ssm.send(
                new GetCommandInvocationCommand({
                    CommandId: commandId,
                    InstanceId: instanceId,
                }),
            );

            if (invocation.Status === 'Success') {
                return invocation.StandardOutputContent?.trim() ?? undefined;
            }

            if (invocation.Status === 'Failed' || invocation.Status === 'Cancelled') {
                const stderr = invocation.StandardErrorContent?.trim() ?? 'unknown error';
                log('ERROR', 'SSM command failed', {
                    commandId,
                    status: invocation.Status,
                    stderr,
                });
                return undefined;
            }
        } catch {
            // InvocationDoesNotExist — command still pending, continue polling
        }
    }

    log('ERROR', 'SSM command timed out', {
        commandId,
        timeoutMs: SSM_POLL_TIMEOUT_MS,
    });
    return undefined;
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Lambda handler — fetch and parse run_summary.json from a node via SSM.
 *
 * @param event - MCP tool invocation event with `instanceId`
 * @returns Structured diagnostic report
 */
export async function handler(event: DiagnosticInput): Promise<DiagnosticReport> {
    const { instanceId } = event;

    if (!instanceId) {
        return {
            instanceId: 'unknown',
            found: false,
            error: 'Missing required input: instanceId',
        };
    }

    log('INFO', 'Fetching node diagnostic summary', { instanceId });

    try {
        // Fetch the run_summary.json file content
        const rawOutput = await ssmExec(
            instanceId,
            `cat ${RUN_SUMMARY_PATH} 2>/dev/null || echo "NOT_FOUND"`,
        );

        if (!rawOutput || rawOutput === 'NOT_FOUND') {
            log('INFO', 'run_summary.json not found on node', { instanceId });

            return {
                instanceId,
                found: false,
                error: `${RUN_SUMMARY_PATH} does not exist on instance ${instanceId}. The bootstrap may not have started, or the node was recently launched.`,
            };
        }

        // Parse the JSON content
        const summary = JSON.parse(rawOutput) as RunSummary;

        log('INFO', 'Diagnostic summary retrieved', {
            instanceId,
            overallStatus: summary.overall_status,
            failureCode: summary.failure_code,
            totalSteps: summary.total_steps,
            failedSteps: summary.failed_steps,
        });

        return {
            instanceId,
            found: true,
            summary,
            failureCode: summary.failure_code ?? undefined,
            failedSteps: summary.failed_steps,
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log('ERROR', 'Failed to fetch diagnostic summary', { instanceId, error });

        return {
            instanceId,
            found: false,
            error: `Failed to retrieve diagnostic summary: ${error}`,
        };
    }
}
