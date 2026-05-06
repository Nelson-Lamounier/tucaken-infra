/**
 * @format
 * Mock EKS cluster fixture for stack tests.
 *
 * Centralizes the boilerplate required to satisfy `eks.Cluster` props
 * (KubectlLayer + version + region) so per-stack tests focus only on
 * the assertions that matter to them.
 */

import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';

import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';

import { TEST_ENV_EU } from './constants';
import { createTestApp } from './test-app';

export interface MockEksClusterResult {
    readonly app: cdk.App;
    readonly clusterStack: cdk.Stack;
    readonly cluster: eks.Cluster;
}

export interface MockEksClusterOptions {
    readonly clusterName?: string;
    readonly stackId?: string;
    readonly app?: cdk.App;
}

/**
 * Provision a CDK App + helper Stack + minimal eks.Cluster usable as
 * a dependency for stack-under-test fixtures. Defaults match the dev
 * cluster (k8s-eks-development, eu-west-1, K8s 1.34).
 */
export function createMockEksCluster(opts: MockEksClusterOptions = {}): MockEksClusterResult {
    const app = opts.app ?? createTestApp();
    const clusterStack = new cdk.Stack(app, opts.stackId ?? 'ClusterStack', { env: TEST_ENV_EU });
    const cluster = new eks.Cluster(clusterStack, 'Cluster', {
        clusterName: opts.clusterName ?? 'k8s-eks-development',
        version: eks.KubernetesVersion.V1_34,
        kubectlLayer: new KubectlV34Layer(clusterStack, 'KubectlLayer'),
        defaultCapacity: 0,
    });
    return { app, clusterStack, cluster };
}
