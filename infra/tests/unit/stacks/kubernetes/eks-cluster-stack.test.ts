/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config/environments';
import { EksClusterStack } from '../../../../lib/stacks/kubernetes/eks-cluster-stack';

describe('EksClusterStack', () => {
    let template: Template;

    beforeEach(() => {
        const app = new cdk.App();
        const stack = new EksClusterStack(app, 'EksCluster', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
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

    it('should grant the EKS cluster security group PostgreSQL access to platform RDS', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
            Description: 'PostgreSQL from EKS managed workload SG via PgBouncer',
            FromPort: 5432,
            GroupId: Match.objectLike({
                Ref: Match.stringLikeRegexp('SsmParameterValuek8sdevelopmentplatformrdssgid'),
            }),
            IpProtocol: 'tcp',
            SourceSecurityGroupId: Match.anyValue(),
            ToPort: 5432,
        });
    });
});
