/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { Template } from 'aws-cdk-lib/assertions';

import { Environment } from '../../../../lib/config/environments';
import { EksAddonsStack } from '../../../../lib/stacks/kubernetes/eks-addons-stack';
import { TEST_ENV_EU, createMockEksCluster } from '../../../fixtures';

describe('EksAddonsStack', () => {
    it('should add EBS CSI managed addon (foundational addons live in EksPodIdentityStack)', () => {
        const { app, cluster } = createMockEksCluster();
        const stack = new EksAddonsStack(app, 'Addons', {
            env: TEST_ENV_EU,
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            vpcId: 'vpc-aaa',
            region: 'eu-west-1',
            karpenterInterruptionQueueName: 'k8s-eks-development-karpenter',
            workerNodeRoleArn: 'arn:aws:iam::123456789012:role/Worker',
            hostedZoneDomains: ['nelsonlamounier.com'],
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
        t.hasResourceProperties('AWS::EKS::Addon', { AddonName: 'aws-ebs-csi-driver' });
    });
});
