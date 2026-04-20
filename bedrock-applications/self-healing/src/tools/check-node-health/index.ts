/**
 * @format
 * Check Node Health — MCP Tool Lambda
 *
 * Runs `kubectl get nodes -o json` on the control plane node via SSM
 * SendCommand and returns a structured node health report.
 *
 * This enables the self-healing agent to verify that worker nodes
 * have joined the cluster and are in Ready state after ASG replacement.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - nodeNameFilter (string, optional): Substring filter for node names
 *
 * Output:
 *   - controlPlaneInstanceId: EC2 instance used for the check
 *   - totalNodes, readyNodes, notReadyNodes: Counts
 *   - nodes[]: Per-node details (name, status, roles, version, conditions)
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
const SSM_POLL_TIMEOUT_MS = 30_000;

/** Poll interval for SSM command status (milliseconds) */
const SSM_POLL_INTERVAL_MS = 3_000;

// =============================================================================
// Types
// =============================================================================

/**
 * MCP tool input schema
 */
interface CheckNodeHealthInput {
    readonly nodeNameFilter?: string;
}

/**
 * Per-node condition from the Kubernetes API
 */
interface NodeConditionReport {
    readonly type: string;
    readonly status: string;
    readonly reason?: string;
    readonly message?: string;
    readonly lastTransitionTime?: string;
}

/**
 * Per-node health summary
 */
interface NodeReport {
    readonly name: string;
    readonly status: 'Ready' | 'NotReady' | 'Unknown';
    readonly roles: string[];
    readonly kubeletVersion: string;
    readonly internalIp?: string;
    readonly creationTimestamp: string;
    readonly conditions: NodeConditionReport[];
}

/**
 * Structured health report returned by this tool
 */
interface NodeHealthReport {
    readonly controlPlaneInstanceId: string;
    readonly totalNodes: number;
    readonly readyNodes: number;
    readonly notReadyNodes: number;
    readonly nodes: NodeReport[];
    readonly error?: string;
}

// =============================================================================
// Kubernetes API Types (subset of kubectl get nodes -o json)
// =============================================================================

interface K8sNodeCondition {
    readonly type?: string;
    readonly status?: string;
    readonly reason?: string;
    readonly message?: string;
    readonly lastTransitionTime?: string;
}

interface K8sNodeAddress {
    readonly type?: string;
    readonly address?: string;
}

interface K8sNode {
    readonly metadata?: {
        readonly name?: string;
        readonly labels?: Record<string, string>;
        readonly creationTimestamp?: string;
    };
    readonly status?: {
        readonly conditions?: K8sNodeCondition[];
        readonly addresses?: K8sNodeAddress[];
        readonly nodeInfo?: {
            readonly kubeletVersion?: string;
        };
    };
}

interface K8sNodeList {
    readonly items?: K8sNode[];
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
 * Uses the `k8s:bootstrap-role=control-plane` tag, matching the
 * pattern established by `verify-argocd-sync.ts`.
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
            TimeoutSeconds: 30,
        }),
    );

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) return undefined;

    // Poll for completion
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
 * Extract node roles from Kubernetes labels.
 *
 * @param labels - Node labels map
 * @returns Array of role strings
 */
function extractRoles(labels: Record<string, string>): string[] {
    const roles: string[] = [];

    for (const [key] of Object.entries(labels)) {
        if (key.startsWith('node-role.kubernetes.io/')) {
            roles.push(key.replace('node-role.kubernetes.io/', ''));
        }
    }

    return roles.length > 0 ? roles : ['worker'];
}

/**
 * Determine node readiness from its conditions array.
 *
 * @param conditions - Kubernetes node conditions
 * @returns 'Ready', 'NotReady', or 'Unknown'
 */
