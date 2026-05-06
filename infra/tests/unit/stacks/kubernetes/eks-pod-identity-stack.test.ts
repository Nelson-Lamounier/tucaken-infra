/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { Template } from 'aws-cdk-lib/assertions';

import { type PodIdentityBinding } from '../../../../lib/config/eks';
import { Environment } from '../../../../lib/config/environments';
import { EksPodIdentityStack } from '../../../../lib/stacks/kubernetes/eks-pod-identity-stack';
import { TEST_ENV_EU, createMockEksCluster } from '../../../fixtures';

const newStack = (bindings: PodIdentityBinding[], hostedZoneIds: string[] = []) => {
    const { app, cluster } = createMockEksCluster();
    return new EksPodIdentityStack(app, 'PodId', {
        env: TEST_ENV_EU,
        targetEnvironment: Environment.DEVELOPMENT,
        cluster,
        bindings,
        karpenterInterruptionQueueArn: 'arn:aws:sqs:eu-west-1:123456789012:karpenter',
        workerNodeRoleArn: 'arn:aws:iam::123456789012:role/KarpenterNodeRole',
        hostedZoneIds,
    });
};

describe('EksPodIdentityStack', () => {
    it('should create one PodIdentityAssociation per binding plus foundational addons', () => {
        const stack = newStack([
            { namespace: 'karpenter', serviceAccount: 'karpenter', purpose: 'karpenter' },
            { namespace: 'kube-system', serviceAccount: 'aws-load-balancer-controller', purpose: 'alb-controller' },
            { namespace: 'external-secrets', serviceAccount: 'external-secrets', purpose: 'external-secrets' },
        ], ['Z1234567890ABC']);

        const t = Template.fromStack(stack);
        t.resourceCountIs('AWS::EKS::PodIdentityAssociation', 3);
        t.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
            Namespace: 'karpenter',
            ServiceAccount: 'karpenter',
        });
        // Foundational managed addons live here so they survive a Helm-chart
        // rollback in EksAddonsStack.
        t.resourceCountIs('AWS::EKS::Addon', 4);
        for (const name of ['vpc-cni', 'eks-pod-identity-agent', 'coredns', 'kube-proxy']) {
            t.hasResourceProperties('AWS::EKS::Addon', { AddonName: name });
        }
    });

    it('should expose roles map keyed by purpose', () => {
        const stack = newStack([
            { namespace: 'karpenter', serviceAccount: 'karpenter', purpose: 'karpenter' },
        ]);
        expect(stack.roles.karpenter).toBeDefined();
    });
});
