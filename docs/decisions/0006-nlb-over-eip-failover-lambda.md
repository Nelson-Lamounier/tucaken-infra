---
title: "ADR-005: NLB over EIP-Failover Lambda"
type: decision
tags: [aws-nlb, elastic-ip, lambda, failover, kubernetes, networking, ec2]
sources:
  - infra/lib/constructs/networking/elb/network-load-balancer.ts
  - infra/lib/stacks/kubernetes/base-stack.ts
  - infra/dist/lib/constructs/compute/constructs/eip-failover.d.ts
created: 2026-04-28
updated: 2026-04-28
---

## Status

**Superseded (2026-05)** by the EKS migration — the public edge is now an
internet-facing ALB with a regional WAFv2 WebACL, not an NLB carrying the cluster
EIP. See [ADR-0010: ALB + regional WAFv2 edge over CloudFront and NLB](0010-alb-wafv2-edge-over-cloudfront-nlb.md).
The NLB existed to bind the EIP for a self-managed control plane; EKS manages its
own control-plane endpoint, so the EIP/NLB binding is no longer required.

This decision (NLB over the EIP-failover Lambda) was correct for the kubeadm era
and is retained as decision history. Original record below.

Originally: Accepted — implemented in `KubernetesBaseStack`
(`infra/lib/stacks/kubernetes/base-stack.ts:350-413`).
`EipFailoverConstruct` is deprecated and retained only in the compiled `dist/`
directory (`infra/dist/lib/constructs/compute/constructs/eip-failover.d.ts`);
its source has been deleted.

## Context

The Kubernetes cluster needs a stable, internet-accessible IP for two traffic
paths:

1. **CloudFront → K8s** — CloudFront's EIP origin points to a static IP to
   route `nelsonlamounier.com` traffic to Traefik HTTP port 80.
2. **Admin access → K8s** — `ops.nelsonlamounier.com` resolves to the same EIP,
   hitting Traefik HTTPS port 443 (ArgoCD, Grafana, cluster ops).

An Elastic IP was the natural choice for the stable IP — it survives EC2
instance replacement and requires no DNS or CloudFront reconfiguration.

### Prior implementation — EipFailoverConstruct

The original design attached the EIP directly to the EC2 instance that ran
Traefik. A Python Lambda (`eip-failover/index.py`) watched all ASG lifecycle
events via EventBridge and re-associated the EIP to the new instance on LAUNCH
and TERMINATE. Role filtering via the `k8s:bootstrap-role` tag ensured only
eligible nodes (those with the ingress SG) received the EIP.

**Problems with this approach:**

| Problem | Impact |
|:--------|:-------|
| Only one instance can hold the EIP at a time | No active-active load distribution across workers |
| EventBridge → Lambda re-association takes 10-30 seconds | Traffic drops during instance replacement |
| Lambda failure or IAM misconfiguration = silent single-target lock | No operational alert path |
| `k8s:bootstrap-role` filter logic maintained in Python Lambda, separate from CDK | Drift risk if roles change |
| Health-check-based failover is entirely absent | A hung instance (process crashed, not terminated) retains the EIP indefinitely |

The last problem was the critical one: if Traefik crashed on the instance holding
the EIP but the EC2 instance remained running, the Lambda never fired and traffic
was permanently dead. TCP health checks would not drive any re-routing.

## Decision

Replace `EipFailoverConstruct` with a Network Load Balancer. The EIP is attached
to the NLB via L1 SubnetMapping (`CfnLoadBalancer.subnetMappings`) instead of
directly to an instance. Both worker ASGs register with two TCP target groups
(port 80 and port 443). The NLB uses TCP health checks on port 80 and
automatically routes around unhealthy targets without any Lambda or EventBridge
involvement.

CloudFront and `ops.nelsonlamounier.com` DNS continue to point to the same EIP —
no CloudFront origin changes, no DNS TTL flush, no external impact.

## Consequences

### Positive

