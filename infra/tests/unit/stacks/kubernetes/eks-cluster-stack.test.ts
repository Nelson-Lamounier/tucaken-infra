/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config/environments';
import { EksClusterStack } from '../../../../lib/stacks/kubernetes/eks-cluster-stack';

describe('EksClusterStack', () => {
    let template: Template;

    beforeEach(() => {
        const app = new cdk.App();
        const vpcStack = new cdk.Stack(app, 'VpcStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const vpc = new ec2.Vpc(vpcStack, 'Vpc', { maxAzs: 3 });
        const stack = new EksClusterStack(app, 'EksCluster', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            vpc,
            clusterName: 'k8s-eks-development',
            version: '1.34',
        });
        template = Template.fromStack(stack);
    });

    it('should create one KMS key for secrets envelope encryption', () => {
        template.resourceCountIs('AWS::KMS::Key', 1);
    });

    it('should set the cluster name and Kubernetes version', () => {
        const json = JSON.stringify(template.toJSON());
        expect(json).toContain('k8s-eks-development');
        expect(json).toContain('1.34');
    });

    it('should retain the KMS key', () => {
        template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
    });

    it('should retain the control-plane log group', () => {
        template.hasResource('AWS::Logs::LogGroup', {
            DeletionPolicy: 'Retain',
            Properties: { LogGroupName: '/aws/eks/k8s-eks-development/cluster' },
        });
    });
});
