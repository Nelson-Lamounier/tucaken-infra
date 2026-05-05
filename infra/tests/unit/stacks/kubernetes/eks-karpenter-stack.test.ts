/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';

import { Template } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config/environments';
import { EksKarpenterStack } from '../../../../lib/stacks/kubernetes/eks-karpenter-stack';

describe('EksKarpenterStack', () => {
    it('should create SQS interruption queue and 4 EventBridge rules', () => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_30,
            kubectlLayer: new KubectlV30Layer(clusterStack, 'KubectlLayer'),
            defaultCapacity: 0,
        });
        const nodeRole = new iam.Role(clusterStack, 'NodeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });
        const stack = new EksKarpenterStack(app, 'Karp', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            workerNodeRole: nodeRole,
            workerSecurityGroupId: 'sg-aaa',
            subnetTagKey: 'kubernetes.io/cluster/k8s-eks-development',
            karpenter: {
                instanceCategory: ['t'],
                instanceFamily: ['t3'],
                capacityType: ['on-demand'],
                architectures: ['amd64'],
                cpuMin: 2,
                cpuMax: 8,
            },
        });
        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::SQS::Queue', 1);
        t.resourceCountIs('AWS::Events::Rule', 4);
    });
});
