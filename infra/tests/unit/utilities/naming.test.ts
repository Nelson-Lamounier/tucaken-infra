/**
 * @format
 * Naming Utilities Unit Tests
 *
 * Verifies the centralised stack naming functions produce correct
 * CloudFormation stack names / CDK construct IDs.
 */

import { shortEnv } from '../../../lib/config/environments';
import { Project } from '../../../lib/config/projects';
import {
    stackId,
    getStackId,
    STACK_REGISTRY,
    flatName,
    describeCidr,
} from '../../../lib/utilities/naming';

describe('Naming Utilities', () => {
    // =========================================================================
    // stackId()
    // =========================================================================
    describe('stackId', () => {
        it('should generate {Namespace}-{Component}-{environment}', () => {
            expect(stackId('K8s', 'Storage', 'development')).toBe('K8s-Storage-development');
        });

        it('should handle multi-part namespace', () => {
            expect(stackId('Monitoring-K8s', 'Compute', 'production')).toBe('Monitoring-K8s-Compute-production');
        });

        it('should handle empty namespace', () => {
            expect(stackId('', 'ControlPlane', 'development')).toBe('ControlPlane-development');
        });
    });

    // =========================================================================
    // getStackId()
    // =========================================================================
    describe('getStackId', () => {
        it('should resolve K8s project stacks', () => {
            // K8s project namespace is empty — stack names use component only
            expect(getStackId(Project.KUBERNETES, 'controlPlane', 'development')).toBe('ControlPlane-development');
            expect(getStackId(Project.KUBERNETES, 'edge', 'production')).toBe('Edge-production');
        });

        it('should resolve Shared project stacks', () => {
            expect(getStackId(Project.SHARED, 'infra', 'development')).toBe('Shared-Infra-development');
        });

        it('should resolve Org project stacks (normalized, no Stack suffix)', () => {
            expect(getStackId(Project.ORG, 'dnsRole', 'production')).toBe('Org-DnsRole-production');
        });

        it('should throw on invalid stack key', () => {
            expect(() => getStackId(Project.KUBERNETES, 'nonexistent', 'development')).toThrow(
                /Unknown stack key 'nonexistent'/
            );
        });
    });

    // =========================================================================
    // STACK_REGISTRY completeness
    // =========================================================================
    describe('STACK_REGISTRY', () => {
        it('should contain all project entries', () => {
            expect(Object.keys(STACK_REGISTRY)).toStrictEqual(
                expect.arrayContaining(['shared', 'kubernetes', 'org'])
            );
        });

        it('should have expected k8s stack keys', () => {
            expect(Object.keys(STACK_REGISTRY.kubernetes)).toStrictEqual(['data', 'base', 'controlPlane', 'generalPool', 'monitoringPool', 'appIam', 'api', 'edge', 'tucakenEdge', 'observability', 'platformRds']);
        });
    });

    // =========================================================================
    // shortEnv()
    // =========================================================================
    describe('shortEnv', () => {
        it('should abbreviate development to dev', () => {
            expect(shortEnv('development')).toBe('dev');
        });

        it('should abbreviate staging to stg', () => {
            expect(shortEnv('staging')).toBe('stg');
        });

        it('should abbreviate production to prd', () => {
            expect(shortEnv('production')).toBe('prd');
        });
    });

    // =========================================================================
    // flatName()
    // =========================================================================
    describe('flatName', () => {
        it('should generate {project}-{component}-{shortEnv}', () => {
            expect(flatName('k8s', 'ctrl', 'development')).toBe('k8s-ctrl-dev');
        });

        it('should lowercase all parts', () => {
            expect(flatName('K8s', 'Ctrl', 'production')).toBe('k8s-ctrl-prd');
        });

        it('should handle empty component', () => {
            expect(flatName('kubernetes', '', 'staging')).toBe('kubernetes-stg');
        });

        it('should produce short names for all environments', () => {
            expect(flatName('k8s', 'worker', 'development')).toBe('k8s-worker-dev');
            expect(flatName('k8s', 'worker', 'staging')).toBe('k8s-worker-stg');
            expect(flatName('k8s', 'worker', 'production')).toBe('k8s-worker-prd');
        });
    });

    // =========================================================================
    // describeCidr()
    // =========================================================================
    describe('describeCidr', () => {
        it('should describe /32 as IP', () => {
            expect(describeCidr('10.0.0.1/32')).toBe('IP 10.0.0.1');
        });

        it('should describe /0 as All IPs', () => {
            expect(describeCidr('0.0.0.0/0')).toBe('All IPs (0.0.0.0/0)');
        });
    });
});
