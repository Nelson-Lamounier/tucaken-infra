---
title: The public edge is the ALB, not CloudFront
type: troubleshooting
tags: [eks, alb, cloudfront, wafv2, edge, networking, debugging]
sources:
  - infra/lib/stacks/kubernetes/eks-public-waf-stack.ts
  - infra/lib/stacks/kubernetes/base-stack.ts
  - infra/lib/stacks/kubernetes/api-stack.ts
created: 2026-06-16
updated: 2026-06-16
---

## Symptom

While debugging public traffic, TLS, or WAF behaviour, the codebase still
mentions CloudFront — a "CloudFront edge WAF" comment in the API stack, a
CloudFront origin-facing prefix list in the base stack security group, an S3
Origin Access Control policy in the data stack. This suggests a CloudFront
distribution fronts the platform. It does not.

## Root cause

CloudFront was retired during the EKS migration. The public edge is now a single
internet-facing Application Load Balancer provisioned by the AWS Load Balancer
Controller (see
[ADR-0010](../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md)). The
remaining CloudFront references are stale residue from the kubeadm-era
CloudFront + NLB + Traefik edge, not live infrastructure:

- `base-stack` keeps a security-group rule allowing the
  `com.amazonaws.global.cloudfront.origin-facing` managed prefix list — from the
  old Traefik ingress path
  ([base-stack.ts](../../infra/lib/stacks/kubernetes/base-stack.ts)).
- `api-stack` previously carried comments claiming a CloudFront edge WAF protected
  the API; the actual WAF is the regional WebACL on the shared ALB
  ([api-stack.ts](../../infra/lib/stacks/kubernetes/api-stack.ts)).
- `data-stack` previously granted the `cloudfront.amazonaws.com` service principal
  read on the assets bucket via OAC; that grant was removed because no
  distribution exists to use it.

## Diagnosis

Confirm what is actually serving the edge:

```bash
# Are there any CloudFront distributions? (global service, no region flag)
aws cloudfront list-distributions \
  --query 'DistributionList.Items[].{id:Id,aliases:Aliases.Items}'
# Expected: null  → no CloudFront exists

# What internet-facing load balancer fronts the cluster?
aws elbv2 describe-load-balancers --region eu-west-1 \
  --query 'LoadBalancers[?Scheme==`internet-facing`].{name:LoadBalancerName,dns:DNSName}'
# Expected: the k8s-public-* ALB

# What WebACL is attached to the ALB? Its ARN is published to SSM.
aws ssm get-parameter --region eu-west-1 \
  --name "/k8s/development/eks/waf-acl-arn" --query 'Parameter.Value'
```

On 2026-06-16 the first command returned `null` and the second returned the
internet-facing ALB `k8s-public-f8655bfb7e`.

## Fix

There is nothing to fix at runtime — the ALB edge is correct and working. When
the stale CloudFront comments cause confusion:

1. Treat any in-code reference to a "CloudFront edge" in the kubernetes stacks as
   historical unless a distribution actually appears in `list-distributions`.
2. Read WAF behaviour from `eks-public-waf-stack` and its WebACL, not from API
   Gateway comments
   ([eks-public-waf-stack.ts](../../infra/lib/stacks/kubernetes/eks-public-waf-stack.ts)).
3. The remaining `base-stack` CloudFront prefix-list rule is part of the broader
   kubeadm-era decommission still pending; do not assume it implies a live
   CloudFront origin.

## Prevention

Keep the architecture docs the source of truth for the edge
([ADR-0010](../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md),
[EKS platform architecture](../concepts/eks-platform-architecture.md)) and remove
stale CloudFront comments when touching the affected stacks.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/eks-public-waf-stack.ts (read 2026-06-16)
- Source: infra/lib/stacks/kubernetes/base-stack.ts (read 2026-06-16)
- Source: infra/lib/stacks/kubernetes/api-stack.ts (read 2026-06-16)
- Live: aws cloudfront list-distributions (run 2026-06-16) — null
- Live: aws elbv2 describe-load-balancers (run 2026-06-16) — k8s-public-f8655bfb7e internet-facing
-->
