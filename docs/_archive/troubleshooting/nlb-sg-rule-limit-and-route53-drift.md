---
title: NLB Security Group Rule Limit and Route53 A Record Drift
type: troubleshooting
tags: [aws-cdk, nlb, security-groups, route53, cloudfront, networking]
sources:
  - infra/lib/constructs/networking/elb/network-load-balancer.ts
  - infra/lib/stacks/kubernetes/base-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the pre-EKS public edge (CloudFront / NLB / Traefik), retired in the kubeadm to Amazon EKS migration. The edge is now a single internet-facing ALB with a regional WAFv2 WebACL ([ADR-0010](../../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md)); see [EKS platform architecture](../../concepts/eks-platform-architecture.md). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

Two distinct deployment failures that occurred together in the same
CloudFormation stack update (commit `cde0166f`):

**SG rule limit:** Stack update fails with:
```
The maximum number of rules per security group has been reached.
```

**Route53 drift:** Stack update fails with:
```
values provided do not match
```
on the Route53 A record for the control plane API endpoint, even though
the stack was unchanged since the last successful deploy.

## Root cause

### SG rule limit — CloudFront prefix list × 2 ports

The CloudFront managed prefix list (`pl-4fa04526`) expands to approximately
55 individual IP ranges at the security group rule level. Adding this prefix
list as an inbound rule for both port 80 and port 443 consumes
55 + 55 = 110 effective rule slots against a hard AWS limit of 60 rules per
security group.

The April 9 deployment failed with the exact error above after the NLB
security group added port 443 restricted to the CF prefix list — pushing the
rule count over the limit (commit `cde0166f`).

### Route53 A record drift — Day-0 placeholder overwritten at runtime

CDK writes a placeholder IP (`10.0.0.1`) into the Route53 A record for the
control plane API endpoint at Day-0 (first bootstrap). On first boot, the
control plane instance self-registers its real IP via an SSM Run Command step
that calls `route53.change_resource_record_sets()` with the actual private IP.

On the next CDK stack deploy, CloudFormation attempted to delete the old
record using the placeholder value (`10.0.0.1`) — which no longer matched
the live record value (e.g. `10.0.0.33`) — and failed with the "values do
not match" error. This is a day-2 failure that does not appear until after
the first control plane bootstrap.

## How to diagnose

**SG rule limit:**
```bash
# Count effective rules including prefix list expansion
aws ec2 describe-security-groups \
  --group-ids <nlb-sg-id> \
  --query 'SecurityGroups[0].IpPermissions | length(@)' \
  --profile dev-account

# Check the CloudFront prefix list max entries
aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-id,Values=pl-4fa04526 \
  --query 'PrefixLists[0].MaxEntries' \
  --profile dev-account
```

**Route53 drift:**
```bash
# Check the live record value
aws route53 list-resource-record-sets \
  --hosted-zone-id <zone-id> \
  --query 'ResourceRecordSets[?Name==`k8s-api.k8s.internal.`]'

# Compare to what CDK has in cdk.out
grep -r "10.0.0" cdk.out/
```

## How to fix

### SG rule limit fix

Keep port 443 open to `anyIpv4`/`anyIpv6` at the NLB layer. Fine-grained
access restriction is enforced by the Kubernetes node ingress security group
(admin IP allowlist), not by the NLB SG. Port 80 stays restricted to the
CloudFront prefix list to block HTTP scanners
([`network-load-balancer.ts`](../../../infra/lib/constructs/networking/elb/network-load-balancer.ts)).

```typescript
// Port 443 — open at NLB layer, K8s node SG enforces allowlist downstream
nlbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS - filtered by K8s ingress SG');
nlbSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS IPv6 - filtered by K8s ingress SG');

// Port 80 — still restricted to CloudFront prefix list
nlbSg.addIngressRule(ec2.Peer.prefixList('pl-4fa04526'), ec2.Port.tcp(80), 'HTTP CloudFront only');
```

### Route53 drift fix

Replace the CDK L2 `ARecord` with a `CfnRecordSet` using the actual live
IP, and apply a `RETAIN` removal policy. The control plane is the authoritative
owner of this record after Day-0; CDK only seeds it
([`base-stack.ts`](../../../infra/lib/stacks/kubernetes/base-stack.ts)).

```typescript
const cpRecord = new route53.CfnRecordSet(this, 'ControlPlaneRecord', {
  hostedZoneId: hostedZone.hostedZoneId,
  name: 'k8s-api.k8s.internal.',
  type: 'A',
  ttl: '60',
  resourceRecords: ['10.0.0.33'], // actual live IP, not placeholder
});
cpRecord.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
```

Add a trailing dot to the FQDN — Route53 requires the canonical form.

## How to prevent

- **Never use the CloudFront prefix list for multiple ports on the same SG.**
  Each port binding with the prefix list expands to ~55 rules. Two ports
  = 110, which exceeds the 60-rule limit. Use the prefix list only for
  port 80; leave port 443 open with downstream SG enforcement.

- **RETAIN removal policy on any record co-owned by runtime automation.**
  Any Route53 record that a bootstrap script or Lambda may update after
  CDK creates it should use `RemovalPolicy.RETAIN` to prevent drift-based
  deployment failures.

- **Document the live IP as a comment or in SSM** so operators can update
  the CDK source when the control plane instance is replaced.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/constructs/networking/elb/network-load-balancer.ts (read on 2026-04-29)
- Source: infra/lib/stacks/kubernetes/base-stack.ts (referenced via commit cde0166f on 2026-04-29)
- Commit: cde0166f — "fix(infra): resolve NLB SG rule limit and Route53 A record drift" (read on 2026-04-29)
-->
