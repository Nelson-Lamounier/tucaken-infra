/**
 * @format
 * Naming Utilities — Single Source of Truth
 *
 * Centralised resource and stack naming conventions.
 * All CDK factories and deployment scripts derive names from here.
 *
 * Stack name pattern: {Namespace}-{Component}-{environment}
 *   e.g. NextJS-Compute-development, ControlPlane-production
 */

import { EnvironmentName, shortEnv } from '../config/environments';
import { Project, getProjectConfig } from '../config/projects';

// =============================================================================
// STACK REGISTRY — Every stack's identity, defined once
// =============================================================================

/**
 * Maps each project's stack keys to their component names.
 * This is the authoritative list of all stacks in the codebase.
 *
 * The component name is combined with the project namespace and environment
 * to produce the full CloudFormation stack name / CDK construct ID.
 *
 * @example
 * STACK_REGISTRY.nextjs.k8sCompute  // → 'K8s-Compute'
 * // Full stack name: NextJS-K8s-Compute-development
 */
export const STACK_REGISTRY = {
    shared: {
        infra: 'Infra',
    },
    kubernetes: {
        data: 'Data',
        base: 'Base',
        controlPlane: 'ControlPlane',
        generalPool: 'GeneralPool',
        monitoringPool: 'MonitoringPool',
        appIam: 'AppIam',
        api: 'Api',
        edge: 'Edge',
        tucakenEdge: 'TucakenEdge',
        observability: 'Observability',
        platformRds: 'PlatformRds',
        oidc: 'Oidc',
        // EKS V1 stacks (parallel deployment alongside kubeadm)
        eksCluster: 'EksCluster',
        eksSystemNg: 'EksSystemNg',
        eksPodIdentity: 'EksPodIdentity',
        eksAddons: 'EksAddons',
        eksKarpenter: 'EksKarpenter',
        eksAccess: 'EksAccess',
    },
    org: {
        dnsRole: 'DnsRole',
    },
} as const;

/** Type-safe project keys */
export type RegistryProject = keyof typeof STACK_REGISTRY;

/** Type-safe stack keys for a given project */
export type RegistryStackKey<P extends RegistryProject> = keyof (typeof STACK_REGISTRY)[P];

// =============================================================================
// STACK NAMING FUNCTIONS
// =============================================================================

/**
 * Generate a CDK construct ID / CloudFormation stack name.
 *
 * Pattern: {Namespace}-{Component}-{environment}
 * If namespace is empty: {Component}-{environment}
 *
 * @param namespace - Project namespace (e.g. 'NextJS', '' for Kubernetes)
 * @param component - Stack component name (e.g. 'ControlPlane', 'GeneralPool')
 * @param environment - Target environment (e.g. 'development')
 * @returns Full stack name (e.g. 'NextJS-Compute-development' or 'ControlPlane-development')
 *
 * @example
 * stackId('Monitoring', 'Storage', 'development')
 * // Returns: 'Monitoring-Storage-development'
 *
 * stackId('', 'ControlPlane', 'production')
 * // Returns: 'ControlPlane-production'
 */
export function stackId(
    namespace: string,
    component: string,
    environment: EnvironmentName
): string {
    return namespace
        ? `${namespace}-${component}-${environment}`
        : `${component}-${environment}`;
}

/**
 * Mapping from Project enum to STACK_REGISTRY key.
 * Required because Project enum values ('shared', 'monitoring', …)
 * already match the registry keys exactly.
 */
const PROJECT_TO_REGISTRY: Record<Project, RegistryProject> = {
    [Project.SHARED]: 'shared',
    [Project.KUBERNETES]: 'kubernetes',
    [Project.ORG]: 'org',
};

/**
 * Resolve a full stack name from project enum, stack key, and environment.
 *
 * Combines the project namespace from `projects.ts` with the component
 * name from `STACK_REGISTRY` to produce the CloudFormation stack name.
 *
 * @param project - Project enum value
 * @param stackKey - Key into the project's registry entry (e.g. 'compute', 'k8sCompute')
 * @param environment - Target environment
 * @returns Full stack name
 * @throws Error if project or stackKey is invalid
 *
 * @example
 * getStackId(Project.KUBERNETES, 'controlPlane', 'development')
 * // Returns: 'ControlPlane-development'
 */
export function getStackId(
    project: Project,
    stackKey: string,
    environment: EnvironmentName
): string {
    const registryKey = PROJECT_TO_REGISTRY[project];
    if (!registryKey) {
        throw new Error(`Unknown project: ${project}`);
    }

    const projectRegistry = STACK_REGISTRY[registryKey];
    const component = (projectRegistry as Record<string, string>)[stackKey];
    if (!component) {
        const validKeys = Object.keys(projectRegistry).join(', ');
        throw new Error(
            `Unknown stack key '${stackKey}' for project '${project}'. ` +
            `Valid keys: ${validKeys}`
        );
    }

    const namespace = getProjectConfig(project).namespace;
    return stackId(namespace, component, environment);
}

// =============================================================================
// FLAT RESOURCE NAMING
// =============================================================================



/**
 * Generate a flat, semantic resource name using short environment abbreviations.
 *
 * Format: {project}-{component}-{env}  (when component is non-empty)
 *         {project}-{env}              (when component is empty)
 *
 * All parts are lowercased. Designed for AWS Console readability and
 * CLI/Steampipe queryability (kebab-case, never truncated).
 *
 * @param project - Project identifier (e.g. 'k8s', 'bedrock', 'org')
 * @param component - Resource component (e.g. 'ctrl', 'worker', 'api'). Empty string omits it.
 * @param environment - Full environment name (e.g. 'development') — abbreviated automatically
 * @returns Flat name (e.g. 'k8s-ctrl-dev', 'bedrock-api-prd')
 *
 * @example
 * flatName('k8s', 'ctrl', 'development')   // → 'k8s-ctrl-dev'
 * flatName('k8s', '', 'development')        // → 'k8s-dev'
 * flatName('bedrock', 'api', 'production')  // → 'bedrock-api-prd'
 */
export function flatName(
    project: string,
    component: string,
    environment: EnvironmentName,
): string {
    const env = shortEnv(environment);
    const parts = [project.toLowerCase()];
    if (component) {
        parts.push(component.toLowerCase());
    }
    parts.push(env);
    return parts.join('-');
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Describe a CIDR block in human-readable format
 */
export function describeCidr(cidr: string): string {
    if (cidr.endsWith('/32')) {
        return `IP ${cidr.replace('/32', '')}`;
    }
    if (cidr.endsWith('/0')) {
        return 'All IPs (0.0.0.0/0)';
    }
    return `CIDR ${cidr}`;
}

