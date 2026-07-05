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

    // Cost guard: API + AUDIT control-plane logs dominated the CloudWatch Logs
    // bill (AUDIT ~102 GB/mo). Keep only the three cheap streams. This test
    // fails loudly if a future change re-enables the expensive ones.
    it('should enable only the three cheap control-plane log streams', () => {
        const cluster = Object.values(
            template.findResources('Custom::AWSCDK-EKS-Cluster'),
        )[0] as { Properties: { Config: { logging: { clusterLogging: { types: string[] }[] } } } };
        const types = cluster.Properties.Config.logging.clusterLogging[0].types;
        expect(types).toStrictEqual(['authenticator', 'controllerManager', 'scheduler']);
        expect(types).not.toContain('audit');
        expect(types).not.toContain('api');
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
