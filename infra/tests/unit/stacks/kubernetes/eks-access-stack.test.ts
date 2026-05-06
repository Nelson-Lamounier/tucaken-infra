/** @format */
process.env.AWS_ACCOUNT_ID = '123456789012';

import { Template } from 'aws-cdk-lib/assertions';

import { Environment } from '../../../../lib/config/environments';
import { EksAccessStack } from '../../../../lib/stacks/kubernetes/eks-access-stack';
import { TEST_ENV_EU, createMockEksCluster } from '../../../fixtures';

describe('EksAccessStack', () => {
    const newStack = (principalArns: string[]) => {
        const { app, cluster } = createMockEksCluster();
        return new EksAccessStack(app, 'Access', {
            env: TEST_ENV_EU,
            targetEnvironment: Environment.DEVELOPMENT,
            cluster,
            principalArns,
        });
    };

    it('should create one access entry per principal ARN', () => {
        const template = Template.fromStack(newStack([
            'arn:aws:iam::123456789012:role/gh-oidc-cdk-deployer',
            'arn:aws:iam::123456789012:role/PortfolioAdmin',
        ]));
        template.resourceCountIs('AWS::EKS::AccessEntry', 2);
        template.hasResourceProperties('AWS::EKS::AccessEntry', {
            PrincipalArn: 'arn:aws:iam::123456789012:role/gh-oidc-cdk-deployer',
        });
    });

    it('should create zero entries when principalArns is empty', () => {
        const template = Template.fromStack(newStack([]));
        template.resourceCountIs('AWS::EKS::AccessEntry', 0);
    });
});
