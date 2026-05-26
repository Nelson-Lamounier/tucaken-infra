/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { Match, Template } from 'aws-cdk-lib/assertions';

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
        // vpc-cni and kube-proxy live in EksSystemNodeGroupStack (moved to break
        // the node-ready deadlock). Only eks-pod-identity-agent and coredns here.
        t.resourceCountIs('AWS::EKS::Addon', 2);
        for (const name of ['eks-pod-identity-agent', 'coredns']) {
            t.hasResourceProperties('AWS::EKS::Addon', { AddonName: name });
        }
    });

    it('should expose roles map keyed by purpose', () => {
        const stack = newStack([
            { namespace: 'karpenter', serviceAccount: 'karpenter', purpose: 'karpenter' },
        ]);
        expect(stack.roles.karpenter).toBeDefined();
    });

    describe('ontology-importer purpose', () => {
        const bindings: PodIdentityBinding[] = [
            { namespace: 'ontology-importer', serviceAccount: 'ontology-importer-sa', purpose: 'ontology-importer' },
        ];

        it('should create a Bedrock-trusted batch service role', () => {
            const t = Template.fromStack(newStack(bindings));
            t.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'sts:AssumeRole',
                            Principal: { Service: 'bedrock.amazonaws.com' },
                        }),
                    ]),
                },
            });
        });

        it('should grant the batch service role bedrock:InvokeModel (required for batch execution)', () => {
            const t = Template.fromStack(newStack(bindings));
            t.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'BatchBedrockInvoke',
                            Action: 'bedrock:InvokeModel',
                            Resource: Match.arrayWith([
                                'arn:aws:bedrock:*::foundation-model/*',
                            ]),
                        }),
                    ]),
                },
            });
        });

        it('should grant the pod role bedrock:CreateModelInvocationJob', () => {
            const t = Template.fromStack(newStack(bindings));
            t.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'OntologyImporterBedrockBatch',
                            Action: Match.arrayWith([
                                'bedrock:CreateModelInvocationJob',
                                'bedrock:GetModelInvocationJob',
                                'bedrock:StopModelInvocationJob',
                                'bedrock:InvokeModel',
                            ]),
                        }),
                    ]),
                },
            });
        });

        it('should publish the batch role ARN to SSM', () => {
            const t = Template.fromStack(newStack(bindings));
            t.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/shared/ontology-importer/development/batch-role-arn',
            });
        });

        it('should create a PodIdentityAssociation for ontology-importer-sa', () => {
            const t = Template.fromStack(newStack(bindings));
            t.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
                Namespace: 'ontology-importer',
                ServiceAccount: 'ontology-importer-sa',
            });
        });
    });
});
