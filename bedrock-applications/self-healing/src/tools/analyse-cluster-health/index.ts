/**
 * @format
 * Analyse Cluster Health — MCP Tool Lambda (K8sGPT Integration)
 *
 * Runs K8sGPT on the control plane node via SSM SendCommand to diagnose
 * workload-level issues (failing pods, misconfigured services, etc.).
 *
 * K8sGPT runs in `--no-explain` mode — the Bedrock self-healing agent
 * interprets the structured diagnostics. No double-LLM cost.
 *
 * Falls back to `kubectl` if K8sGPT is not installed on the node.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - namespace (string, optional): Filter analysis to a specific namespace
 *   - filters (string[], optional): K8sGPT analyser filters (e.g. ["Pod", "Service"])
 *
 * Output:
 *   - controlPlaneInstanceId: EC2 instance used for the check
 *   - healthy: boolean — true if zero issues found
 *   - totalIssues, criticalIssues: Counts
 *   - issues[]: Per-issue diagnostics (name, kind, namespace, errors)
 *   - analysisMethod: 'k8sgpt' or 'kubectl-fallback'
 */

import {
    EC2Client,
    DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
    SSMClient,
    SendCommandCommand,
    GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';

import { log } from '../../../../shared/src/index.js';

const ec2 = new EC2Client({});
const ssm = new SSMClient({});

/** Maximum time to wait for SSM command completion (milliseconds) */
const SSM_POLL_TIMEOUT_MS = 45_000;

/** Poll interval for SSM command status (milliseconds) */
const SSM_POLL_INTERVAL_MS = 3_000;

// =============================================================================
// Types
// =============================================================================

/**
 * MCP tool input schema
 */
interface AnalyseClusterHealthInput {
    readonly namespace?: string;
    readonly filters?: string[];
}

/**
 * Individual issue diagnosed by K8sGPT or kubectl fallback
 */
interface ClusterIssue {
    readonly name: string;
    readonly kind: string;
    readonly namespace: string;
    readonly error: string[];
    readonly parentObject?: string;
}

/**
 * Structured health report returned by this tool
 */
interface ClusterHealthReport {
    readonly controlPlaneInstanceId: string;
    readonly healthy: boolean;
    readonly totalIssues: number;
    readonly criticalIssues: number;
    readonly issues: ClusterIssue[];
    readonly analysisMethod: 'k8sgpt' | 'kubectl-fallback';
    readonly error?: string;
}

// =============================================================================
// K8sGPT JSON Output Types
// =============================================================================

interface K8sGPTResult {
    readonly kind: string;
    readonly name: string;
    readonly error: { readonly text?: string }[];
    readonly details?: string;
    readonly parentObject?: string;
}

interface K8sGPTOutput {
    readonly provider?: string;
    readonly errors?: number;
    readonly status?: string;
    readonly problems?: number;
    readonly results?: K8sGPTResult[];
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
 * Resolve the control plane EC2 instance ID by tag.
 *
 * @returns Instance ID string or undefined if not found
 */
async function resolveControlPlaneInstance(): Promise<string | undefined> {
    const result = await ec2.send(
        new DescribeInstancesCommand({
            Filters: [
                { Name: 'tag:k8s:bootstrap-role', Values: ['control-plane'] },
                { Name: 'instance-state-name', Values: ['running'] },
            ],
        }),
    );

    const instances = result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
    if (instances.length === 0) return undefined;
    return instances[0].InstanceId;
}

/**
 * Execute a shell command on the control plane node via SSM SendCommand.
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
            TimeoutSeconds: 45,
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

/**
 * Build the K8sGPT analyse command with optional filters.
 *
 * @param namespace - Optional namespace filter
 * @param filters - Optional K8sGPT analyser filters
 * @returns Shell command string
 */
function buildK8sGPTCommand(namespace?: string, filters?: string[]): string {
    const parts = [
        'export HOME=/root',
        '&&',
        'export KUBECONFIG=/etc/kubernetes/admin.conf',
        '&&',
        'k8sgpt analyse --output json --no-explain',
    ];

    if (namespace) {
        parts.push(`--namespace ${namespace}`);
    }

    if (filters && filters.length > 0) {
        parts.push(`--filter ${filters.join(',')}`);
    }

    return parts.join(' ');
}

/**
 * Build the kubectl fallback command for basic unhealthy pod detection.
 *
 * @param namespace - Optional namespace filter
 * @returns Shell command string
 */
function buildKubectlFallbackCommand(namespace?: string): string {
    const nsFlag = namespace ? `-n ${namespace}` : '-A';

    // Return JSON with pod name, namespace, phase, and container statuses
    return [
        'export KUBECONFIG=/etc/kubernetes/admin.conf',
        '&&',
        `kubectl get pods ${nsFlag} -o json`,
        '|',
        // Filter to unhealthy pods using Python (available on AL2023)
        `python3 -c 'import json,sys;`,
        `d=json.loads(sys.stdin.read());`,
        `items=d.get("items",[]);`,
        `bad=[{"name":p["metadata"]["name"],`,
        `"namespace":p["metadata"]["namespace"],`,
        `"phase":p.get("status",{}).get("phase","Unknown"),`,
        `"containers":[{"name":c.get("name","?"),`,
        `"state":list(c.get("state",{}).keys())}`,
        `for c in p.get("status",{}).get("containerStatuses",[])`,
        `if "running" not in c.get("state",{})]}`,
        `for p in items`,
        `if p.get("status",{}).get("phase") not in ("Running","Succeeded")];`,
        `print(json.dumps({"unhealthy":bad,"total":len(items),"unhealthyCount":len(bad)}))'`,
    ].join(' ');
}

/**
 * Parse K8sGPT JSON output into structured issues.
 *
 * @param raw - Raw K8sGPT JSON string
 * @returns Array of cluster issues
 */
function parseK8sGPTOutput(raw: string): ClusterIssue[] {
    const data = JSON.parse(raw) as K8sGPTOutput;
    const results = data.results ?? [];

    return results.map((r) => {
        // Extract namespace from name (format: "namespace/name" or just "name")
        const nameParts = r.name.split('/');
        const namespace = nameParts.length > 1 ? nameParts[0] : 'default';
        const name = nameParts.length > 1 ? nameParts[1] : nameParts[0];

        return {
            name,
            kind: r.kind,
            namespace,
            error: r.error.map((e) => e.text ?? 'unknown error'),
            parentObject: r.parentObject,
        };
    });
}

/**
 * Parse kubectl fallback output into structured issues.
 *
 * @param raw - Raw kubectl fallback JSON string
 * @returns Array of cluster issues
 */
function parseKubectlFallback(raw: string): ClusterIssue[] {
    const data = JSON.parse(raw) as {
        unhealthy: Array<{
            name: string;
            namespace: string;
            phase: string;
            containers: Array<{ name: string; state: string[] }>;
        }>;
    };

    return data.unhealthy.map((pod) => ({
        name: pod.name,
        kind: 'Pod',
        namespace: pod.namespace,
        error: [
            `Phase: ${pod.phase}`,
            ...pod.containers.map(
                (c) => `Container ${c.name}: ${c.state.join(', ') || 'unknown state'}`,
            ),
        ],
    }));
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Lambda handler — analyse Kubernetes cluster health via K8sGPT or kubectl fallback.
 *
 * @param event - MCP tool invocation event
 * @returns Structured cluster health report
 */
export async function handler(event: AnalyseClusterHealthInput): Promise<ClusterHealthReport> {
    const { namespace, filters } = event;

    log('INFO', 'Analysing cluster health', {
        namespace: namespace ?? 'all',
        filters: filters ?? 'default',
    });

    // Step 1: Resolve control plane instance
    let controlPlaneId: string;
    try {
        const instanceId = await resolveControlPlaneInstance();
        if (!instanceId) {
            return {
                controlPlaneInstanceId: 'unknown',
                healthy: false,
                totalIssues: 0,
                criticalIssues: 0,
                issues: [],
                analysisMethod: 'k8sgpt',
                error: 'No running control-plane instance found (tag k8s:bootstrap-role=control-plane)',
            };
        }
        controlPlaneId = instanceId;
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            controlPlaneInstanceId: 'unknown',
            healthy: false,
            totalIssues: 0,
            criticalIssues: 0,
            issues: [],
            analysisMethod: 'k8sgpt',
            error: `Failed to resolve control plane instance: ${error}`,
        };
    }

    log('INFO', 'Control plane instance resolved', { instanceId: controlPlaneId });

    // Step 2: Try K8sGPT first, fall back to kubectl
    let analysisMethod: 'k8sgpt' | 'kubectl-fallback' = 'k8sgpt';
    let issues: ClusterIssue[] = [];

    // Check if K8sGPT is installed
    const checkInstalled = await ssmExec(
        controlPlaneId,
        'which k8sgpt 2>/dev/null && echo "INSTALLED" || echo "NOT_INSTALLED"',
    );

    const k8sgptAvailable = checkInstalled?.includes('INSTALLED') ?? false;

    if (k8sgptAvailable) {
        log('INFO', 'K8sGPT is installed, running analysis');

        const k8sgptCmd = buildK8sGPTCommand(namespace, filters);
        const rawOutput = await ssmExec(controlPlaneId, k8sgptCmd);

        if (rawOutput) {
            try {
                issues = parseK8sGPTOutput(rawOutput);
            } catch {
                log('WARN', 'Failed to parse K8sGPT output, falling back to kubectl', {
                    rawSnippet: rawOutput.slice(0, 200),
                });
                analysisMethod = 'kubectl-fallback';
            }
        } else {
            log('WARN', 'K8sGPT returned no output, falling back to kubectl');
            analysisMethod = 'kubectl-fallback';
        }
    } else {
        log('INFO', 'K8sGPT not installed, using kubectl fallback');
        analysisMethod = 'kubectl-fallback';
    }

    // kubectl fallback
    if (analysisMethod === 'kubectl-fallback') {
        const kubectlCmd = buildKubectlFallbackCommand(namespace);
        const rawOutput = await ssmExec(controlPlaneId, kubectlCmd);

        if (rawOutput) {
            try {
                issues = parseKubectlFallback(rawOutput);
            } catch {
                return {
                    controlPlaneInstanceId: controlPlaneId,
                    healthy: false,
                    totalIssues: 0,
                    criticalIssues: 0,
                    issues: [],
                    analysisMethod,
                    error: `Failed to parse kubectl fallback output: ${rawOutput.slice(0, 200)}`,
                };
            }
        } else {
            return {
                controlPlaneInstanceId: controlPlaneId,
                healthy: false,
                totalIssues: 0,
                criticalIssues: 0,
                issues: [],
                analysisMethod,
                error: 'kubectl command returned no output (SSM may have failed or timed out)',
            };
        }
    }

    // Step 3: Build report
    const criticalKinds = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet'];
    const criticalIssues = issues.filter((i) => criticalKinds.includes(i.kind)).length;

    const report: ClusterHealthReport = {
        controlPlaneInstanceId: controlPlaneId,
        healthy: issues.length === 0,
        totalIssues: issues.length,
        criticalIssues,
        issues,
        analysisMethod,
    };

    log('INFO', 'Cluster health analysis complete', {
        healthy: report.healthy,
        totalIssues: report.totalIssues,
        criticalIssues: report.criticalIssues,
        analysisMethod: report.analysisMethod,
        issueNames: issues.map((i) => `${i.kind}/${i.namespace}/${i.name}`),
    });

    return report;
}
