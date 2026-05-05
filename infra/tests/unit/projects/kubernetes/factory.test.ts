/**
 * @format
 * KubernetesProjectFactory Unit Tests
 *
 * Tests for the factory that creates shared kubeadm Kubernetes infrastructure.
 * Current architecture (11 stacks, cattle-model ASG pools):
 *   Data, Base, ControlPlane,
 *   GeneralPool (ASG), MonitoringPool (ASG), AppIam, PlatformRds, Api, Edge, Oidc, Observability.
 *
 * The legacy named worker stacks (Worker, MonitoringWorker) have been fully
 * decommissioned and replaced by the Kubernetes-native ASG pool model.
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

        it('should create 11 stacks: Data, Base, ControlPlane, GeneralPool, MonitoringPool, AppIam, PlatformRds, Api, Edge, Oidc, Observability', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks, stackMap } = factory.createAllStacks(app, context);

            // 11 stacks: ssm-automation migrated to kubernetes-bootstrap repo; ASG pools replaced legacy workers; OIDC added for IRSA.
            expect(stacks).toHaveLength(11);

            // Core infrastructure stacks
            expect(stackMap).toHaveProperty('data');
            expect(stackMap).toHaveProperty('base');
            expect(stackMap).toHaveProperty('controlPlane');
            expect(stackMap).toHaveProperty('appIam');
            expect(stackMap).toHaveProperty('platformRds');
            expect(stackMap).toHaveProperty('api');
            expect(stackMap).toHaveProperty('edge');
            expect(stackMap).toHaveProperty('oidc');
            expect(stackMap).toHaveProperty('observability');

            // Cattle-model ASG pools (replaced legacy named worker stacks)
            expect(stackMap).toHaveProperty('generalPool');
            expect(stackMap).toHaveProperty('monitoringPool');

            // Legacy stacks must NOT be present
            expect(stackMap).not.toHaveProperty('worker');
            expect(stackMap).not.toHaveProperty('monitoringWorker');
        });

        it('should order stacks: Data → Base → ControlPlane → GeneralPool → MonitoringPool → AppIam → PlatformRds → Api → Edge → Oidc → Observability', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map((s: cdk.Stack) => s.stackName);
            expect(stackNames[0]).toContain('Data');
            expect(stackNames[1]).toContain('Base');
            expect(stackNames[2]).toContain('ControlPlane');
            // ASG pools follow control plane
            expect(stackNames[3]).toContain('GeneralPool');
            expect(stackNames[4]).toContain('MonitoringPool');
            expect(stackNames[5]).toContain('AppIam');
            expect(stackNames[6]).toContain('PlatformRds');
            expect(stackNames[7]).toContain('Api');
            expect(stackNames[8]).toContain('Edge');
            expect(stackNames[9]).toContain('Oidc');
            expect(stackNames[10]).toContain('Observability');
        });

        it('should name stacks correctly with environment suffix', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map((s: cdk.Stack) => s.stackName);
            expect(stackNames.some((name: string) => name.includes('development'))).toBe(true);
        });

        it('should deploy Edge stack in us-east-1', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);

            expect(stackMap.edge.region).toBe('us-east-1');
        });

        it('should deploy Data, ControlPlane, and API stacks in primary region', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);

            expect(stackMap.data.region).toBe('eu-west-1');
            expect(stackMap.controlPlane.region).toBe('eu-west-1');
            expect(stackMap.api.region).toBe('eu-west-1');
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
    });
});
