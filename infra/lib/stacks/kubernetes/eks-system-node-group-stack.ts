/**
 * @format
 * EKS System Node Group Stack — Karpenter / CoreDNS landing zone.
 *
 * 2× t3.medium nodes spread across 2 AZs hosting cluster-critical pods
 * (Karpenter controller, CoreDNS, kube-proxy, addon controllers, monitoring
 * stack). Tainted `dedicated=system:NoSchedule`; workload pods land on
 * Karpenter-managed nodes.
 *
 * Subnets: PUBLIC only (V1 dev — no NAT GW).
 *
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md § 3.1
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

export interface EksSystemNodeGroupStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly cluster: eks.Cluster;
    readonly instanceTypes: readonly string[];
    readonly desiredSize: number;
    readonly minSize: number;
    readonly maxSize: number;
    readonly diskSizeGib: number;
}

export class EksSystemNodeGroupStack extends cdk.Stack {
    public readonly nodeGroup: eks.Nodegroup;
    public readonly nodeRole: iam.Role;

    constructor(scope: Construct, id: string, props: EksSystemNodeGroupStackProps) {
        super(scope, id, props);

        this.nodeRole = new iam.Role(props.cluster, 'SystemMngNodeRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // vpc-cni and kube-proxy live HERE — not in EksPodIdentityStack — to
        // break the timing deadlock: EKS waits for nodes to be Ready before
        // marking this stack CREATE_COMPLETE, and nodes need the CNI DaemonSet
        // to reach Ready. Both CfnAddons have no CFN dependency on the MNG so
        // CloudFormation creates them in parallel; aws-node is running before
        // the first node finishes bootstrapping.
        new eks.CfnAddon(this, 'VpcCni', {
            clusterName: props.cluster.clusterName,
            addonName: 'vpc-cni',
            resolveConflicts: 'OVERWRITE',
        });

        new eks.CfnAddon(this, 'KubeProxy', {
            clusterName: props.cluster.clusterName,
            addonName: 'kube-proxy',
            resolveConflicts: 'OVERWRITE',
        });

        this.nodeGroup = new eks.Nodegroup(this, 'SystemMng', {
            cluster: props.cluster,
            instanceTypes: props.instanceTypes.map((t) => new ec2.InstanceType(t)),
            desiredSize: props.desiredSize,
            minSize: props.minSize,
            maxSize: props.maxSize,
            diskSize: props.diskSizeGib,
            amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
            capacityType: eks.CapacityType.ON_DEMAND,
            nodeRole: this.nodeRole,
            taints: [
                { key: 'dedicated', value: 'system', effect: eks.TaintEffect.NO_SCHEDULE },
            ],
            labels: { 'node-role': 'system' },
            subnets: { subnetType: ec2.SubnetType.PUBLIC },
            tags: { 'eks-cluster-pool': 'system' },
        });
    }
}
