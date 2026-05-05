/**
 * @format
 * Kubernetes Base Stack Unit Tests
 *
 * Tests for the KubernetesBaseStack (Long-Lived Infrastructure Layer):
 * - Security Groups (4 config-driven SGs + runtime ingress rules)
 * - KMS Key for CloudWatch Logs
 * - EBS Volume (persistent Kubernetes data)
 * - DLM Snapshot Lifecycle Policy
 * - Elastic IP
 * - Route 53 Private Hosted Zone
 * - S3 Buckets (scripts + access logs)
 * - SSM Parameters (cross-stack discovery)
 * - Stack Outputs
 * - Stack Properties (public fields)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { getK8sConfigs } from '../../../../lib/config/kubernetes';
import {
    KubernetesBaseStack,
    KubernetesBaseStackProps,
} from '../../../../lib/stacks/kubernetes/base-stack';
import {
    TEST_ENV_EU,
    TEST_VPC_CONTEXT_KEY,
    TEST_VPC_CONTEXT,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Named Constants (Rule 3)
// =============================================================================

/** VPC CIDR from test context — must match TEST_VPC_CONTEXT.vpcCidrBlock */
const TEST_VPC_CIDR = '10.0.0.0/16';

/** Pod network CIDR from K8s config */
const TEST_POD_CIDR = '192.168.0.0/16';

/** Any IPv4 address (NLB inbound) */
const ANY_IPV4 = '0.0.0.0/0';

/** NLB access log lifecycle expiration in days */
const NLB_LOG_LIFECYCLE_DAYS = 3;

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_CONFIGS = getK8sConfigs(Environment.DEVELOPMENT);



/**
 * Helper to create KubernetesBaseStack with sensible defaults.
 *
 * Override any prop via the `overrides` parameter.
 */
