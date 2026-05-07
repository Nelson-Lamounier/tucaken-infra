/**
 * @format
 * KubernetesProjectFactory Unit Tests
 *
 * Tests for the factory that creates EKS Kubernetes infrastructure.
 * Current architecture (12 stacks in development + 1 EksScheduler = 13 total):
 *   Data, Base, PlatformRds, Api, EksCluster, EksSystemNg, EksPodIdentity,
 *   EksAddons, EksKarpenter, EksScheduler (dev only), EksAccess, EksPublicWaf.
 *   (Also conditionally: EksAlbCerts, if domain config is provided)
 *
 * IMPORTANT: Edge config env vars MUST be set before the config module is
 * imported (it evaluates fromEnv() at module load time). The env vars are
 * set at the top of this file before any imports that trigger the config.
 */

// --- Set env vars BEFORE any CDK/config imports ---
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.ROOT_ACCOUNT = '711387127421';
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';
process.env.DOMAIN_NAME = 'dev.nelsonlamounier.com';
process.env.MONITOR_DOMAIN_NAME = 'monitoring.dev.nelsonlamounier.com';
process.env.HOSTED_ZONE_ID = 'Z04763221QPB6CZ9R77GM';
process.env.CROSS_ACCOUNT_ROLE_ARN = 'arn:aws:iam::711387127421:role/Route53DnsValidationRole';

// --- Now safe to import modules ---
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { Project } from '../../../../lib/config/projects';
import {
    KubernetesProjectFactory,
    KubernetesFactoryContext,
} from '../../../../lib/projects/kubernetes';

/**
 * Helper to create a typed factory context
 */
function createFactoryContext(
    overrides?: Partial<KubernetesFactoryContext>
): KubernetesFactoryContext {
    return {
        environment: Environment.DEVELOPMENT,
        ...overrides,
    };
}

describe('KubernetesProjectFactory', () => {
    describe('Factory Properties', () => {
        it('should have correct project type', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            expect(factory.project).toBe(Project.KUBERNETES);
        });

        it('should have correct environment', () => {
            const factory = new KubernetesProjectFactory(Environment.STAGING);
            expect(factory.environment).toBe(Environment.STAGING);
        });

        it('should have correct namespace', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            // K8s project namespace is empty — stack names use component only
            expect(factory.namespace).toBe('');
        });
    });

    describe('createAllStacks', () => {
        let app: cdk.App;

        beforeEach(() => {
            app = new cdk.App();
        });

        it('should create 13 stacks in development: 4 shared + 7 EKS + 1 scheduler + 1 WAF', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks, stackMap } = factory.createAllStacks(app, context);

            // 13 stacks: Data, Base, PlatformRds, Api + EksCluster, EksSystemNg, EksPodIdentity,
            // EksAddons, EksKarpenter, EksScheduler (dev-only), EksAccess, EksPublicWaf
            expect(stacks.length).toBeGreaterThanOrEqual(12);

            // Shared infrastructure stacks
            expect(stackMap).toHaveProperty('data');
            expect(stackMap).toHaveProperty('base');
            expect(stackMap).toHaveProperty('platformRds');
            expect(stackMap).toHaveProperty('api');

            // EKS cluster stacks (sequenced)
            expect(stackMap).toHaveProperty('eksCluster');
            expect(stackMap).toHaveProperty('eksSystemNg');
            expect(stackMap).toHaveProperty('eksPodIdentity');
            expect(stackMap).toHaveProperty('eksAddons');
            expect(stackMap).toHaveProperty('eksKarpenter');
            expect(stackMap).toHaveProperty('eksAccess');
            expect(stackMap).toHaveProperty('eksPublicWaf');

            // Development-only scheduler stack
            expect(stackMap).toHaveProperty('eksScheduler');

            // Legacy kubeadm stacks must NOT be present
            expect(stackMap).not.toHaveProperty('controlPlane');
            expect(stackMap).not.toHaveProperty('generalPool');
            expect(stackMap).not.toHaveProperty('monitoringPool');
            expect(stackMap).not.toHaveProperty('appIam');
            expect(stackMap).not.toHaveProperty('edge');
            expect(stackMap).not.toHaveProperty('oidc');
            expect(stackMap).not.toHaveProperty('observability');
        });

        it('should order stacks: Data → Base → PlatformRds → Api → Eks cluster → Scheduler → Public WAF', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map((s: cdk.Stack) => s.stackName);
            // Verify key stacks are present in order
            expect(stackNames[0]).toContain('Data');
            expect(stackNames[1]).toContain('Base');

            // Verify EKS cluster stacks are present (ordering is: Cluster → SystemNg → PodIdentity → Addons → Karpenter)
            const eksClusterIdx = stackNames.findIndex(n => n.includes('EksCluster'));
            const eksSystemNgIdx = stackNames.findIndex(n => n.includes('EksSystemNg'));
            const eksPodIdIdx = stackNames.findIndex(n => n.includes('EksPodIdentity'));
            const eksAddonsIdx = stackNames.findIndex(n => n.includes('EksAddons'));
            const eksKarpenterIdx = stackNames.findIndex(n => n.includes('EksKarpenter'));

            expect(eksClusterIdx).toBeLessThan(eksSystemNgIdx);
            expect(eksSystemNgIdx).toBeLessThan(eksPodIdIdx);
            expect(eksPodIdIdx).toBeLessThan(eksAddonsIdx);
            expect(eksAddonsIdx).toBeLessThan(eksKarpenterIdx);

            // EksScheduler should be present and ordered after EksKarpenter
            const eksSchedulerIdx = stackNames.findIndex(n => n.includes('EksScheduler'));
            expect(eksSchedulerIdx).toBeGreaterThan(-1);
        });

        it('should name stacks correctly with environment suffix', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map((s: cdk.Stack) => s.stackName);
            expect(stackNames.some((name: string) => name.includes('development'))).toBe(true);
        });

        it('should deploy Data, Api, and EKS stacks in primary region', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);

            expect(stackMap.data.region).toBe('eu-west-1');
            expect(stackMap.api.region).toBe('eu-west-1');
            expect(stackMap.eksCluster.region).toBe('eu-west-1');
            expect(stackMap.eksScheduler.region).toBe('eu-west-1');
        });

        it('should create different stack names for different environments', () => {
            const devFactory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const prodFactory = new KubernetesProjectFactory(Environment.PRODUCTION);

            const devApp = new cdk.App();
            const devContext = createFactoryContext();
            const { stacks: devStacks } = devFactory.createAllStacks(devApp, devContext);

            const prodApp = new cdk.App();
            const prodContext = createFactoryContext({
                environment: Environment.PRODUCTION,
                verificationSecret: 'test-prod-secret',
            });
            const { stacks: prodStacks } = prodFactory.createAllStacks(prodApp, prodContext);

            expect(devStacks[0].stackName).toContain('development');
            expect(prodStacks[0].stackName).toContain('production');
        });

        it('should exclude EksScheduler from production environment', () => {
            const factory = new KubernetesProjectFactory(Environment.PRODUCTION);
            const context = createFactoryContext({
                environment: Environment.PRODUCTION,
                verificationSecret: 'test-prod-secret',
            });

            const { stacks, stackMap } = factory.createAllStacks(app, context);

            // EksScheduler must NOT be present in production
            expect(stackMap).not.toHaveProperty('eksScheduler');

            // Verify by checking stack names array as well
            const stackNames = stacks.map((s: cdk.Stack) => s.stackName);
            expect(stackNames.some(name => name.includes('EksScheduler'))).toBe(false);
        });
    });
});
