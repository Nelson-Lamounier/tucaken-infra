/**
 * @format
 * Kubernetes Base Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesBaseStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that all resources exist, are correctly
 * configured, and the environment is ready for downstream stacks
 * (GoldenAMI, Compute, AppIam, Api, Edge).
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by the base stack
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development
 */

import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { LogGroup } from '@aws-sdk/client-cloudwatch-logs';
import {
    EC2Client,
    DescribeVpcsCommand,
    DescribeSecurityGroupsCommand,
    DescribeAddressesCommand,
    DescribeFlowLogsCommand,
} from '@aws-sdk/client-ec2';
import type { IpPermission } from '@aws-sdk/client-ec2';
import type { FlowLog } from '@aws-sdk/client-ec2';
import {
    KMSClient,
    DescribeKeyCommand,
    GetKeyRotationStatusCommand,
} from '@aws-sdk/client-kms';
import type { KeyMetadata } from '@aws-sdk/client-kms';
import {
    Route53Client,
    GetHostedZoneCommand,
    ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import type { HostedZone, ResourceRecordSet } from '@aws-sdk/client-route-53';
import {
    S3Client,
    HeadBucketCommand,
    GetBucketEncryptionCommand,
} from '@aws-sdk/client-s3';
import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';

import type { DeployableEnvironment } from '../../../lib/config';
import { Environment } from '../../../lib/config';
// import { getK8sConfigs } from '../../../lib/config/kubernetes';
import { k8sSsmPaths, k8sSsmPrefix } from '../../../lib/config/ssm-paths';
import type { K8sSsmPaths } from '../../../lib/config/ssm-paths';

// =============================================================================
// Rule 4: Environment Variable Parsing — No Silent `as` Casts
// =============================================================================

/**
 * Parse and validate CDK_ENV environment variable.
 * Throws with a descriptive error for invalid values.
 */
function parseEnvironment(raw: string): DeployableEnvironment {
    const valid = [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION] as const satisfies readonly DeployableEnvironment[];
    if (!valid.includes(raw as DeployableEnvironment)) {
        throw new Error(`Invalid CDK_ENV: "${raw}". Expected one of: ${valid.join(', ')}`);
    }
    return raw as DeployableEnvironment;
}

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = parseEnvironment(process.env.CDK_ENV ?? 'development');
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
// const CONFIGS = getK8sConfigs(CDK_ENV);
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);

// =============================================================================
// Rule 3: Magic Values — Named Constants Only
// =============================================================================

// Networking
const VPC_CIDR_PREFIX = '10.';
const POD_CIDR_PREFIX = '192.168.';
const ANY_IPV4 = '0.0.0.0/0';

// Retention / lifecycle
const FLOW_LOG_RETENTION_DAYS = 3;
const API_RECORD_TTL = 30;
const K8S_INTERNAL_ZONE = 'k8s.internal.';
const K8S_API_FQDN = 'k8s-api.k8s.internal';
const K8S_API_FQDN_DOT = `${K8S_API_FQDN}.`;

// AWS SDK clients (shared across tests)
const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const kms = new KMSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const route53 = new Route53Client({ region: REGION });
const cwl = new CloudWatchLogsClient({ region: REGION });

// =============================================================================
// Rule 2: Non-Null Assertions — Use a `requireParam` Helper
// =============================================================================

/**
 * Retrieve a required SSM parameter from the cached map.
 * Throws a descriptive error if the parameter is missing or empty.
 *
 * @param params - The SSM parameter Map<path, value>
 * @param path - The full SSM path to look up
 * @returns The parameter value (guaranteed non-empty)
 * @throws Error if the parameter is missing or empty
 */
function requireParam(params: Map<string, string>, path: string): string {
    const value = params.get(path);
    if (!value) throw new Error(`Missing required SSM parameter: ${path}`);
    return value;
}

// =============================================================================
// SSM Parameter Cache (loaded once at module level — Rule 1)
// =============================================================================

/**
 * Load all SSM parameters under the k8s prefix in one paginated call.
 * Returns a Map<path, value> for fast lookup.
 */