function createBaseStack(
    overrides?: Partial<KubernetesBaseStackProps>,
): { stack: KubernetesBaseStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    // Provide VPC context so Vpc.fromLookup() resolves with eu-west-1 AZs
    app.node.setContext(TEST_VPC_CONTEXT_KEY, TEST_VPC_CONTEXT);

    const stack = new KubernetesBaseStack(app, 'TestK8sBaseStack', {
        env: TEST_ENV_EU,
        targetEnvironment: Environment.DEVELOPMENT,
        configs: TEST_CONFIGS,
        namePrefix: 'k8s-dev',
        ssmPrefix: '/k8s/development',
        vpcName: 'shared-vpc-development',
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesBaseStack', () => {
    let template: Template;
    let stack: KubernetesBaseStack;

    beforeAll(() => {
        const result = createBaseStack();
        template = result.template;
        stack = result.stack;
    });

    // =========================================================================
    // Security Groups — Existence & Configuration
    // =========================================================================
    describe('Security Groups — Existence', () => {
        it('should create exactly 6 security groups (4 custom + 1 NLB + 1 EKS workers)', () => {
            template.resourceCountIs('AWS::EC2::SecurityGroup', 6);
        });

        it('should create cluster base SG with all outbound allowed', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('Shared Kubernetes cluster'),
                GroupName: 'k8s-dev-k8s-cluster',
            });
        });

        it('should create control plane SG with restricted outbound', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('K8s control plane'),
                GroupName: 'k8s-dev-k8s-control-plane',
                SecurityGroupEgress: Match.arrayWith([
                    Match.objectLike({
                        CidrIp: '255.255.255.255/32',
                        Description: 'Disallow all traffic',
                    }),
                ]),
            });
        });

        it('should create ingress SG with restricted outbound', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('K8s ingress'),
                GroupName: 'k8s-dev-k8s-ingress',
                SecurityGroupEgress: Match.arrayWith([
                    Match.objectLike({
                        CidrIp: '255.255.255.255/32',
                        Description: 'Disallow all traffic',
                    }),
                ]),
            });
        });

        it('should create monitoring SG with restricted outbound', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('K8s monitoring'),
                GroupName: 'k8s-dev-k8s-monitoring',
                SecurityGroupEgress: Match.arrayWith([
                    Match.objectLike({
                        CidrIp: '255.255.255.255/32',
                        Description: 'Disallow all traffic',
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // Cluster Base SG — Individual Ingress Rules
    //
    // Verifies every config-driven rule renders into the CloudFormation template.
    // Self-referencing rules use AWS::EC2::SecurityGroupIngress (separate resource).
    // CIDR-based rules use inline SecurityGroupIngress on the SG resource.
    // =========================================================================
    describe('Cluster Base SG — Ingress Rules', () => {
        it('should have the expected number of config-driven rules', () => {
            const ruleCount = TEST_CONFIGS.securityGroups.clusterBase.rules.length;
            expect(ruleCount).toBe(19); // 13 self + 1 vpcCidr + 5 podCidr
        });

        // --- Self-referencing TCP rules (rendered as SecurityGroupIngress resources) ---
        it.each([
            { port: 2379, endPort: 2380, desc: 'etcd client+peer' },
            { port: 10250, endPort: 10250, desc: 'kubelet API' },
            { port: 10257, endPort: 10257, desc: 'kube-controller-manager' },
            { port: 10259, endPort: 10259, desc: 'kube-scheduler' },
            { port: 179, endPort: 179, desc: 'Calico BGP' },
            { port: 30000, endPort: 32767, desc: 'NodePort range' },
            { port: 53, endPort: 53, desc: 'CoreDNS TCP' },
            { port: 5473, endPort: 5473, desc: 'Calico Typha' },
            { port: 9100, endPort: 9100, desc: 'Traefik metrics' },
            { port: 9101, endPort: 9101, desc: 'Node Exporter metrics' },
        ])(
            'should have self-referencing TCP rule for $desc (port $port)',
            ({ port, endPort }) => {
                template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
                    IpProtocol: 'tcp',
                    FromPort: port,
                    ToPort: endPort,
                    Description: Match.stringLikeRegexp('intra-cluster'),
                });
            },
        );

        // --- Self-referencing UDP rules ---
        it.each([
            { port: 4789, desc: 'VXLAN overlay' },
            { port: 53, desc: 'CoreDNS UDP' },
        ])(
            'should have self-referencing UDP rule for $desc (port $port)',
            ({ port }) => {
                template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
                    IpProtocol: 'udp',
                    FromPort: port,
                    ToPort: port,
                    Description: Match.stringLikeRegexp('intra-cluster'),
                });
            },
        );

        // --- VPC CIDR TCP rule (inline on SG) ---
        it('should have VPC CIDR TCP rule for K8s API server (port 6443)', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-cluster',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 6443,
                        ToPort: 6443,
                        IpProtocol: 'tcp',
                        CidrIp: TEST_VPC_CIDR,
                    }),
                ]),
            });
        });

        // --- Pod CIDR TCP rules (inline on SG) ---
        it.each([
            { port: 6443, desc: 'K8s API server' },
            { port: 10250, desc: 'kubelet API' },
            { port: 53, desc: 'CoreDNS TCP' },
            { port: 9100, desc: 'Traefik metrics' },
            { port: 9101, desc: 'Node Exporter metrics' },
        ])(
            'should have pod CIDR TCP rule for $desc (port $port)',
            ({ port }) => {
                template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                    GroupName: 'k8s-dev-k8s-cluster',
                    SecurityGroupIngress: Match.arrayWith([
                        Match.objectLike({
                            FromPort: port,
                            ToPort: port,
                            IpProtocol: 'tcp',
                            CidrIp: TEST_POD_CIDR,
                        }),
                    ]),
                });
            },
        );

        // --- Pod CIDR UDP rule ---
        it('should have pod CIDR UDP rule for CoreDNS (port 53)', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-cluster',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 53,
                        ToPort: 53,
                        IpProtocol: 'udp',
                        CidrIp: TEST_POD_CIDR,
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // Control Plane SG — Rule Validation
    // =========================================================================
    describe('Control Plane SG — Rules', () => {
        it('should have K8s API ingress rule on port 6443 from VPC CIDR', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-control-plane',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 6443,
                        ToPort: 6443,
                        IpProtocol: 'tcp',
                        CidrIp: TEST_VPC_CIDR,
                        Description: Match.stringLikeRegexp('K8s API'),
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // Ingress SG — Rule Validation
    // =========================================================================
    describe('Ingress SG — Rules', () => {
        it('should have HTTP port 80 from VPC CIDR (NLB health checks)', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-ingress',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 80,
                        ToPort: 80,
                        IpProtocol: 'tcp',
                        CidrIp: TEST_VPC_CIDR,
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // Monitoring SG — Rule Validation
    //
    // Ports: Prometheus (9090), Node Exporter (9100), Loki (30100), Tempo (30417)
    // Sources: VPC CIDR for all, pod CIDR for Node Exporter (Prometheus scraping)
    // =========================================================================
    describe('Monitoring SG — Rules', () => {
        it.each([
            { port: 9090, desc: 'Prometheus metrics' },
            { port: 9100, desc: 'Node Exporter metrics (VPC)' },
            { port: 30100, desc: 'Loki push API' },
            { port: 30417, desc: 'Tempo OTLP gRPC' },
        ])(
            'should have TCP rule for $desc (port $port) from VPC CIDR',
            ({ port }) => {
                template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                    GroupName: 'k8s-dev-k8s-monitoring',
                    SecurityGroupIngress: Match.arrayWith([
                        Match.objectLike({
                            FromPort: port,
                            ToPort: port,
                            IpProtocol: 'tcp',
                            CidrIp: TEST_VPC_CIDR,
                        }),
                    ]),
                });
            },
        );

        it('should have Node Exporter port 9100 from pod CIDR (Prometheus scraping)', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-monitoring',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 9100,
                        ToPort: 9100,
                        IpProtocol: 'tcp',
                        CidrIp: TEST_POD_CIDR,
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // CloudFront Prefix List Lookup
    // =========================================================================
    describe('CloudFront Prefix List', () => {
        it('should create a custom resource to lookup the CloudFront prefix list', () => {
            template.hasResourceProperties('Custom::AWS', {
                Create: Match.serializedJson(Match.objectLike({
                    service: '@aws-sdk/client-ec2',
                    action: 'DescribeManagedPrefixLists',
                })),
            });
        });

        it('should grant ec2:DescribeManagedPrefixLists to the custom resource', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'ec2:DescribeManagedPrefixLists',
                            Effect: 'Allow',
                            Resource: '*',
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // NLB — Configuration
    // =========================================================================
    describe('NLB — Configuration', () => {
        it('should create an internet-facing Network Load Balancer', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Scheme: 'internet-facing',
                Type: 'network',
                LoadBalancerAttributes: Match.arrayWith([
                    Match.objectLike({
                        Key: 'load_balancing.cross_zone.enabled',
                        Value: 'false',
                    }),
                ]),
            });
        });

        it('should have the correct load balancer name', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Name: 'k8s-dev-nlb',
            });
        });
    });

    // =========================================================================
    // NLB — Target Groups
    // =========================================================================
    describe('NLB — Target Groups', () => {
        it('should create 2 target groups (HTTP + HTTPS)', () => {
            template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
        });

        it('should have an HTTP target group on port 80 with TCP protocol', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Name: 'k8s-dev-http',
                Port: 80,
                Protocol: 'TCP',
                TargetType: 'instance',
            });
        });

        it('should have an HTTPS target group on port 443 with TCP protocol', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Name: 'k8s-dev-https',
                Port: 443,
                Protocol: 'TCP',
                TargetType: 'instance',
            });
        });

        it('should health-check HTTPS target group on port 80', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Name: 'k8s-dev-https',
                HealthCheckPort: '80',
                HealthCheckProtocol: 'TCP',
            });
        });
    });

    // =========================================================================
    // NLB — Listeners
    // =========================================================================
    describe('NLB — Listeners', () => {
        it('should create 2 listeners (HTTP + HTTPS)', () => {
            template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
        });

        it('should have a TCP listener on port 80', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 80,
                Protocol: 'TCP',
            });
        });

        it('should have a TCP listener on port 443', () => {
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 443,
                Protocol: 'TCP',
            });
        });
    });

    // =========================================================================
    // NLB — Security Group
    //
    // CDK renders all NLB SG rules inline on the SecurityGroup resource:
    // Inbound: 0.0.0.0/0 + ::/0 on ports 80 + 443 (IPv4 + IPv6)
    // Outbound: VPC CIDR on ports 80 + 443 (replaces default 'Disallow all' egress)
    // =========================================================================
    describe('NLB — Security Group', () => {
        it('should have NLB SG with correct description', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('Security group for NLB'),
            });
        });

        it('should have inbound TCP 80 from CloudFront Prefix List', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
                IpProtocol: 'tcp',
                FromPort: 80,
                ToPort: 80,
                Description: Match.stringLikeRegexp('HTTP from CloudFront origin-facing IPs only'),
                SourcePrefixListId: Match.anyValue(), // Validates it's bound to a prefix list ID
            });
        });

        it('should have inline inbound TCP 443 from 0.0.0.0/0 (IPv4)', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('Security group for NLB'),
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        IpProtocol: 'tcp',
                        FromPort: 443,
                        ToPort: 443,
                        CidrIp: ANY_IPV4,
                        Description: Match.stringLikeRegexp(`HTTPS from internet \\(admin access via Traefik\\)`),
                    }),
                ]),
            });
        });

        it.each([80, 443])(
            'should have inline outbound TCP %i to VPC CIDR',
            (port) => {
                template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                    GroupDescription: Match.stringLikeRegexp('Security group for NLB'),
                    SecurityGroupEgress: Match.arrayWith([
                        Match.objectLike({
                            IpProtocol: 'tcp',
                            FromPort: port,
                            ToPort: port,
                            CidrIp: TEST_VPC_CIDR,
                            Description: Match.stringLikeRegexp(`TCP/${port} to targets`),
                        }),
                    ]),
                });
            },
        );
    });

    // =========================================================================
    // KMS Key
    // =========================================================================
    describe('KMS Key', () => {
        it('should create a KMS key for CloudWatch log group encryption', () => {
            template.hasResourceProperties('AWS::KMS::Key', {
                Description: Match.stringLikeRegexp('log group encryption'),
                EnableKeyRotation: true,
            });
        });

        it('should enable key rotation', () => {
            template.hasResourceProperties('AWS::KMS::Key', {
                EnableKeyRotation: true,
            });
        });

        it('should create a key alias matching the name prefix', () => {
            template.hasResourceProperties('AWS::KMS::Alias', {
                AliasName: 'alias/k8s-dev-log-group',
            });
        });

        it('should grant CloudWatch Logs service principal encrypt/decrypt permissions', () => {
            template.hasResourceProperties('AWS::KMS::Key', {
                KeyPolicy: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'kms:Encrypt*',
                                'kms:Decrypt*',
                            ]),
                            Principal: Match.objectLike({
                                Service: Match.stringLikeRegexp('logs.*amazonaws.com'),
                            }),
                        }),
                    ]),
                }),
            });
        });
    });



    // =========================================================================
    // Elastic IP
    // =========================================================================
    describe('Elastic IP', () => {
        it('should create an Elastic IP', () => {
            template.resourceCountIs('AWS::EC2::EIP', 1);
        });

        it('should tag the Elastic IP with the name prefix', () => {
            template.hasResourceProperties('AWS::EC2::EIP', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'Name', Value: 'k8s-dev-k8s-eip' }),
                ]),
            });
        });
    });

    // =========================================================================
    // Route 53 Private Hosted Zone
    // =========================================================================
    describe('Route 53', () => {
        it('should create a private hosted zone for k8s.internal', () => {
            template.hasResourceProperties('AWS::Route53::HostedZone', {
                Name: 'k8s.internal.',
            });
        });

        it('should create a placeholder A record for the API server', () => {
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Name: 'k8s-api.k8s.internal.',
                Type: 'A',
                TTL: '30',
            });
        });
    });

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    describe('S3 Buckets', () => {
        it('should create 3 S3 buckets (scripts + access logs + NLB access logs)', () => {
            template.resourceCountIs('AWS::S3::Bucket', 3);
        });

        it('should encrypt all S3 buckets', () => {
            const buckets = template.findResources('AWS::S3::Bucket');
            for (const [, resource] of Object.entries(buckets)) {
                const props = resource.Properties;
                expect(props.BucketEncryption).toBeDefined();
            }
        });
    });

    // =========================================================================
    // NLB Access Logs Bucket — Detailed
    // =========================================================================
    describe('NLB Access Logs Bucket', () => {
        it('should use S3-managed encryption (AES256 / SSE-S3)', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: Match.stringLikeRegexp('nlb-access-logs'),
                BucketEncryption: Match.objectLike({
                    ServerSideEncryptionConfiguration: Match.arrayWith([
                        Match.objectLike({
                            ServerSideEncryptionByDefault: Match.objectLike({
                                SSEAlgorithm: 'AES256',
                            }),
                        }),
                    ]),
                }),
            });
        });

        it('should have a lifecycle rule with 3-day expiration', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: Match.stringLikeRegexp('nlb-access-logs'),
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            ExpirationInDays: NLB_LOG_LIFECYCLE_DAYS,
                            Status: 'Enabled',
                        }),
                    ]),
                }),
            });
        });

        it('should have a bucket name containing the nlb-access-logs identifier', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: Match.stringLikeRegexp('k8s-dev-nlb-access-logs'),
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should create 15 SSM parameters for cross-stack discovery', () => {
            template.resourceCountIs('AWS::SSM::Parameter', 15);
        });

        it('should create SSM parameters under the /k8s/development prefix', () => {
            const params = template.findResources('AWS::SSM::Parameter');
            const paramNames = Object.values(params).map(
                (r: Record<string, any>) => r.Properties.Name as string,
            );

            // Verify key SSM parameter paths exist
            const expectedPrefixes = paramNames.filter(
                (name) => name.startsWith('/k8s/development/'),
            );
            expect(expectedPrefixes).toHaveLength(15);
        });

        it('should publish the security group ID to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/security-group-id',
                Type: 'String',
            });
        });

        it('should publish the Elastic IP to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/elastic-ip',
                Type: 'String',
            });
        });



        it('should publish the scripts bucket name to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/scripts-bucket',
                Type: 'String',
            });
        });

        it('should publish the hosted zone ID to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/hosted-zone-id',
                Type: 'String',
            });
        });

        it('should publish the API DNS name to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/api-dns-name',
                Value: 'k8s-api.k8s.internal',
                Type: 'String',
            });
        });

        it('should publish the KMS key ARN to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/kms-key-arn',
                Type: 'String',
            });
        });

        it('should publish the NLB HTTP target group ARN to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/nlb-http-target-group-arn',
                Type: 'String',
            });
        });

        it('should publish the NLB HTTPS target group ARN to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/nlb-https-target-group-arn',
                Type: 'String',
            });
        });

        it('should publish all 4 security group IDs to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/control-plane-sg-id',
                Type: 'String',
            });
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/ingress-sg-id',
                Type: 'String',
            });
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/monitoring-sg-id',
                Type: 'String',
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose vpc', () => {
            expect(stack.vpc).toBeDefined();
        });

        it('should expose securityGroup', () => {
            expect(stack.securityGroup).toBeDefined();
            expect(stack.securityGroup.securityGroupId).toBeDefined();
        });

        it('should expose controlPlaneSg', () => {
            expect(stack.controlPlaneSg).toBeDefined();
            expect(stack.controlPlaneSg.securityGroupId).toBeDefined();
        });

        it('should expose ingressSg', () => {
            expect(stack.ingressSg).toBeDefined();
            expect(stack.ingressSg.securityGroupId).toBeDefined();
        });

        it('should expose monitoringSg', () => {
            expect(stack.monitoringSg).toBeDefined();
            expect(stack.monitoringSg.securityGroupId).toBeDefined();
        });

        it('should expose logGroupKmsKey', () => {
            expect(stack.logGroupKmsKey).toBeDefined();
            expect(stack.logGroupKmsKey.keyArn).toBeDefined();
        });



        it('should expose scriptsBucket', () => {
            expect(stack.scriptsBucket).toBeDefined();
            expect(stack.scriptsBucket.bucketName).toBeDefined();
        });

        it('should expose hostedZone', () => {
            expect(stack.hostedZone).toBeDefined();
            expect(stack.hostedZone.hostedZoneId).toBeDefined();
        });

        it('should expose apiDnsName as k8s-api.k8s.internal', () => {
            expect(stack.apiDnsName).toBe('k8s-api.k8s.internal');
        });

        it('should expose elasticIp', () => {
            expect(stack.elasticIp).toBeDefined();
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should export VpcId', () => {
            template.hasOutput('VpcId', {
                Description: 'Shared VPC ID',
            });
        });

        it('should export SecurityGroupId', () => {
            template.hasOutput('SecurityGroupId', {
                Description: 'Kubernetes cluster security group ID',
            });
        });

        it('should export ElasticIpAddress', () => {
            template.hasOutput('ElasticIpAddress', {
                Description: 'Kubernetes cluster Elastic IP address',
            });
        });

        it('should export ElasticIpAllocationId', () => {
            template.hasOutput('ElasticIpAllocationId', {
                Description: 'Kubernetes cluster Elastic IP allocation ID',
            });
        });



        it('should export HostedZoneId', () => {
            template.hasOutput('HostedZoneId', {
                Description: Match.stringLikeRegexp('hosted zone'),
            });
        });

        it('should export ApiDnsName', () => {
            template.hasOutput('ApiDnsName', {
                Value: 'k8s-api.k8s.internal',
                Description: 'Stable DNS name for the Kubernetes API server',
            });
        });

        it('should export LogGroupKmsKeyArn', () => {
            template.hasOutput('LogGroupKmsKeyArn', {
                Description: Match.stringLikeRegexp('KMS key ARN'),
            });
        });

        it('should export ScriptsBucketName', () => {
            template.hasOutput('ScriptsBucketName', {
                Description: 'S3 bucket for k8s scripts and manifests',
            });
        });
    });

    // =========================================================================
    // Config Integration
    // =========================================================================
    describe('Config Integration', () => {


        it('should use pod network CIDR from config for SG rules', () => {
            expect(TEST_CONFIGS.cluster.podNetworkCidr).toBe('192.168.0.0/16');
            // Pod CIDR rules should reference 192.168.0.0/16
            const json = JSON.stringify(template.toJSON());
            expect(json).toContain('192.168.0.0/16');
        });

        it('should use the default SG config for all environments', () => {
            // Verify the config is properly loaded
            expect(TEST_CONFIGS.securityGroups.clusterBase.rules.length).toBeGreaterThan(10);
            expect(TEST_CONFIGS.securityGroups.controlPlane.rules).toHaveLength(1);
            expect(TEST_CONFIGS.securityGroups.monitoring.rules).toHaveLength(5);
            expect(TEST_CONFIGS.securityGroups.ingress.rules).toHaveLength(1);
        });

        it('should use isProduction=false for development environment', () => {
            expect(TEST_CONFIGS.isProduction).toBe(false);
        });
    });

    // =========================================================================
    // Resource Count Sanity Check
    // =========================================================================
    describe('Resource Counts', () => {
        it('should create expected number of core resources', () => {
            template.resourceCountIs('AWS::EC2::SecurityGroup', 6);
            template.resourceCountIs('AWS::EC2::EIP', 1);
            template.resourceCountIs('AWS::KMS::Key', 1);
            template.resourceCountIs('AWS::KMS::Alias', 1);
            template.resourceCountIs('AWS::Route53::HostedZone', 1);
            template.resourceCountIs('AWS::Route53::RecordSet', 1);
            template.resourceCountIs('AWS::S3::Bucket', 3);
            template.resourceCountIs('AWS::SSM::Parameter', 15);
        });
    });
});
