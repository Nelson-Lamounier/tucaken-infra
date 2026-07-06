---
title: Traefik Rejects All Requests — X-CloudFront-Origin-Secret Mismatch
type: troubleshooting
tags: [cloudfront, traefik, security, origin-secret, ssm, rotation, troubleshooting]
sources:
  - infra/lib/stacks/kubernetes/edge-stack.ts
  - docs/concepts/cloudfront-distribution.md
  - docs/concepts/request-lifecycle-viewer-to-pod.md
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the pre-EKS public edge (CloudFront / NLB / Traefik), retired in the kubeadm to Amazon EKS migration. The edge is now a single internet-facing ALB with a regional WAFv2 WebACL ([ADR-0010](../../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md)); see [EKS platform architecture](../../concepts/eks-platform-architecture.md). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

All requests to `nelsonlamounier.com` and `admin.nelsonlamounier.com` return `502 Bad Gateway` from CloudFront. The NLB health checks are passing. The EC2 worker nodes are running. The issue is not visible in the NLB metrics — traffic reaches the node but is rejected at the application layer.

In CloudFront access logs (S3 bucket `k8s-dev-cf-logs-*`):

```
cs-status: 502
x-edge-result-type: Error
x-edge-response-result-type: Error
```

In Traefik request logs (Loki, query `{job="traefik"} |= "403"` or `|= "rejected"`):

```
msg="request rejected" rule="HeadersRegexp(`X-CloudFront-Origin-Secret`, `<expected-pattern>`)" clientIP="<cloudfront-pop-ip>"
```

## Root cause

The `X-CloudFront-Origin-Secret` header value injected by CloudFront does not match the value Traefik's middleware expects. This happens when:

1. The SSM parameter `/k8s/{env}/cloudfront-origin-secret` was rotated but the CDK stack was not redeployed — CloudFront is still forwarding the old value.
2. The CDK stack was redeployed (picking up the new SSM value) but Traefik's middleware `HeadersRegexp` was not updated to accept the new value.
3. The SSM parameter was manually overwritten with an incorrect value.

## Why this failure is invisible at the NLB layer

The NLB operates at TCP Layer 4 and does not inspect HTTP headers. It sees a successful TCP connection to port 80 and reports the target as healthy. The rejection at Traefik produces an HTTP 403 (or connection close), which CloudFront surfaces as a 502. NLB `HealthyHostCount` metric stays at 1 — no alarm fires.

**Diagnosis checklist:**

1. Confirm NLB target group shows healthy hosts: `aws elbv2 describe-target-health --target-group-arn <arn> --profile <profile>`
2. Confirm CloudFront returns 502 (not 403, 429): check CloudFront access logs in S3
3. Query Traefik logs in Loki for `rejected` or the secret header keyword — this pinpoints the mismatch

## How the secret is wired (CDK)

The secret is stored as an SSM SecureString at path `/k8s/{env}/cloudfront-origin-secret` (`infra/lib/stacks/kubernetes/edge-stack.ts:398`). The `KubernetesEdgeStack` reads it at deploy time via `readSsmParameter()` (a `cr.AwsCustomResource` wrapping `ssm:GetParameter` with `withDecryption: true`).

The read uses a synthesise-time `DEPLOY_TIME` timestamp as the physical resource ID for `onUpdate`. This forces CloudFormation to re-invoke the Lambda on every `cdk deploy` — ensuring a freshly rotated secret is always picked up without manual resource deletion (`edge-stack.ts:900-912`).

The resolved value is passed to the CloudFront `HttpOrigin` as a custom header (`edge-stack.ts:465`):

```ts
customHeaders: { 'X-CloudFront-Origin-Secret': originSecret },
```

If the SSM parameter is missing entirely at deploy time, CloudFormation surfaces an opaque `UnknownError` on the `ReadCloudfrontOriginSecret` custom resource (`edge-stack.ts:405-406`).

## Atomic rotation procedure (zero-downtime)

The 4-step procedure below is documented in `edge-stack.ts:408-416`. Follow it exactly — skipping step 3 causes all in-flight requests to be rejected during the CloudFront propagation window.

**Step 1 — Generate a new secret:**

```bash
NEW=$(openssl rand -hex 32)
echo "New secret: $NEW"
```

**Step 2 — Write to SSM and redeploy the edge stack:**

```bash
aws ssm put-parameter \
  --name "/k8s/development/cloudfront-origin-secret" \
  --value "$NEW" \
  --type SecureString \
  --overwrite \
  --profile <profile>

# Redeploy edge stack — CloudFront begins forwarding X-CloudFront-Origin-Secret: $NEW
npx cdk deploy K8s-Edge-dev -c project=kubernetes -c environment=dev
```

CloudFront propagation takes **up to 15 minutes**. During this window, some PoPs still forward the old value while others forward the new value.

**Step 3 — Configure Traefik to accept both old and new values (dual-accept window):**

> **Note:** Traefik is configured via the `kubernetes-bootstrap` repo. This step uses `deploy.py` to set the ArgoCD Application's `cloudfront.originSecret` Helm parameter to a regex that accepts both values.

```bash
# In kubernetes-bootstrap repo:
python deploy.py --secret "OLD_HEX|NEW_HEX"
# Sets Traefik HeadersRegexp to: ^(OLD_HEX|NEW_HEX)$
```

Wait at least 15 minutes after step 2 before proceeding.

**Step 4 — Lock Traefik to the new value only:**

```bash
# In kubernetes-bootstrap repo:
python deploy.py --secret "$NEW"
```

**Rollback:** If something goes wrong after step 2 but before step 4, rollback by writing the old value back to SSM, redeploying the edge stack, and re-running `deploy.py` with the old value.

## Verifying the fix

After step 4, confirm CloudFront returns 200 (or expected status) from the origin:

```bash
# Check CloudFront access logs in S3 — look for OriginRequestCount and no 502s
aws s3 ls s3://<cf-logs-bucket>/E*/$(date +%Y-%m-%d) --profile <profile>

# Direct curl bypassing CloudFront — should return 403 (missing secret header)
curl -v http://52.18.73.218/healthz

# Via CloudFront — should return 200
curl -v https://nelsonlamounier.com/healthz
```

A `403` on the direct EIP curl and a `200` via CloudFront confirms both that Traefik is enforcing the header and that CloudFront is forwarding the correct value.

## Related

- [CloudFront Distribution](../concepts/cloudfront-distribution.md) — origin secret wiring, `HTTP_ONLY` origin protocol, security rationale
- [Request Lifecycle — Viewer to Pod](../concepts/request-lifecycle-viewer-to-pod.md) — Hop 4 (CloudFront → EIP) and Hop 7 (Traefik header validation)
- [CDK valueFromLookup vs fromSsmParameter](../../troubleshooting/cdk-value-from-lookup-vs-ssm-parameter.md) — SSM read-at-deploy-time pattern

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/edge-stack.ts (read on 2026-04-29) — rotation procedure lines 408-416, SSM parameter prerequisite lines 398-406, readSsmParameter() DEPLOY_TIME strategy lines 900-912, customHeaders line 465
- Source: docs/concepts/cloudfront-distribution.md (read on 2026-04-29) — origin secret wiring, HTTP_ONLY protocol, CloudFront propagation
- Source: docs/concepts/request-lifecycle-viewer-to-pod.md (read on 2026-04-29) — Hops 4 and 7 failure modes
- Inferred: Traefik HeadersRegexp configuration, deploy.py interface — these live in kubernetes-bootstrap, not this repo
-->
