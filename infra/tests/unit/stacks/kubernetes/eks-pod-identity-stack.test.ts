/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';

import { Template } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config/environments';
import { EksPodIdentityStack } from '../../../../lib/stacks/kubernetes/eks-pod-identity-stack';

describe('EksPodIdentityStack', () => {
    it('should create one PodIdentityAssociation per binding', () => {
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
        const stack = new EksPodIdentityStack(app, 'PodId', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            bindings: [
                { namespace: 'karpenter', serviceAccount: 'karpenter', purpose: 'karpenter' },
                {
                    namespace: 'kube-system',
                    serviceAccount: 'aws-load-balancer-controller',
                    purpose: 'alb-controller',
                },
                {
                    namespace: 'external-secrets',
                    serviceAccount: 'external-secrets',
                    purpose: 'external-secrets',
                },
            ],
            karpenterInterruptionQueueArn: 'arn:aws:sqs:eu-west-1:123456789012:karpenter',
            workerNodeRoleArn: 'arn:aws:iam::123456789012:role/KarpenterNodeRole',
            hostedZoneIds: ['Z1234567890ABC'],
        });
        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::EKS::PodIdentityAssociation', 3);
        t.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
            Namespace: 'karpenter',
            ServiceAccount: 'karpenter',
        });
    });

    it('should expose roles map keyed by purpose', () => {
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
        const stack = new EksPodIdentityStack(app, 'PodId', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            bindings: [
                { namespace: 'karpenter', serviceAccount: 'karpenter', purpose: 'karpenter' },
            ],
            karpenterInterruptionQueueArn: 'arn:aws:sqs:eu-west-1:123456789012:karpenter',
            workerNodeRoleArn: 'arn:aws:iam::123456789012:role/KarpenterNodeRole',
            hostedZoneIds: [],
        });
        expect(stack.roles.karpenter).toBeDefined();
    });
});
