---
title: CloudFront Rejects Raw IP Address as Origin — Convert EIP to EC2 Public DNS Hostname
type: troubleshooting
tags: [cloudfront, eip, vpc, dns, aws-cdk, edge-stack]
sources:
  - infra/lib/stacks/kubernetes/edge-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

CloudFront distribution creation or update fails with an error indicating
the origin domain name is invalid. Alternatively, the CloudFront distribution
is created but requests to the distribution time out or return 5xx errors
because CloudFront cannot resolve the origin.

The EdgeStack CDK deployment fails at the CloudFront distribution construct
with an error similar to:

```
The parameter Origin DomainName does not refer to a valid domain name.
```

## Root cause

CloudFront does not accept raw IP addresses as origin domain names. The
`EdgeStack` configures an Elastic IP (EIP) as the origin for the
`ops.nelsonlamounier.com` admin subdomain. An EIP in eu-west-1 looks like
`1.2.3.4` — a raw IPv4 address.

CloudFront requires a valid hostname. Every EIP in AWS has an auto-assigned
EC2 public DNS hostname with the format:

```
ec2-<a>-<b>-<c>-<d>.<region>.compute.amazonaws.com
```

Where `<a>-<b>-<c>-<d>` is the IP with dots replaced by hyphens. This
hostname resolves to the same IP address.

The `EdgeStack` converts the EIP to its EC2 DNS hostname using a CDK
`Fn.join` transformation at synthesis time
([`edge-stack.ts:443-447`](../../infra/lib/stacks/kubernetes/edge-stack.ts#L443)):

```typescript
const eipDnsName = cdk.Fn.join('', [
    'ec2-',
    cdk.Fn.join('-', cdk.Fn.split('.', eipAddress)),
    `.${ssmRegion}.compute.amazonaws.com`,
]);
```

If `eipAddress` is not a valid IPv4 address (e.g. still a placeholder or
an SSM lookup failure), the constructed hostname will be malformed and
CloudFront will reject it.

## Second failure mode — VPC DNS Hostnames disabled

AWS only assigns the `ec2-x-x-x-x.region.compute.amazonaws.com` hostname
to an EC2 instance if the VPC has **DNS Hostnames** enabled (`enableDnsHostnames = true`).

Without DNS Hostnames, the instance has no public hostname. The EIP→hostname
conversion in `edge-stack.ts` produces a hostname that does not resolve in
DNS, causing CloudFront to fail all origin requests.

The SharedVpc in eu-west-1 is imported via `Vpc.fromLookup` in `BaseStack`
and is not managed by CDK. The DNS Hostnames setting must be enabled
manually in the AWS Console or via CLI on the imported VPC
([`edge-stack.ts:438-442`](../../infra/lib/stacks/kubernetes/edge-stack.ts#L438)):

```
PREREQUISITE: The VPC in eu-west-1 MUST have "DNS Hostnames" enabled
(enableDnsHostnames = true). Without it, AWS does not assign the
ec2-x-x-x-x.region.compute.amazonaws.com hostname and CloudFront
will fail to resolve the origin.
```

## How to diagnose

```bash
# Verify the EIP is assigned and get the address
aws ec2 describe-addresses \
  --filters Name=tag:Name,Values="*k8s*" \
  --query 'Addresses[*].{IP:PublicIp,AssociationId:AssociationId}' \
  --profile dev-account \
  --region eu-west-1

# Verify the VPC has DNS Hostnames enabled
aws ec2 describe-vpcs \
  --filters Name=tag:Name,Values="*SharedVpc*" \
  --query 'Vpcs[*].{VpcId:VpcId,DnsHostnames:EnableDnsHostnames}' \
  --profile dev-account \
  --region eu-west-1

# Test hostname resolution from the EIP
nslookup ec2-<a>-<b>-<c>-<d>.eu-west-1.compute.amazonaws.com
```

If `DnsHostnames` is `false`, enable it before deploying EdgeStack:

```bash
aws ec2 modify-vpc-attribute \
  --vpc-id <vpc-id> \
  --enable-dns-hostnames \
  --profile dev-account \
  --region eu-west-1
```

## How to fix

1. Verify the EIP SSM parameter (`/k8s/{env}/eip-address`) contains the
   correct public IP, not a placeholder.
2. Verify the SharedVpc has DNS Hostnames enabled.
3. Redeploy: `cdk deploy K8s-Edge-dev --region us-east-1`.

The `Fn.join` conversion in `edge-stack.ts` handles the IP→hostname
transformation automatically — no manual string manipulation is needed.

## Related

- [cdk-monitoring Platform](../projects/cdk-monitoring-platform.md) — EdgeStack
  ownership (us-east-1) and SSM integration with eu-west-1 EIP parameter
- [docs/troubleshooting/cloudfront-behaviour-first-match-auth-failure.md](cloudfront-behaviour-first-match-auth-failure.md)
  — other EdgeStack CloudFront failure modes

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/edge-stack.ts:433-447 (read on 2026-04-29)
-->
