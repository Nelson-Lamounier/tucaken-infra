/**
 * @format
 * EKS Access Stack — IAM principal-to-Kubernetes-RBAC bindings.
 * Replaces aws-auth ConfigMap with EKS Access Entries.
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 7.1
 */
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksAccessStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.ICluster;
    /** Static admin principals (e.g. CI OIDC role from env vars). */
    readonly principalArns: readonly string[];
    /** SSM StringList path with comma-separated admin principal ARNs. */
    readonly adminPrincipalArnsSsmPath?: string;
}

export class EksAccessStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksAccessStackProps) {
        super(scope, id, props);

        // Synth-time SSM lookup must run in a Stack scope (not App), so it
        // happens here rather than in the factory. Cached in cdk.context.json.
        const fromSsm: string[] = [];
        if (props.adminPrincipalArnsSsmPath) {
            const raw = ssm.StringParameter.valueFromLookup(this, props.adminPrincipalArnsSsmPath);
            if (raw && !raw.startsWith('dummy-value-for-')) {
                fromSsm.push(...raw.split(',').map((a) => a.trim()).filter(Boolean));
            }
        }

        const allArns = Array.from(new Set([...props.principalArns, ...fromSsm]));
        for (const arn of allArns) {
            const slug = arn.split('/').pop()!.replaceAll(/[^a-zA-Z0-9]/g, '');
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