- **Health-check-based failover** — TCP health checks on port 80 detect crashed
  processes within 90 seconds (3 × 30s interval). Traffic re-routes to the
  surviving healthy target automatically.
- **Active-active** — both `general-worker` and `monitoring-worker` nodes serve
  traffic simultaneously from both target groups. No single bottleneck.
- **Lambda eliminated** — no EventBridge → Lambda path, no Python deployment,
  no IAM permission to manage EIP associations.
- **EIP migration-free** — the EIP (`eipalloc-00dbdd23577499804`, IP
  `52.18.73.218`) moved from direct instance attachment to the NLB without
  changing the public IP. CloudFront and DNS records were not touched.
- **Stickiness off (intentional)** — `TargetGroupStickinessConfig.Enabled: false`
  means each TCP connection is independently routed to a healthy target. No
  session affinity needed: Traefik routes by Host header, Kubernetes has no
  server-side session state on the ingress path.

### Negative / Tradeoffs

- **Single-AZ NLB** — the NLB is placed in `eu-west-1a` only, matching the EBS
  volume AZ for cost optimisation. An AZ failure that kills `eu-west-1a` also
  kills the NLB. Acceptable for a solo-developer platform; the runbook for
  cross-AZ recovery is documented separately.
- **Cross-zone disabled** — `crossZoneEnabled: false` (default). If one AZ has
  all targets in one target group and none in another, the NLB will not route
  cross-AZ. Currently not an issue because both workers are in `eu-west-1a`.
- **NLB cannot filter by application payload** — the NLB is Layer 4 TCP
  passthrough. CloudFront WAF filtering must be done at the CF distribution, not
  at the NLB. IP-based access control for admin routes is enforced at the
  instance-level Ingress SG and Traefik middleware.
- **60-rule SG limit** — using the CloudFront origin-facing prefix list
  (`pl-4fa04526`, ~55 MaxEntries) for port 443 would push the NLB SG past the
  60-rule limit (55 + 55 = 110 effective rules). Port 443 is therefore open to
  `0.0.0.0/0` at the NLB layer; filtering is delegated to the Ingress SG.

## Alternatives considered

### Keep EipFailoverConstruct, add TCP health check before re-association

This would address the hung-process problem by polling TCP health before
deciding which instance to give the EIP to. The operational complexity and
latency of re-association (~15-30s) remained. It would also still be single-target
with the Lambda as a single point of failure. Rejected.

### Use an Application Load Balancer (ALB) with CloudFront

An ALB operates at Layer 7 and can terminate TLS, inspect headers, and apply
WAF rules directly. It cannot attach an EIP — ALBs only have dynamic DNS names.
Switching to an ALB would require CloudFront to resolve the ALB DNS name
dynamically, breaking the static-IP requirement for CloudFront's EIP origin and
`ops.nelsonlamounier.com`. Rejected.

### Replace EIP with CloudFront-only (no NLB for admin access)

Routing admin access (`ops.*`) through CloudFront would remove the NLB
dependency for that path, but it would require TLS termination at CloudFront for
HTTPS routes and add CloudFront caching complexity to ArgoCD and Grafana (both of
which use WebSocket connections that CloudFront requires explicit policy support
for). Rejected at this stage; could be revisited if WAF requirements increase.

## Related

- [Concept: NLB Architecture](../concepts/nlb-architecture.md)
- [Runbook: Cross-AZ Recovery](../runbooks/cross-az-recovery.md)
- [Concept: Security Group Configuration](../concepts/security-group-configuration.md)

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/base-stack.ts:330-413 (read on 2026-04-28)
- Source: infra/lib/constructs/networking/elb/network-load-balancer.ts (read on 2026-04-28)
- Source: infra/dist/lib/constructs/compute/constructs/eip-failover.d.ts (read on 2026-04-28)
- Live: aws elbv2 describe-load-balancers (run on 2026-04-28) — NLB active, EIP 52.18.73.218 attached
- Live: aws elbv2 describe-target-health — both targets healthy, i-0580b8816ebdc4ba4 and i-04280807549995d50
-->
