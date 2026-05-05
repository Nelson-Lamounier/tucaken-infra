/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';

import { Template } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config/environments';
import { EksAddonsStack } from '../../../../lib/stacks/kubernetes/eks-addons-stack';

describe('EksAddonsStack', () => {
    it('should add VPC CNI managed addon', () => {
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
        const stack = new EksAddonsStack(app, 'Addons', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            karpenterInterruptionQueueName: 'k8s-eks-development-karpenter',
            workerNodeRoleArn: 'arn:aws:iam::123456789012:role/Worker',
            hostedZoneDomain: 'nelsonlamounier.com',
            versions: {
                karpenter: '1.0.6',
                albController: '1.8.4',
                externalDns: '1.15.0',
                externalSecrets: '0.10.4',
                ebsCsi: '2.35.0',
            },
        });
        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::EKS::Addon', 1);
    });
});
