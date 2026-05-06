/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';

import { Template } from 'aws-cdk-lib/assertions';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config/environments';
import { EksAccessStack } from '../../../../lib/stacks/kubernetes/eks-access-stack';

describe('EksAccessStack', () => {
    it('should create one access entry per principal ARN', () => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_34,
            kubectlLayer: new KubectlV34Layer(clusterStack, 'KubectlLayer'),
            defaultCapacity: 0,
        });
        const stack = new EksAccessStack(app, 'Access', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            principalArns: [
                'arn:aws:iam::123456789012:role/gh-oidc-cdk-deployer',
                'arn:aws:iam::123456789012:role/PortfolioAdmin',
            ],
        });
        const template = Template.fromStack(stack);
        template.resourceCountIs('AWS::EKS::AccessEntry', 2);
        template.hasResourceProperties('AWS::EKS::AccessEntry', {
            PrincipalArn: 'arn:aws:iam::123456789012:role/gh-oidc-cdk-deployer',
        });
    });

    it('should create zero entries when principalArns is empty', () => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_34,
            kubectlLayer: new KubectlV34Layer(clusterStack, 'KubectlLayer'),
            defaultCapacity: 0,
        });
        const stack = new EksAccessStack(app, 'Access', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            principalArns: [],
        });
        const template = Template.fromStack(stack);
        template.resourceCountIs('AWS::EKS::AccessEntry', 0);
    });
});
