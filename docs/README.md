# Documentation Index

> Platform infrastructure docs only. Kubernetes operational guides live in
> [kubernetes-bootstrap/docs](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/tree/main/docs).
> AI pipeline docs live in [ai-applications/docs](https://github.com/Nelson-Lamounier/ai-applications/tree/main/docs).

---

## Decisions

| # | Decision |
|:--|:---------|
| [0001: Self-Managed K8s vs EKS](decisions/0001-self-managed-k8s-vs-eks.md) | Why self-managed Kubernetes on EC2 over EKS |
| [0002: Tucaken Architecture Migration](decisions/0002-tucaken-architecture-migration.md) | Lambda/Step Functions/DynamoDB → Kubernetes-native platform migration rationale and full stack mapping |
| [0003: SSM over CloudFormation Exports](decisions/0003-ssm-over-cloudformation-exports.md) | Why SSM Parameter Store replaces Fn::ImportValue for cross-stack discovery |
| [0004: Crossplane over Terraform Modules](decisions/0004-crossplane-over-terraform-modules.md) | Why Crossplane manages in-cluster AWS resources instead of Terraform |
| [0005: Cognito over Auth0](decisions/0005-cognito-over-auth0.md) | Why Amazon Cognito replaces Auth.js v5 Credentials provider |
| [0006: NLB over EIP-Failover Lambda](decisions/0006-nlb-over-eip-failover-lambda.md) | Why the NLB replaced the Lambda-based EIP failover construct |
| [0010: ALB + Regional WAFv2 Edge over CloudFront and NLB](decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md) | Why the EKS edge is a single internet-facing ALB with SNI certs and a regional WebACL, retiring CloudFront and the NLB |

> **Relocated (2026-06-16):** the GitOps / Argo decisions (ArgoCD Image
> Updater, K8s Job image URIs from ESO ConfigMap, Argo Rollouts Blue/Green)
> moved to [kubernetes-bootstrap](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/tree/main/docs/decisions),
> which owns ArgoCD, Argo Rollouts, and ESO. They documented code that no
> longer lives in this infrastructure repo.

---

## Patterns

| Document | Topic |
|:---------|:------|
| [Project Factory Pattern](patterns/project-factory-pattern.md) | Why the Abstract Factory pattern is used, how it works, and how to add a new project |
| [SSM Cross-Stack Pattern](patterns/ssm-cross-stack-pattern.md) | Using SSM Parameter Store for cross-stack discovery instead of CloudFormation exports |
| [K8s Job Dispatch Pattern](patterns/k8s-job-dispatch.md) | BFF → BatchV1Api pattern: name construction, resource envelope, image URI resolution, test seams |
| [admin-api Test Architecture](patterns/admin-api-test-architecture.md) | ESM mock strategy, JWT stub, test seams for K8s and image cache, repository SQL testing |

---

## Projects

| Document | Topic |
|:---------|:------|
| [cdk-monitoring Platform](projects/cdk-monitoring-platform.md) | **Canonical entry point** — what this repo is, what it owns, stack inventory, sibling repo relationships, deployment topology |
| [CDK Platform Stacks](projects/cdk-platform-stacks.md) | Complete reference for all 16 stacks across kubernetes, shared, and org projects |
| [cdk-governance-aspects](projects/cdk-governance-aspects.md) | Published npm package: DynamoDB read-only enforcement aspect and tagging aspect |
| [Self-Healing Platform](projects/self-healing-platform.md) | Bedrock Agent + AMI Refresh pipelines: failure modes covered, remediation flows, manual intervention points, observability |

---

## Concepts

| Document | Topic |
|:---------|:------|
| [Self-Healing + SSM Integration](concepts/self-healing-ssm-integration.md) | Day-1/Day-2 integration between SSM Bootstrap Automation and Bedrock self-healing pipeline |
| [KB Sync Strategy](concepts/kb-sync-strategy.md) | 4-layer strategy to keep the Knowledge Base in sync with code changes |
| [Monitoring Strategy](concepts/monitoring-strategy.md) | Observability architecture — CloudWatch, Grafana, Prometheus, Loki |
| [CloudWatch Logs Strategy](concepts/cloudwatch-logs-strategy.md) | All CDK-managed log groups, retention tiers, KMS encryption strategy, and SSM-created groups |
| [Security Group Configuration](concepts/security-group-configuration.md) | All six security groups, open ports with rationale, TCP/UDP protocol choices, and admin IP allowlist pattern |
| [ASG Configuration](concepts/asg-configuration.md) | Three-pool ASG architecture, Spot setup, Cluster Autoscaler tags, scaling strategy, IAM policy structure, and 3-layer bootstrap |
| [Launch Template Configuration](concepts/launch-template-configuration.md) | LaunchTemplateConstruct responsibilities, LT↔ASG↔AMI relationships, Golden AMI versioning, IMDSv2, source/dest check workaround, and node launch workflow |
| [NLB Architecture](concepts/nlb-architecture.md) | NLB design, EIP SubnetMapping, CloudFront/admin traffic paths, security group layers, target group health checks, and live state reference |
| [CDK Construct Architecture](concepts/cdk-construct-architecture.md) | L1/L2/L3 layer model, custom L3 constructs, CDK Aspects for governance, compile-time validation patterns, factory pattern, and testing approach |
| [CDK Aspects Governance](concepts/cdk-aspects-governance.md) | Aspects vs constructs, visit() scheduling, TaggingAspect, EnforceReadOnlyDynamoDbAspect token resolution, cdk-nag, published npm package rationale, testing with Annotations API |
| [CloudFront Distribution](concepts/cloudfront-distribution.md) | Dual-origin setup, EIP DNS conversion, origin secret, behavior ordering, cache policies, AUTH_COOKIES, WAF, cross-account DNS validation role, and live state reference |
| [Networking Observability](concepts/networking-observability.md) | VPC Flow Logs, NLB access logs, CloudWatch metrics — full traffic path observability |
| [CloudWatch & Steampipe Data Paths](concepts/cloudwatch-steampipe-data-paths.md) | End-to-end data path from AWS → CloudWatch Logs Insights → Grafana and parallel Steampipe SQL path |
| [CI/CD Pipeline Architecture](concepts/cicd-pipeline-architecture.md) | 11-job pipeline: change detection, Checkov SARIF, actionlint, CDK synth, reusable deploy workflow |
| [Platform RDS + PgBouncer](concepts/platform-rds-pgbouncer.md) | PostgreSQL 16 in SharedVpc, PgBouncer transaction mode, lazy pool singleton, connection budget |
| [IaC Security — Dual-Layer](concepts/iac-security-dual-layer.md) | cdk-nag at synth time + Checkov in CI: complementary roles, skip-check rationale, SARIF integration |
| [FinOps Observability](concepts/finops-observability.md) | admin-api FinOps route: CloudWatch Bedrock metrics, Cost Explorer queries, IAM permissions |
| [Request Lifecycle — Viewer to Pod](concepts/request-lifecycle-viewer-to-pod.md) | End-to-end request path: DNS → CloudFront → WAF → NLB → Traefik → kube-proxy → Pod, with per-hop failure modes |
| [EKS Platform Architecture](concepts/eks-platform-architecture.md) | EKS 1.34 cluster, stack-per-failure-domain decomposition, system MNG + Karpenter node provisioning, Pod Identity over IRSA, and where the ALB edge sits |
| [Karpenter and Pod Identity Provisioning](concepts/karpenter-pod-identity-provisioning.md) | EC2NodeClass/NodePool internals, SQS interruption queue, prune:false rationale, and Pod Identity IAM-to-ServiceAccount association detail |

---

## Tools

| Document | Topic |
|:---------|:------|
| [Checkov IaC Scanner](tools/checkov.md) | Config, 29 custom checks, SARIF upload, CI integration, skip-check rationale |
| [Dependency-Cruiser](tools/dependency-cruiser.md) | Architectural boundary enforcement, error/warn rules, CI integration |

---

## Troubleshooting

| Document | Symptom |
|:---------|:--------|
| [AMI Refresh IAM Permissions](troubleshooting/ami-refresh-iam-permissions.md) | Six-commit IAM debugging series: ec2:RunInstances → CalledVia → PassRole → Describe* → CreateTags |
| [JWT userId Source — Ingestion Security Fix](troubleshooting/jwt-userid-source-security-fix.md) | userId taken from request body allowed impersonation; fix: always read from JWT payload |
| [K8s Bootstrap Failure Modes](troubleshooting/k8s-bootstrap-failure-modes.md) | Missing podSubnet, CCM taint timeout, stale idempotency markers — three SSM Automation failure modes |
| [Karpenter System Pool Pod-Density Starvation](troubleshooting/karpenter-system-pool-pod-density-starvation.md) | System pods Pending with idle CPU — Karpenter is blind to the ENI pod cap; floor instance sizes at t3.large (35 pods) not t3.medium (17) |
| [NLB SG Rule Limit and Route53 A Record Drift](troubleshooting/nlb-sg-rule-limit-and-route53-drift.md) | CloudFront prefix list × 2 ports = 110 rules > 60-rule SG limit; Route53 A record drift after control plane IP change |
| [CloudFormation Rejects $Latest/$Default in ASG LT Version](troubleshooting/cfn-asg-launch-template-version-latest-rejected.md) | CloudFormation hard-rejects $Latest/$Default as ASG LaunchTemplate Version at resource definition level |
| [CloudFront Behaviour First-Match Auth Failure](troubleshooting/cloudfront-behaviour-first-match-auth-failure.md) | /api/auth/* listed after /api/* — auth callbacks matched wrong behaviour, session cookies stripped |
| [etcd Restore SAN Mismatch](troubleshooting/etcd-restore-san-mismatch.md) | API server cert SANs reference old IP after cross-AZ control plane migration |
| [CDK valueFromLookup vs fromSsmParameter](troubleshooting/cdk-value-from-lookup-vs-ssm-parameter.md) | valueFromLookup() bakes AMI at synth time, breaks CI --no-lookups; use fromSsmParameter() instead |
| [CloudFront OriginRequestPolicy Blocks Authorization Header](troubleshooting/cloudfront-authorization-header-origin-request-policy.md) | UnscopedValidationError — Authorization must go in CachePolicy with TTL=0, not OriginRequestPolicy |
| [CloudFront OriginRequestPolicy 10-Cookie Limit](troubleshooting/cloudfront-origin-request-policy-10-cookie-limit.md) | Adding Cognito cookies exceeded 10-cookie hard limit; trailing cookies silently dropped |
| [CDK LaunchTemplate.launchTemplateName Always Undefined](troubleshooting/cdk-launch-template-name-undefined.md) | CDK L2 LaunchTemplate.launchTemplateName is always undefined — build concrete name string directly |
| [NLB Target Registration Propagation Delay](troubleshooting/nlb-target-registration-propagation-delay.md) | Integration tests fail after Spot replacement — new instance absent from DescribeTargetHealth for up to 2.5 min |
| [RDS allowMajorVersionUpgrade Required](troubleshooting/rds-allow-major-version-upgrade.md) | CloudFormation blocks PostgreSQL major version upgrade without allowMajorVersionUpgrade: true |
| [CDK Aspects Validation Failures](troubleshooting/cdk-aspects-validation-failures.md) | AwsSolutions-L1 on framework Lambdas, AwsSolutions-IAM5 wildcards, EnforceReadOnlyDynamoDb false positives, suppression recipes |
| [Traefik Rejects All Requests — X-CloudFront-Origin-Secret Mismatch](troubleshooting/traefik-origin-secret-rejection.md) | 502 at CloudFront while NLB is healthy; secret mismatch between SSM/CloudFront and Traefik HeadersRegexp; 4-step atomic rotation |
| [Calico VXLAN Cross-Node Pod Communication Failure](troubleshooting/calico-vxlan-cross-node-failure.md) | Cross-node pods time out while same-node pods succeed; UDP 4789 blocked by SG; diagnosis via VPC Flow Logs + SG audit |
| [PgBouncer Rejects TLS — SSL Connection Failure](troubleshooting/pgbouncer-ssl-connection-failure.md) | `ssl: { rejectUnauthorized: false }` triggers TLS handshake with plain-TCP PgBouncer; drop `ssl` key entirely |
| [CloudFront Rejects Raw EIP as Origin Domain](troubleshooting/cloudfront-eip-raw-ip-as-origin.md) | CloudFront requires EC2 DNS hostname not raw IP; VPC must have DNS Hostnames enabled |
| [cdk-nag COG8 — Cognito AdvancedSecurityMode Deprecated](troubleshooting/cognito-advanced-security-mode-cog8-failure.md) | `AdvancedSecurityMode.ENFORCED` deprecated; migrate to `featurePlan: FeaturePlan.PLUS` + `standardThreatProtectionMode` |
| [GITHUB_OUTPUT Rejects Multi-line aws-cli JSON](troubleshooting/github-output-multiline-value-invalid-format.md) | `aws --output json` is pretty-printed; pipe through `jq -c '.'` before writing to GITHUB_OUTPUT |
| [CloudFormation Execution Role Missing Service / Non-ASCII SG Description](troubleshooting/cfn-exec-role-missing-service-permissions.md) | Stack rollback on new service deploy (add to CDKCloudFormationEx.json + bootstrap); em dash in SG description causes HTTP 400 |
| [The Public Edge is the ALB, not CloudFront](troubleshooting/edge-is-alb-not-cloudfront.md) | Stale CloudFront comments/SG residue mislead edge debugging; the live edge is the internet-facing ALB + regional WAFv2 — diagnosis commands |

---

## Runbooks

| Runbook | Scenario |
|:--------|:---------|
| [Creating a New CDK Construct](runbooks/creating-a-new-cdk-construct.md) | Domain placement, props interface, inline defaults, validation, exports, unit test boilerplate |
| [Creating a New Stack](runbooks/creating-a-new-stack.md) | Step-by-step guide for adding a new CDK stack or project |
| [Bootstrap Deadlock — CCM](runbooks/bootstrap-deadlock-ccm.md) | Resolve Cloud Controller Manager deadlock during cluster bootstrap |
| [Cross-AZ Recovery](runbooks/cross-az-recovery.md) | Recover cluster state after an AZ failure |
| [GitHub Workflow Dispatch](runbooks/gh-workflow-dispatch.md) | Manual `gh workflow run` reference for all project pipelines |
| [EKS Dev Start/Stop and Restore Order](runbooks/eks-dev-start-stop-restore.md) | Manual start/stop of the dev cluster and the correct MNG → Karpenter → ArgoCD restore sequence |

---

## Plans (Active)

| Plan | Phase |
|:-----|:------|
| [Phase 1 — Platform RDS](plans/2026-04-24-phase1-platform-rds.md) | Provision PostgreSQL in SharedVpc |
| [Phase 2 — Content Migration](plans/2026-04-24-phase2-content-migration.md) | DynamoDB → RDS data migration |
| [Phase 5 — Destroy Runbook](plans/2026-04-28-phase5-destroy-runbook.md) | Decommission legacy DynamoDB stacks |

