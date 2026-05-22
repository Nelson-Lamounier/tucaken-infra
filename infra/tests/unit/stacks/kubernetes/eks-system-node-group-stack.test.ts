/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';


import { Environment } from '../../../../lib/config/environments';
import { EksSystemNodeGroupStack } from '../../../../lib/stacks/kubernetes/eks-system-node-group-stack';

describe('EksSystemNodeGroupStack', () => {
    let template: Template;

    beforeEach(() => {
        const app = new cdk.App();
        const clusterStack = new cdk.Stack(app, 'ClusterStack', {
            env: { account: '123456789012', region: 'eu-west-1' },
        });
        const vpc = new ec2.Vpc(clusterStack, 'Vpc', { maxAzs: 3 });
        const cluster = new eks.Cluster(clusterStack, 'Cluster', {
            clusterName: 'k8s-eks-development',
            version: eks.KubernetesVersion.V1_34,
            kubectlLayer: new KubectlV34Layer(clusterStack, 'KubectlLayer'),
            vpc,
            defaultCapacity: 0,
        });
        const stack = new EksSystemNodeGroupStack(app, 'Mng', {
            env: { account: '123456789012', region: 'eu-west-1' },
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            instanceTypes: ['t3.medium'],
            desiredSize: 3,
            minSize: 3,
            maxSize: 4,
            diskSizeGib: 30,
        });
        template = Template.fromStack(stack);
    });

    it('should create one Nodegroup', () => {
        template.resourceCountIs('AWS::EKS::Nodegroup', 1);
    });

    it('should taint the nodegroup with dedicated=system:NoSchedule', () => {
        template.hasResourceProperties('AWS::EKS::Nodegroup', {
            Taints: Match.arrayWith([
                Match.objectLike({ Key: 'dedicated', Value: 'system', Effect: 'NO_SCHEDULE' }),
            ]),
        });
    });

    it('should set instance type t3.medium and disk 30 GiB', () => {
        template.hasResourceProperties('AWS::EKS::Nodegroup', {
            InstanceTypes: ['t3.medium'],
            DiskSize: 30,
        });
    });

    it('should set desired/min/max scaling 3/3/4', () => {
        template.hasResourceProperties('AWS::EKS::Nodegroup', {
            ScalingConfig: { DesiredSize: 3, MinSize: 3, MaxSize: 4 },
        });
    });

    it('should enable NetworkPolicy enforcement on the vpc-cni addon', () => {
        template.hasResourceProperties('AWS::EKS::Addon', {
            AddonName: 'vpc-cni',
            ConfigurationValues: Match.serializedJson(
                Match.objectLike({ enableNetworkPolicy: 'true' }),
            ),
        });
    });
});
