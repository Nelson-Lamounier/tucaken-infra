/**
 * @format
 * Remediate Node Bootstrap — MCP Tool Lambda
 *
 * Triggers the Step Functions bootstrap orchestrator to re-run the bootstrap
 * sequence on a failed Kubernetes node. Uses the `BootstrapOrchestratorConstruct`
 * state machine deployed by `K8sSsmAutomationStack`.
 *
 * The tool starts a new Step Functions execution with an EventBridge-style
 * payload that the router Lambda already understands — no new logic required
 * in the orchestrator. This is the self-healing equivalent of the GitHub
 * Actions `_deploy-ssm-automation.yml` manual trigger.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - instanceId (string, required): EC2 instance to remediate
 *   - role (string, required): Node role — 'control-plane' or 'worker'
 *
 * Output:
 *   - instanceId: Target instance
 *   - executionArn: Step Functions execution ARN (for tracking)
 *   - status: 'triggered' or 'error'
 */

import {
    SFNClient,
    StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import {
    SSMClient,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

import { log } from '../../../../shared/src/index.js';

const sfnClient = new SFNClient({});
const ssmClient = new SSMClient({});

/** SSM Parameter Store prefix for K8s configuration */
const SSM_PREFIX = process.env.SSM_PREFIX ?? '/k8s/development';

/**
 * Step Functions bootstrap orchestrator state machine ARN.
 * Injected by the Gateway stack from the SSM parameter
 * `{ssmPrefix}/bootstrap/state-machine-arn`.
 */
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

// =============================================================================
// Types
// =============================================================================

/**
 * Valid node roles for bootstrap remediation
 */
type NodeRole = 'control-plane' | 'worker';

/**
 * MCP tool input schema
 */
interface RemediateInput {
    readonly instanceId: string;
    readonly role: string;
}

/**
 * Structured remediation report returned by this tool
 */
interface RemediationReport {
    readonly instanceId: string;
    readonly role: string;
    /** Step Functions execution ARN (for tracking in the console) */
    readonly executionArn?: string;
    readonly status: 'triggered' | 'error';
    readonly error?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Validate the node role input.
 *
 * @param role - Raw role string from the tool input
 * @returns Validated NodeRole
 * @throws Error if the role is invalid
 */
function validateRole(role: string): NodeRole {
    const valid: NodeRole[] = ['control-plane', 'worker'];
    if (!valid.includes(role as NodeRole)) {
        throw new Error(
            `Invalid role: "${role}". Expected one of: ${valid.join(', ')}`,
        );
    }
    return role as NodeRole;
}

/**
 * Resolve an SSM parameter value.
 *
 * @param name - Full parameter path
 * @returns Parameter value string
 * @throws Error if the parameter is not found
 */
async function resolveParameter(name: string): Promise<string> {
    const result = await ssmClient.send(
        new GetParameterCommand({
            Name: name,
            WithDecryption: false,
        }),
    );

    const value = result.Parameter?.Value;
    if (!value) {
        throw new Error(`SSM parameter not found: ${name}`);
    }
    return value;
}



// =============================================================================
// Handler
// =============================================================================

/**
 * Lambda handler — trigger the Step Functions bootstrap orchestrator to
 * re-bootstrap a failed Kubernetes node.
 *
 * Starts a new execution with an EventBridge-style payload that the router
 * Lambda processes identically to an ASG launch event. The `instanceId`
 * and `role` are injected so the orchestrator targets the correct node
 * without relying on ASG tag resolution.
 *
 * @param event - MCP tool invocation event with `instanceId` and `role`
 * @returns Structured remediation report with execution ARN
 */
export async function handler(event: RemediateInput): Promise<RemediationReport> {
    const { instanceId, role: rawRole } = event;

    if (!instanceId) {
        return {
            instanceId: 'unknown',
            role: rawRole ?? 'unknown',
            status: 'error',
            error: 'Missing required input: instanceId',
        };
    }

    if (!rawRole) {
        return {
            instanceId,
            role: 'unknown',
            status: 'error',
            error: 'Missing required input: role (control-plane or worker)',
        };
    }

    log('INFO', 'Initiating node bootstrap remediation', { instanceId, role: rawRole });

    try {
        // Validate role
        const role = validateRole(rawRole);

        // Resolve the state machine ARN — prefer env var injected by CDK,
        // fall back to SSM parameter for local testing.
        let stateMachineArn = STATE_MACHINE_ARN;
        if (!stateMachineArn) {
            const arnParamPath = `${SSM_PREFIX}/bootstrap/state-machine-arn`;
            stateMachineArn = await resolveParameter(arnParamPath);
        }

        // Derive the ASG name from the SSM prefix + role so the router
        // can resolve ASG tags and identify which pool to bootstrap.
        // Convention: {env}-{role}-asg (matches the ASG configured in compute stack).
        const envSuffix = SSM_PREFIX.replace('/k8s/', ''); // e.g. 'development'
        const asgName = `${envSuffix}-${role}-asg`;

        // Build an EventBridge-style payload matching the exact shape the
        // router Lambda uses for ASG instance launch events.
        const executionInput = JSON.stringify({
            source: 'self-healing.remediation',
            'detail-type': 'EC2 Instance Launch Successful',
            detail: {
                AutoScalingGroupName: asgName,
                EC2InstanceId: instanceId,
            },
        });

        log('INFO', 'Starting Step Functions bootstrap execution', {
            stateMachineArn,
            instanceId,
            role,
            asgName,
        });

        // Start a new Step Functions execution — the router Lambda resolves
        // the role from ASG tags and runs the appropriate bootstrap sequence.
        const executionResult = await sfnClient.send(
            new StartExecutionCommand({
                stateMachineArn,
                input: executionInput,
                // Unique name prevents duplicate executions if retried within 90 days
                name: `remediation-${instanceId}-${Date.now()}`,
            }),
        );

        const executionArn = executionResult.executionArn;

        log('INFO', 'Step Functions execution started', {
            executionArn,
            instanceId,
            role,
        });

        return {
            instanceId,
            role,
            executionArn,
            status: 'triggered',
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log('ERROR', 'Step Functions bootstrap remediation failed', {
            instanceId,
            role: rawRole,
            error,
        });

        return {
            instanceId,
            role: rawRole,
            status: 'error',
            error: `Failed to trigger Step Functions execution: ${error}`,
        };
    }
}
