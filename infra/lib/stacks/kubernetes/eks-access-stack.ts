/**
 * @format
 * EKS Access Stack — IAM principal-to-Kubernetes-RBAC bindings.
 * Replaces aws-auth ConfigMap with EKS Access Entries.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 7.1
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksAccessStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    readonly principalArns: readonly string[];
}

export class EksAccessStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksAccessStackProps) {
        super(scope, id, props);

        for (const arn of props.principalArns) {
            const slug = arn.split('/').pop()!.replace(/[^a-zA-Z0-9]/g, '');
            new eks.AccessEntry(this, `Entry${slug}`, {
                cluster: props.cluster,
                principal: arn,
                accessPolicies: [
                    eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
                        accessScopeType: eks.AccessScopeType.CLUSTER,
                    }),
                ],
            });
        }
    }
}