async function loadSsmParameters(): Promise<Map<string, string>> {
    const params = new Map<string, string>();
    let nextToken: string | undefined;

    do {
        const response = await ssm.send(
            new GetParametersByPathCommand({
                Path: PREFIX,
                Recursive: true,
                WithDecryption: true,
                NextToken: nextToken,
            }),
        );

        for (const param of response.Parameters ?? []) {
            if (param.Name && param.Value) {
                params.set(param.Name, param.Value);
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);

    return params;
}

// =============================================================================
// Helper: SG Rule Assertion Utilities (module-level — Rule 10)
// =============================================================================

/**
 * Find a TCP ingress rule matching a specific port (or port range).
 *
 * @param ingress - The IpPermissions array from DescribeSecurityGroups
 * @param fromPort - The start port to match
 * @param toPort - The end port to match (defaults to fromPort for single-port rules)
 */
function findTcpIngressRule(
    ingress: IpPermission[],
    fromPort: number,
    toPort?: number,
): IpPermission | undefined {
    return ingress.find(
        (r) => r.FromPort === fromPort
            && r.ToPort === (toPort ?? fromPort)
            && r.IpProtocol === 'tcp',
    );
}

/**
 * Find a UDP ingress rule matching a specific port.
 */
function findUdpIngressRule(
    ingress: IpPermission[],
    fromPort: number,
    toPort?: number,
): IpPermission | undefined {
    return ingress.find(
        (r) => r.FromPort === fromPort
            && r.ToPort === (toPort ?? fromPort)
            && r.IpProtocol === 'udp',
    );
}

/**
 * Assert that a rule has a self-referencing source (same SG ID).
 * Throws with actual source details on failure.
 */
function expectSelfReferencing(rule: IpPermission, sgId: string): void {
    const selfRef = rule.UserIdGroupPairs?.find((p) => p.GroupId === sgId);
    if (!selfRef) {
        const actualSources = [
            ...(rule.UserIdGroupPairs ?? []).map((p) => `SG:${p.GroupId}`),
            ...(rule.IpRanges ?? []).map((r) => `CIDR:${r.CidrIp}`),
            ...(rule.PrefixListIds ?? []).map((p) => `PrefixList:${p.PrefixListId}`),
        ];
        throw new Error(
            `Expected self-referencing source (SG ${sgId}) on port ${rule.FromPort}.\n` +
            `Actual sources: ${actualSources.length > 0 ? actualSources.join(', ') : '(none)'}`,
        );
    }
}

/**
 * Assert that a rule has an IPv4 CIDR source containing the given prefix.
 * Throws with actual CIDR and source details on failure.
 */
function expectCidrSource(rule: IpPermission, cidrPrefix: string): void {
    const match = rule.IpRanges?.find((r) => r.CidrIp?.startsWith(cidrPrefix));
    if (!match) {
        const actualCidrs = (rule.IpRanges ?? []).map((r) => r.CidrIp).join(', ');
        const otherSources = [
            ...(rule.UserIdGroupPairs ?? []).map((p) => `SG:${p.GroupId}`),
            ...(rule.PrefixListIds ?? []).map((p) => `PrefixList:${p.PrefixListId}`),
        ];
        throw new Error(
            `Expected CIDR source starting with '${cidrPrefix}' on port ${rule.FromPort}.\n` +
            `Actual CIDRs: ${actualCidrs || '(none)'}\n` +
            `Other sources: ${otherSources.length > 0 ? otherSources.join(', ') : '(none)'}`,
        );
    }
}

/**
 * Assert that a rule has a prefix list source.
 * Throws with actual source details on failure.
 */
function expectPrefixListSource(rule: IpPermission): void {
    if (!rule.PrefixListIds?.length) {
        const actualSources = [
            ...(rule.UserIdGroupPairs ?? []).map((p) => `SG:${p.GroupId}`),
            ...(rule.IpRanges ?? []).map((r) => `CIDR:${r.CidrIp}`),
        ];
        throw new Error(
            `Expected at least one prefix list source on port ${rule.FromPort}.\n` +
            `Actual sources: ${actualSources.length > 0 ? actualSources.join(', ') : '(none)'}`,
        );
    }
}

/**
 * Find an unrestricted egress rule (all protocols, 0.0.0.0/0).
 *
 * Extracted to module level so the predicate logic (&&) does not
 * appear inside it() blocks (jest/no-conditional-in-test).
 */
function findAllTrafficEgress(egress: IpPermission[]): IpPermission | undefined {
    return egress.find(
        (r) => r.IpProtocol === '-1'
            && r.IpRanges?.some((ip) => ip.CidrIp === ANY_IPV4),
    );
}

// =============================================================================
// Diagnostic Formatters (human-readable rule output on failure)
// =============================================================================

/**
 * Format a single IpPermission rule into a human-readable string.
 * Used in diagnostic output when assertions fail.
 */
function formatIpPermission(rule: IpPermission): string {
    const port = rule.FromPort === rule.ToPort
        ? `${rule.FromPort}`
        : `${rule.FromPort}-${rule.ToPort}`;
    const sources = [
        ...(rule.UserIdGroupPairs ?? []).map((p) => `SG:${p.GroupId}`),
        ...(rule.IpRanges ?? []).map((r) => `CIDR:${r.CidrIp}`),
        ...(rule.Ipv6Ranges ?? []).map((r) => `CIDRv6:${r.CidrIpv6}`),
        ...(rule.PrefixListIds ?? []).map((p) => `PrefixList:${p.PrefixListId}`),
    ];
    return `  \u2022 Port ${port} (${rule.IpProtocol}) \u2014 Sources: ${sources.join(', ') || '(none)'}`;
}

/**
 * Format all IpPermission rules, optionally filtered by protocol.
 * Returns a multi-line diagnostic string for assertion failure messages.
 */
function formatIpPermissions(rules: IpPermission[], protocol?: string): string {
    const filtered = protocol
        ? rules.filter((r) => r.IpProtocol === protocol)
        : rules;
    if (filtered.length === 0) {
        return `  (no ${protocol ?? ''} rules found)`;
    }
    return filtered.map(formatIpPermission).join('\n');
}

// =============================================================================
// Require Helpers — Find + Assert with Diagnostic Context
//
// These replace the bare `find*() + expect().toBeDefined()` pattern.
// On failure they throw with the full list of actual rules, so engineers
// can immediately see what IS present without visiting the AWS console.
// =============================================================================

/**
 * Find a TCP ingress rule or throw with full diagnostic context.
 * Returns the narrowed IpPermission (no `!` needed by callers).
 *
 * @param rules - The IpPermissions array from DescribeSecurityGroups
 * @param fromPort - The start port to match
 * @param toPort - The end port to match (defaults to fromPort)
 * @returns The matched IpPermission rule
 * @throws Error with formatted list of actual TCP rules if not found
 */
function requireTcpIngressRule(
    rules: IpPermission[],
    fromPort: number,
    toPort?: number,
): IpPermission {
    const rule = findTcpIngressRule(rules, fromPort, toPort);
    if (!rule) {
        const portDesc = toPort && toPort !== fromPort ? `${fromPort}-${toPort}` : `${fromPort}`;
        throw new Error(
            `Expected TCP ingress rule for port ${portDesc}, but none found.\n` +
            `Actual TCP ingress rules (${rules.filter((r) => r.IpProtocol === 'tcp').length}):\n` +
            formatIpPermissions(rules, 'tcp'),
        );
    }
    return rule;
}

/**
 * Find a UDP ingress rule or throw with full diagnostic context.
 *
 * @param rules - The IpPermissions array
 * @param fromPort - The start port to match
 * @param toPort - The end port to match (defaults to fromPort)
 * @returns The matched IpPermission rule
 * @throws Error with formatted list of actual UDP rules if not found
 */
function requireUdpIngressRule(
    rules: IpPermission[],
    fromPort: number,
    toPort?: number,
): IpPermission {
    const rule = findUdpIngressRule(rules, fromPort, toPort);
    if (!rule) {
        const portDesc = toPort && toPort !== fromPort ? `${fromPort}-${toPort}` : `${fromPort}`;
        throw new Error(
            `Expected UDP ingress rule for port ${portDesc}, but none found.\n` +
            `Actual UDP ingress rules (${rules.filter((r) => r.IpProtocol === 'udp').length}):\n` +
            formatIpPermissions(rules, 'udp'),
        );
    }
    return rule;
}

/**
 * Find an all-traffic egress rule or throw with full diagnostic context.
 *
 * @param rules - The IpPermissionsEgress array
 * @returns The matched IpPermission rule
 * @throws Error with formatted list of actual egress rules if not found
 */
function requireAllTrafficEgress(rules: IpPermission[]): IpPermission {
    const rule = findAllTrafficEgress(rules);
    if (!rule) {
        throw new Error(
            `Expected unrestricted egress rule (all protocols, ${ANY_IPV4}), but none found.\n` +
            `Actual egress rules (${rules.length}):\n` +
            formatIpPermissions(rules),
        );
    }
    return rule;
}

// =============================================================================
// Module-Level Cached State (Rule 1 + Rule 10)
//
// All shared API responses are fetched once in beforeAll and reused.
// =============================================================================

let ssmParams: Map<string, string>;

// VPC Flow Logs
let flowLogs: FlowLog[];
let cwlFlowLog: FlowLog | undefined;
let flowLogGroup: LogGroup | undefined;

// =============================================================================
// Top-Level beforeAll — Fetch All Module-Level Resources Once (Rule 1)
// =============================================================================

beforeAll(async () => {
    // --- SSM Parameters (gate for everything else) ---
    ssmParams = await loadSsmParameters();

    // --- VPC Flow Logs ---
    const vpcId = requireParam(ssmParams, SSM_PATHS.vpcId);
    const { FlowLogs } = await ec2.send(
        new DescribeFlowLogsCommand({
            Filter: [{ Name: 'resource-id', Values: [vpcId] }],
        }),
    );
    flowLogs = FlowLogs ?? [];

    cwlFlowLog = flowLogs.find(
        (f) => f.LogDestinationType === 'cloud-watch-logs',
    );

    // Flow log group retention (only if CloudWatch flow log exists)
    if (cwlFlowLog?.LogGroupName) {
        const { logGroups } = await cwl.send(
            new DescribeLogGroupsCommand({
                logGroupNamePrefix: cwlFlowLog.LogGroupName,
            }),
        );
        flowLogGroup = logGroups?.find(
            (g) => g.logGroupName === cwlFlowLog!.LogGroupName,
        );
    }
});

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesBaseStack — Post-Deploy Verification', () => {
    // =========================================================================
    // SSM Parameters (11)
    // =========================================================================
    describe('SSM Parameters', () => {
        // Rule 5: Use `satisfies` instead of `as const`
        const expectedPaths = [
            'vpcId',
            'elasticIp',
            'elasticIpAllocationId',
            'securityGroupId',
            'controlPlaneSgId',
            'ingressSgId',
            'monitoringSgId',
            'scriptsBucket',
            'hostedZoneId',
            'apiDnsName',
            'kmsKeyArn',
        ] satisfies Array<keyof K8sSsmPaths>;

        it('should have all 11 SSM parameters published', () => {
            expect(ssmParams.size).toBeGreaterThanOrEqual(expectedPaths.length);
        });

        it.each(expectedPaths)(
            'should have a non-empty value for %s',
            (key) => {
                const path = SSM_PATHS[key];
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.length).toBeGreaterThan(0);
            },
        );

        it('should store the K8s API FQDN as the API DNS name', () => {
            expect(requireParam(ssmParams, SSM_PATHS.apiDnsName)).toBe(
                K8S_API_FQDN,
            );
        });
    });

    // =========================================================================
    // VPC
    // =========================================================================
    describe('VPC', () => {
        it('should exist and be in available state', async () => {
            const vpcId = requireParam(ssmParams, SSM_PATHS.vpcId);

            const { Vpcs } = await ec2.send(
                new DescribeVpcsCommand({ VpcIds: [vpcId] }),
            );

            expect(Vpcs).toHaveLength(1);
            const vpc = Vpcs![0];
            expect(vpc.State).toBe('available');
        });
    });

    // =========================================================================
    // VPC Flow Logs
    // Depends on: flowLogs, cwlFlowLog, flowLogGroup populated in top-level beforeAll
    // =========================================================================
    describe('VPC Flow Logs', () => {
        it('should have flow logs enabled for the VPC', () => {
            expect(flowLogs.length).toBeGreaterThan(0);
        });

        it('should deliver flow logs to CloudWatch Logs', () => {
            expect(cwlFlowLog).toBeDefined();
            expect(cwlFlowLog!.FlowLogStatus).toBe('ACTIVE');
        });

        it('should have correct retention on CloudWatch log group', () => {
            expect(flowLogGroup).toBeDefined();
            expect(flowLogGroup!.retentionInDays).toBe(FLOW_LOG_RETENTION_DAYS);
        });
    });

    // =========================================================================
    // Security Groups — Existence & VPC Attachment (×4)
    // =========================================================================
    describe('Security Groups — Existence', () => {
        // Rule 5: Use `satisfies` for typed literals
        const sgKeys = [
            { key: 'securityGroupId', label: 'Cluster Base' },
            { key: 'controlPlaneSgId', label: 'Control Plane' },
            { key: 'ingressSgId', label: 'Ingress' },
            { key: 'monitoringSgId', label: 'Monitoring' },
        ] satisfies Array<{ key: keyof K8sSsmPaths; label: string }>;

        it.each(sgKeys)(
            'should exist and be attached to the VPC ($label SG)',
            async ({ key }) => {
                const sgId = requireParam(ssmParams, SSM_PATHS[key]);
                const vpcId = requireParam(ssmParams, SSM_PATHS.vpcId);

                const { SecurityGroups } = await ec2.send(
                    new DescribeSecurityGroupsCommand({
                        GroupIds: [sgId],
                    }),
                );

                expect(SecurityGroups).toHaveLength(1);
                const sg = SecurityGroups![0];
                expect(sg.VpcId).toBe(vpcId);
            },
        );
    });

    // =========================================================================
    // Security Group — Cluster Base (18 inbound rules)
    //
    // Self-referencing: etcd, API, kubelet, controller-manager, scheduler,
    //   VXLAN, BGP, NodePort, CoreDNS (TCP+UDP), Typha, metrics (×2)
    // Pod CIDR: API, kubelet, CoreDNS (TCP+UDP), metrics (×2)
    // =========================================================================
    describe('Cluster Base SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];
        let sgId: string;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            sgId = requireParam(ssmParams, SSM_PATHS.securityGroupId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        // --- Self-referencing TCP rules ---
        it.each([
            { port: 2379, endPort: 2380, desc: 'etcd client+peer' },
            { port: 10250, desc: 'kubelet API' },
            { port: 10257, desc: 'kube-controller-manager' },
            { port: 10259, desc: 'kube-scheduler' },
            { port: 179, desc: 'Calico BGP' },
            { port: 30000, endPort: 32767, desc: 'NodePort range' },
            { port: 53, desc: 'CoreDNS TCP' },
            { port: 5473, desc: 'Calico Typha' },
            { port: 9100, desc: 'Traefik metrics' },
            { port: 9101, desc: 'Node Exporter metrics' },
        ])(
            'should have self-referencing TCP rule for $desc (port $port)',
            ({ port, endPort }) => {
                const rule = requireTcpIngressRule(ingress, port, endPort);
                expectSelfReferencing(rule, sgId);
            },
        );

        // --- Self-referencing UDP rules ---
        it('should have self-referencing UDP rule for VXLAN (port 4789)', () => {
            const rule = requireUdpIngressRule(ingress, 4789);
            expectSelfReferencing(rule, sgId);
        });

        it('should have self-referencing UDP rule for CoreDNS (port 53)', () => {
            const rule = requireUdpIngressRule(ingress, 53);
            expectSelfReferencing(rule, sgId);
        });

        // --- VPC CIDR TCP rules ---
        // Port 6443 uses vpcCidr (not self) so that ALL SGs in the VPC
        // (monitoring, ingress, control plane workers) can reach the API server.
        it('should have VPC CIDR TCP rule for K8s API server (port 6443)', () => {
            const rule = requireTcpIngressRule(ingress, 6443);
            expectCidrSource(rule, VPC_CIDR_PREFIX);
        });

        // --- Pod CIDR TCP rules ---
        it.each([
            { port: 6443, desc: 'K8s API server' },
            { port: 10250, desc: 'kubelet API' },
            { port: 53, desc: 'CoreDNS TCP' },
            { port: 9100, desc: 'Traefik metrics' },
            { port: 9101, desc: 'Node Exporter metrics' },
        ])(
            'should have pod CIDR TCP rule for $desc (port $port)',
            ({ port }) => {
                const rule = requireTcpIngressRule(ingress, port);
                expectCidrSource(rule, POD_CIDR_PREFIX);
            },
        );

        // --- Pod CIDR UDP rules ---
        it('should have pod CIDR UDP rule for CoreDNS (port 53)', () => {
            const rule = requireUdpIngressRule(ingress, 53);
            expectCidrSource(rule, POD_CIDR_PREFIX);
        });

        it('should allow all outbound traffic', () => {
            requireAllTrafficEgress(egress);
        });
    });

    // =========================================================================
    // Security Group — Control Plane (port 6443 from VPC CIDR)
    // =========================================================================
    describe('Control Plane SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.controlPlaneSgId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it('should have K8s API port 6443 open from VPC CIDR', () => {
            const apiRule = requireTcpIngressRule(ingress, 6443);
            expectCidrSource(apiRule, VPC_CIDR_PREFIX);
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            expect(findAllTrafficEgress(egress)).toBeUndefined();
        });
    });

    // =========================================================================
    // Security Group — Ingress (CloudFront, admin IPs, health checks)
    //
    // Config-driven: port 80 from VPC CIDR (NLB health checks)
    // Runtime-added: port 80 from CloudFront prefix list
    // Runtime-added: port 443 from admin IPs (if resolved at synth)
    // =========================================================================
    describe('Ingress SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.ingressSgId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it('should have HTTP port 80 from VPC CIDR (NLB health checks)', () => {
            const httpRule = requireTcpIngressRule(ingress, 80);
            expectCidrSource(httpRule, VPC_CIDR_PREFIX);
        });

        it('should have HTTP port 80 from CloudFront prefix list', () => {
            const httpRule = requireTcpIngressRule(ingress, 80);
            expectPrefixListSource(httpRule);
        });

        it('should have HTTPS port 443 for admin access', () => {
            requireTcpIngressRule(ingress, 443);
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            expect(findAllTrafficEgress(egress)).toBeUndefined();
        });
    });

    // =========================================================================
    // Security Group — Monitoring (Prometheus, Node Exporter, Loki, Tempo)
    // =========================================================================
    describe('Monitoring SG — Rule Validation', () => {
        let ingress: IpPermission[];
        let egress: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.monitoringSgId);

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );
            expect(SecurityGroups).toHaveLength(1);
            ingress = SecurityGroups![0].IpPermissions ?? [];
            egress = SecurityGroups![0].IpPermissionsEgress ?? [];
        });

        it.each([
            { port: 9090, desc: 'Prometheus metrics' },
            { port: 9100, desc: 'Node Exporter metrics (VPC)' },
            { port: 30100, desc: 'Loki push API' },
            { port: 30417, desc: 'Tempo OTLP gRPC' },
        ])(
            'should have TCP rule for $desc (port $port) from VPC CIDR',
            ({ port }) => {
                const rule = requireTcpIngressRule(ingress, port);
                expectCidrSource(rule, VPC_CIDR_PREFIX);
            },
        );

        it('should have Node Exporter port 9100 from pod CIDR (Prometheus scraping)', () => {
            const rule = requireTcpIngressRule(ingress, 9100);
            expectCidrSource(rule, POD_CIDR_PREFIX);
        });

        it('should NOT allow all outbound traffic (restricted)', () => {
            expect(findAllTrafficEgress(egress)).toBeUndefined();
        });
    });

    // =========================================================================
    // Elastic IP
    // =========================================================================
    describe('Elastic IP', () => {
        let eipAddress: {
            Domain?: string;
            PublicIp?: string;
        };

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const allocationId = requireParam(ssmParams, SSM_PATHS.elasticIpAllocationId);

            const { Addresses } = await ec2.send(
                new DescribeAddressesCommand({
                    AllocationIds: [allocationId],
                }),
            );
            expect(Addresses).toHaveLength(1);
            eipAddress = Addresses![0];
        });

        it('should exist as a VPC allocation', () => {
            expect(eipAddress.Domain).toBe('vpc');
        });

        it('should have a public IP matching the SSM parameter', () => {
            const expectedIp = requireParam(ssmParams, SSM_PATHS.elasticIp);
            expect(eipAddress.PublicIp).toBe(expectedIp);
        });
    });

    // =========================================================================
    // KMS Key
    // =========================================================================
    describe('KMS Key', () => {
        let keyMetadata: KeyMetadata;
        let keyRotationEnabled: boolean;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const keyArn = requireParam(ssmParams, SSM_PATHS.kmsKeyArn);

            const [descResp, rotResp] = await Promise.all([
                kms.send(new DescribeKeyCommand({ KeyId: keyArn })),
                kms.send(new GetKeyRotationStatusCommand({ KeyId: keyArn })),
            ]);

            expect(descResp.KeyMetadata).toBeDefined();
            keyMetadata = descResp.KeyMetadata!;
            keyRotationEnabled = rotResp.KeyRotationEnabled ?? false;
        });

        it('should be enabled', () => {
            expect(keyMetadata.Enabled).toBe(true);
            expect(keyMetadata.KeyState).toBe('Enabled');
        });

        it('should have key rotation enabled', () => {
            expect(keyRotationEnabled).toBe(true);
        });
    });

    // =========================================================================
    // S3 Buckets — Scripts
    // =========================================================================
    describe('S3 Scripts Bucket', () => {
        let bucketName: string;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(() => {
            bucketName = requireParam(ssmParams, SSM_PATHS.scriptsBucket);
        });

        it('should exist and be accessible', async () => {
            await expect(
                s3.send(new HeadBucketCommand({ Bucket: bucketName })),
            ).resolves.toBeDefined();
        });

        it('should have server-side encryption enabled', async () => {
            const { ServerSideEncryptionConfiguration } = await s3.send(
                new GetBucketEncryptionCommand({ Bucket: bucketName }),
            );

            expect(ServerSideEncryptionConfiguration?.Rules).toBeDefined();
            expect(ServerSideEncryptionConfiguration!.Rules!.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // Route 53 Private Hosted Zone
    // =========================================================================
    describe('Route 53', () => {
        let hostedZone: HostedZone;
        let aRecord: ResourceRecordSet | undefined;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const hostedZoneId = requireParam(ssmParams, SSM_PATHS.hostedZoneId);

            const [zoneResp, recordResp] = await Promise.all([
                route53.send(new GetHostedZoneCommand({ Id: hostedZoneId })),
                route53.send(new ListResourceRecordSetsCommand({
                    HostedZoneId: hostedZoneId,
                    StartRecordName: K8S_API_FQDN,
                    StartRecordType: 'A',
                    MaxItems: 1,
                })),
            ]);

            expect(zoneResp.HostedZone).toBeDefined();
            hostedZone = zoneResp.HostedZone!;

            aRecord = recordResp.ResourceRecordSets?.find(
                (r) => r.Name === K8S_API_FQDN_DOT && r.Type === 'A',
            );
        });

        it('should have a private hosted zone for k8s.internal', () => {
            expect(hostedZone.Name).toBe(K8S_INTERNAL_ZONE);
            expect(hostedZone.Config?.PrivateZone).toBe(true);
        });

        it('should have an A record for k8s-api.k8s.internal', () => {
            expect(aRecord).toBeDefined();
            expect(aRecord!.TTL).toBe(API_RECORD_TTL);
        });
    });
});