function getNodeStatus(conditions: K8sNodeCondition[]): 'Ready' | 'NotReady' | 'Unknown' {
    const readyCondition = conditions.find((c) => c.type === 'Ready');

    if (!readyCondition) return 'Unknown';
    if (readyCondition.status === 'True') return 'Ready';
    return 'NotReady';
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Lambda handler — check Kubernetes node health via SSM.
 *
 * @param event - MCP tool invocation event with optional `nodeNameFilter`
 * @returns Structured node health report
 */
export async function handler(event: CheckNodeHealthInput): Promise<NodeHealthReport> {
    const { nodeNameFilter } = event;

    log('INFO', 'Checking node health', {
        nodeNameFilter: nodeNameFilter ?? 'all',
    });

    // Step 1: Resolve control plane instance
    let controlPlaneId: string;
    try {
        const instanceId = await resolveControlPlaneInstance();
        if (!instanceId) {
            return {
                controlPlaneInstanceId: 'unknown',
                totalNodes: 0,
                readyNodes: 0,
                notReadyNodes: 0,
                nodes: [],
                error: 'No running control-plane instance found (tag k8s:bootstrap-role=control-plane)',
            };
        }
        controlPlaneId = instanceId;
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            controlPlaneInstanceId: 'unknown',
            totalNodes: 0,
            readyNodes: 0,
            notReadyNodes: 0,
            nodes: [],
            error: `Failed to resolve control plane instance: ${error}`,
        };
    }

    log('INFO', 'Control plane instance resolved', { instanceId: controlPlaneId });

    // Step 2: Run kubectl get nodes via SSM
    const kubectlCommand = 'export KUBECONFIG=/etc/kubernetes/admin.conf && kubectl get nodes -o json';

    let rawOutput: string | undefined;
    try {
        rawOutput = await ssmExec(controlPlaneId, kubectlCommand);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            controlPlaneInstanceId: controlPlaneId,
            totalNodes: 0,
            readyNodes: 0,
            notReadyNodes: 0,
            nodes: [],
            error: `SSM command execution failed: ${error}`,
        };
    }

    if (!rawOutput) {
        return {
            controlPlaneInstanceId: controlPlaneId,
            totalNodes: 0,
            readyNodes: 0,
            notReadyNodes: 0,
            nodes: [],
            error: 'kubectl get nodes returned no output (SSM command may have failed or timed out)',
        };
    }

    // Step 3: Parse the JSON output
    let nodeList: K8sNodeList;
    try {
        nodeList = JSON.parse(rawOutput) as K8sNodeList;
    } catch {
        return {
            controlPlaneInstanceId: controlPlaneId,
            totalNodes: 0,
            readyNodes: 0,
            notReadyNodes: 0,
            nodes: [],
            error: `Failed to parse kubectl output as JSON: ${rawOutput.slice(0, 200)}`,
        };
    }

    const items = nodeList.items ?? [];

    // Step 4: Build structured report
    let nodes: NodeReport[] = items.map((node) => {
        const conditions = node.status?.conditions ?? [];
        const addresses = node.status?.addresses ?? [];
        const internalIp = addresses.find((a) => a.type === 'InternalIP')?.address;

        return {
            name: node.metadata?.name ?? 'unknown',
            status: getNodeStatus(conditions),
            roles: extractRoles(node.metadata?.labels ?? {}),
            kubeletVersion: node.status?.nodeInfo?.kubeletVersion ?? 'unknown',
            internalIp,
            creationTimestamp: node.metadata?.creationTimestamp ?? 'unknown',
            conditions: conditions.map((c) => ({
                type: c.type ?? 'unknown',
                status: c.status ?? 'unknown',
                reason: c.reason,
                message: c.message,
                lastTransitionTime: c.lastTransitionTime,
            })),
        };
    });

    // Apply optional name filter
    if (nodeNameFilter) {
        nodes = nodes.filter((n) => n.name.includes(nodeNameFilter));
    }

    const readyNodes = nodes.filter((n) => n.status === 'Ready').length;
    const notReadyNodes = nodes.length - readyNodes;

    const report: NodeHealthReport = {
        controlPlaneInstanceId: controlPlaneId,
        totalNodes: nodes.length,
        readyNodes,
        notReadyNodes,
        nodes,
    };

    log('INFO', 'Node health check complete', {
        totalNodes: report.totalNodes,
        readyNodes: report.readyNodes,
        notReadyNodes: report.notReadyNodes,
        nodeNames: nodes.map((n) => n.name),
    });

    return report;
}
