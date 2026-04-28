# Documentation Index

> Platform infrastructure docs only. Kubernetes operational guides live in
> [kubernetes-bootstrap/docs](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/tree/main/docs).
> AI pipeline docs live in [ai-applications/docs](https://github.com/Nelson-Lamounier/ai-applications/tree/main/docs).

---

## Architecture Decision Records

| ADR | Decision |
|:----|:---------|
| [ADR-001: Self-Managed K8s vs EKS](adrs/0001-self-managed-k8s-vs-eks.md) | Why self-managed Kubernetes on EC2 over EKS |
| [ADR-002: SSM over CloudFormation Exports](adrs/0002-ssm-over-cloudformation-exports.md) | Why SSM Parameter Store replaces Fn::ImportValue for cross-stack discovery |
| [ADR-003: Crossplane over Terraform Modules](adrs/0003-crossplane-over-terraform-modules.md) | Why Crossplane manages in-cluster AWS resources instead of Terraform |
| [ADR-004: Cognito over Auth0](adrs/0004-cognito-over-auth0.md) | Why Amazon Cognito replaces Auth.js v5 Credentials provider |
| [ADR-005: NLB over EIP-Failover Lambda](adrs/0005-nlb-over-eip-failover-lambda.md) | Why the NLB replaced the Lambda-based EIP failover construct |
| [ADR-006: GitOps over Direct K8s Deploy](adrs/0006-gitops-over-direct-k8s-deploy.md) | Why ArgoCD Image Updater replaced the k8s-runner deploy job |
| [ADR-007: K8s Job Images from ConfigMap Files](adrs/0007-k8s-job-images-from-configmap-files.md) | Why Job image URIs are read from filesystem paths instead of env vars |
| [ADR-008: Argo Rollouts Blue/Green with Prometheus Analysis](adrs/0008-argo-rollouts-blue-green-prometheus.md) | Why Argo Rollouts drives Blue/Green with Prometheus pre-promotion gates |

---

## Decisions

| Document | Topic |
|:---------|:------|
| [Tucaken Architecture Migration](decisions/0002-tucaken-architecture-migration.md) | Lambda/Step Functions/DynamoDB → Kubernetes-native platform migration rationale and full stack mapping |

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
| [CDK Platform Stacks](projects/cdk-platform-stacks.md) | Complete reference for all 16 stacks across kubernetes, shared, and org projects |
| [admin-api BFF](projects/admin-api.md) | Hono BFF serving start-admin: Cognito JWKS auth, K8s Job dispatch, PgBouncer, FinOps route |
| [cdk-governance-aspects](projects/cdk-governance-aspects.md) | Published npm package: DynamoDB read-only enforcement aspect and tagging aspect |

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
| [CloudFront Distribution](concepts/cloudfront-distribution.md) | Dual-origin setup, EIP DNS conversion, origin secret, behavior ordering, cache policies, AUTH_COOKIES, WAF, cross-account DNS validation role, and live state reference |
| [Networking Observability](concepts/networking-observability.md) | VPC Flow Logs, NLB access logs, CloudWatch metrics — full traffic path observability |
| [CloudWatch & Steampipe Data Paths](concepts/cloudwatch-steampipe-data-paths.md) | End-to-end data path from AWS → CloudWatch Logs Insights → Grafana and parallel Steampipe SQL path |
| [CI/CD Pipeline Architecture](concepts/cicd-pipeline-architecture.md) | 11-job pipeline: change detection, Checkov SARIF, actionlint, CDK synth, reusable deploy workflow |
| [Platform RDS + PgBouncer](concepts/platform-rds-pgbouncer.md) | PostgreSQL 16 in SharedVpc, PgBouncer transaction mode, lazy pool singleton, connection budget |
| [IaC Security — Dual-Layer](concepts/iac-security-dual-layer.md) | cdk-nag at synth time + Checkov in CI: complementary roles, skip-check rationale, SARIF integration |
| [FinOps Observability](concepts/finops-observability.md) | admin-api FinOps route: CloudWatch Bedrock metrics, Cost Explorer queries, IAM permissions |

---

## Tools

| Document | Topic |
|:---------|:------|
| [Cognito JWKS Middleware](tools/cognito-jwks-middleware.md) | `jose`-based JWKS bearer token validation, per-pool cache, kid rotation, /healthz exemption |
| [Hono BFF Framework](tools/hono-bff.md) | Port split, credential model (IMDS/Secret/ConfigMap), CORS rationale, middleware chain |
| [Checkov IaC Scanner](tools/checkov.md) | Config, 29 custom checks, SARIF upload, CI integration, skip-check rationale |
| [Dependency-Cruiser](tools/dependency-cruiser.md) | Architectural boundary enforcement, error/warn rules, CI integration |

---

## Troubleshooting

| Document | Symptom |
|:---------|:--------|
| [AMI Refresh IAM Permissions](troubleshooting/ami-refresh-iam-permissions.md) | Six-commit IAM debugging series: ec2:RunInstances → CalledVia → PassRole → Describe* → CreateTags |
| [JWT userId Source — Ingestion Security Fix](troubleshooting/jwt-userid-source-security-fix.md) | userId taken from request body allowed impersonation; fix: always read from JWT payload |

---

## Runbooks

| Runbook | Scenario |
|:--------|:---------|
| [Creating a New Stack](runbooks/creating-a-new-stack.md) | Step-by-step guide for adding a new CDK stack or project |
| [Bootstrap Deadlock — CCM](runbooks/bootstrap-deadlock-ccm.md) | Resolve Cloud Controller Manager deadlock during cluster bootstrap |
| [Cross-AZ Recovery](runbooks/cross-az-recovery.md) | Recover cluster state after an AZ failure |
| [GitHub Workflow Dispatch](runbooks/gh-workflow-dispatch.md) | Manual `gh workflow run` reference for all project pipelines |

---

## Plans (Active)

| Plan | Phase |
|:-----|:------|
| [Phase 1 — Platform RDS](plans/2026-04-24-phase1-platform-rds.md) | Provision PostgreSQL in SharedVpc |
| [Phase 2 — Content Migration](plans/2026-04-24-phase2-content-migration.md) | DynamoDB → RDS data migration |
| [Phase 5 — Destroy Runbook](plans/2026-04-28-phase5-destroy-runbook.md) | Decommission legacy DynamoDB stacks |

