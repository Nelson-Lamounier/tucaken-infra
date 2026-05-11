/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';

import { Environment } from '../../../../lib/config/environments';
import { EksKarpenterStack } from '../../../../lib/stacks/kubernetes/eks-karpenter-stack';
import { TEST_ENV_EU, createMockEksCluster } from '../../../fixtures';

describe('EksKarpenterStack', () => {
    it('should create SQS interruption queue and 4 EventBridge rules', () => {
        const { app, clusterStack, cluster } = createMockEksCluster();
        const nodeRole = new iam.Role(clusterStack, 'NodeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });
        const stack = new EksKarpenterStack(app, 'Karp', {
            env: TEST_ENV_EU,
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            workerNodeRole: nodeRole,
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
