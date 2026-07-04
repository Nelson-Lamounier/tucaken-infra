/**
 * @format
 * Shared test constants
 *
 * Centralized constants for CDK stack tests to ensure consistency
 * and reduce duplication across test files.
 */

/**
 * Standard AWS environment for testing
 * Uses a fake account ID that follows AWS account format
 */
export const TEST_ENV = {
    account: '123456789012',
    region: 'us-east-1',
} as const;

/**
 * EU region environment for testing (for stacks not requiring us-east-1)
 */
export const TEST_ENV_EU = {
    account: '123456789012',
    region: 'eu-west-1',
} as const;

/**
 * Create a test environment with custom region
 */
export function createTestEnv(region: string = 'us-east-1') {
    return {
        account: '123456789012',
        region,
    };
}

/**
 * Common CIDR blocks for security group testing
 * Note: Using mutable arrays for compatibility with stack props
 */
export const TEST_CIDRS = {
    /** Single host /32 CIDR */
    single: ['10.0.0.1/32'] as string[],
    /** Multiple CIDRs for testing multi-source rules */
    multiple: ['10.0.0.1/32', '192.168.1.0/24'] as string[],
    /** Network range CIDR */
    network: ['172.16.0.0/16'] as string[],
    /** Private RFC1918 ranges */
    private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] as string[],
};

/**
 * Default VPC configuration for testing
 */
export const DEFAULT_VPC_CONFIG = {
    maxAzs: 2,
    natGateways: 0,
} as const;

/**
 * Default monitoring ports
 */
export const MONITORING_PORTS = {
    grafana: 3000,
    prometheus: 9090,
    nodeExporter: 9100,
    ssh: 22,
} as const;

// =============================================================================
// VPC Context for Vpc.fromLookup()
//
// CDK's default dummy VPC uses AZs like 'dummy1a'/'dummy1b', which causes
// the NLB construct to fail (it expects 'eu-west-1a'). This context entry
// provides a realistic VPC with eu-west-1 AZs so the NLB subnet lookup works.
//
// Usage: app.node.setContext(TEST_VPC_CONTEXT_KEY, TEST_VPC_CONTEXT);
// =============================================================================

/**
 * CDK context key for the shared development VPC lookup.
 *
 * Must match the key CDK generates for `Vpc.fromLookup({ vpcName: 'shared-vpc-development' })`
 * in account 123456789012, region eu-west-1.
 */
export const TEST_VPC_CONTEXT_KEY =
    'vpc-provider:account=123456789012:filter.tag:Name=shared-vpc-development:region=eu-west-1:returnAsymmetricSubnets=true';

/**
 * Mock VPC context value with eu-west-1a/1b public and private subnets.
 *
 * Required by any test that instantiates a stack using `Vpc.fromLookup()`
 * combined with constructs that select subnets by AZ (e.g. NLB, EBS).
 */
export const TEST_VPC_CONTEXT = {
    vpcId: 'vpc-12345',
    vpcCidrBlock: '10.0.0.0/16',
    ownerAccountId: '123456789012',
    availabilityZones: ['eu-west-1a', 'eu-west-1b'],
    subnetGroups: [
        {
            name: 'Public',
            type: 'Public',
            subnets: [
                { subnetId: 'subnet-pub-1a', cidr: '10.0.1.0/24', availabilityZone: 'eu-west-1a', routeTableId: 'rtb-pub-1a' },
                { subnetId: 'subnet-pub-1b', cidr: '10.0.2.0/24', availabilityZone: 'eu-west-1b', routeTableId: 'rtb-pub-1b' },
            ],
        },
        {
            name: 'Private',
            type: 'Private',
            subnets: [
                { subnetId: 'subnet-priv-1a', cidr: '10.0.11.0/24', availabilityZone: 'eu-west-1a', routeTableId: 'rtb-priv-1a' },
                { subnetId: 'subnet-priv-1b', cidr: '10.0.12.0/24', availabilityZone: 'eu-west-1b', routeTableId: 'rtb-priv-1b' },
            ],
        },
        {
            name: 'Isolated',
            type: 'Isolated',
            subnets: [
                { subnetId: 'subnet-isolated-1a', cidr: '10.0.21.0/24', availabilityZone: 'eu-west-1a', routeTableId: 'rtb-isolated-1a' },
                { subnetId: 'subnet-isolated-1b', cidr: '10.0.22.0/24', availabilityZone: 'eu-west-1b', routeTableId: 'rtb-isolated-1b' },
            ],
        },
    ],
} as const;
