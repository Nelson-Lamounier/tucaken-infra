---
title: ALB + regional WAFv2 edge over CloudFront and NLB
type: decision
tags: [aws, eks, alb, wafv2, cloudfront, acm, sni, edge, networking, security]
sources:
  - infra/lib/stacks/kubernetes/eks-alb-certs-stack.ts
  - infra/lib/stacks/kubernetes/eks-public-waf-stack.ts
  - infra/lib/constructs/security/eks-public-waf.ts
  - docs/decisions/0006-nlb-over-eip-failover-lambda.md
created: 2026-06-16
updated: 2026-06-16
---

## Context

Before the EKS migration the public edge was a layered stack: CloudFront (global
CDN + edge WAF) in front of a Network Load Balancer, which forwarded to Traefik
running on self-managed kubeadm nodes. The NLB carried the cluster Elastic IP via
`SubnetMapping` ([ADR-006](0006-nlb-over-eip-failover-lambda.md)), and an S3
assets bucket was served through a CloudFront Origin Access Control grant.

The migration to Amazon EKS replaced node provisioning with Karpenter and adopted
the AWS Load Balancer Controller, which provisions an Application Load Balancer
directly from Kubernetes `Ingress` resources. That made the CloudFront + NLB +
Traefik edge redundant: the ALB is the natural entry point for an EKS workload,
and per-host routing, TLS, and WAF can all attach to it.

## Decision

The public edge is a single internet-facing **Application Load Balancer**,
provisioned by the AWS Load Balancer Controller, with:

- **TLS via SNI** — one ACM wildcard certificate per apex domain
  (`*.nelsonlamounier.com` and `*.tucaken.io`, each plus the apex), all attached
  to the shared ALB; the controller serves the correct certificate per `Host`
  ([eks-alb-certs-stack.ts](../../infra/lib/stacks/kubernetes/eks-alb-certs-stack.ts)).
- **A regional WAFv2 WebACL** attached to the ALB, whose ARN is published to SSM
  at `${ssmPrefix}/eks/waf-acl-arn`; workload `Ingress` resources opt in with the
  `alb.ingress.kubernetes.io/wafv2-acl-arn` annotation
  ([eks-public-waf-stack.ts](../../infra/lib/stacks/kubernetes/eks-public-waf-stack.ts)).

CloudFront is retired entirely. Verified on 2026-06-16 that no CloudFront
distribution exists in the account (`aws cloudfront list-distributions` returned
`null`) and the only internet-facing load balancer is the ALB
`k8s-public-f8655bfb7e` (`aws elbv2 describe-load-balancers`).

## WAF rule shape

The WebACL is host-scoped with a default `ALLOW`
([eks-public-waf.ts](../../infra/lib/constructs/security/eks-public-waf.ts)):

- Hosts in `allowlistedHosts` (e.g. `admin.*`, `ops.*`) are reachable only from
  the configured `allowlistedIpv4` / `allowlistedIpv6` CIDRs.
- Hosts in `rateLimitedHosts` (e.g. `api.*`) get a per-IP rate limit.
- Every host inherits the AWS Managed Rule Sets (Common, Known Bad Inputs).

Allowlist CIDRs are **not** baked into the template at synth time. The IP sets are
created empty and an `IpSyncFn` Lambda populates them from SSM parameters after
deploy; changing an SSM parameter triggers the Lambda via EventBridge within
seconds, with no CDK redeploy
([eks-public-waf-stack.ts](../../infra/lib/stacks/kubernetes/eks-public-waf-stack.ts);
commit `804c30cb` "remove synth-time IP baking — Lambda owns IP set content from
SSM").

## Alternatives considered

- **Keep CloudFront in front of the ALB.** Rejected for the dev/prod single
  account: there is no global-audience or static-cache requirement that justifies
  the second edge tier, the extra ACM certificate in `us-east-1`, and the
  origin-shielding complexity. The ALB already terminates TLS and hosts the WAF.
- **Keep the NLB edge.** Rejected: the NLB existed to carry the cluster EIP for a
  self-managed control plane ([ADR-006](0006-nlb-over-eip-failover-lambda.md)).
  EKS manages its own control-plane endpoint, so the EIP/NLB binding is no longer
  needed, and an L4 NLB cannot do host-based routing or attach a WAFv2 WebACL.
- **Regional WAF on API Gateway only.** Rejected as the *sole* control: the ALB
  fronts all public hosts, so the WebACL belongs there; API Gateway can set
  `skipWaf` when the upstream ALB WAF already covers it.

## Consequences

- **Supersedes the edge half of [ADR-006](0006-nlb-over-eip-failover-lambda.md)**
  and retires CloudFront. ADR-006 remains as decision history for the kubeadm era.
- The shared ALB is a single failure domain for all public ingress; per-host
  isolation is enforced at the WebACL, not by separate load balancers.
- Wildcard-per-apex SNI means adding a new apex domain requires a new ACM
  certificate in `eks-alb-certs-stack`, not a CloudFront alias change.
- Residual CloudFront artefacts (an S3 OAC bucket policy, SG prefix-list rules,
  stale comments) were removed from `data-stack` and `api-stack`; `base-stack`
  still carries kubeadm-era vestiges pending a separate decommission.

## Deeper detail

- [EKS platform architecture](../concepts/eks-platform-architecture.md)
  — cluster, node provisioning, Pod Identity, and where the edge stacks sit
- [The edge is the ALB, not CloudFront](../troubleshooting/edge-is-alb-not-cloudfront.md)
  — diagnosing requests against the current edge and reading stale CloudFront comments

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/eks-alb-certs-stack.ts (read 2026-06-16)
- Source: infra/lib/stacks/kubernetes/eks-public-waf-stack.ts (read 2026-06-16)
- Source: infra/lib/constructs/security/eks-public-waf.ts (read 2026-06-16)
- Source: docs/decisions/0006-nlb-over-eip-failover-lambda.md (referenced 2026-06-16)
- Live: aws cloudfront list-distributions --profile dev-account (run 2026-06-16) — null
- Live: aws elbv2 describe-load-balancers --profile dev-account --region eu-west-1 (run 2026-06-16) — k8s-public-f8655bfb7e internet-facing active
- Git: 804c30cb "feat(waf): remove synth-time IP baking", f3460216 WAFv2, f172e05c Plan 5b
-->
