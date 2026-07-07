---
title: NLB Target Registration Propagation Delay After Spot Instance Replacement
type: troubleshooting
tags: [nlb, aws-ec2, auto-scaling, spot-instances, integration-testing, ci-cd]
sources:
  - infra/dist/tests/integration/kubernetes/argocd-worker-stack.integration.test.js
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the pre-EKS public edge (CloudFront / NLB / Traefik), retired in the kubeadm to Amazon EKS migration. The edge is now a single internet-facing ALB with a regional WAFv2 WebACL ([ADR-0010](../../decisions/0010-alb-wafv2-edge-over-cloudfront-nlb.md)); see [EKS platform architecture](../../concepts/eks-platform-architecture.md). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

Integration tests that verify NLB target group registration fail
intermittently in CI after an ASG replaces a Spot instance. The test calls
`DescribeTargetHealth` and finds the new instance absent or the old instance
still in `draining` state. The same test passes when run locally against a
stable cluster.

The failure pattern in CI:

```
Expected instance i-0abc123 to appear in target group, but found: []
```

Or the test times out waiting for `healthy` state when the target group shows
the old instance as `draining`.

## Root cause

After an ASG terminates and replaces a Spot instance, the new instance ID is
registered in the NLB target group **asynchronously**. The propagation delay
— from when the ASG confirms the new instance is `InService` to when
`DescribeTargetHealth` returns the new instance — is typically 15–60 seconds
but can extend to 2.5 minutes under load.

An integration test that calls `DescribeTargetHealth` immediately after an
ASG event sees:
- The old instance: `draining` (being deregistered)
- The new instance: absent (not yet registered)

This is not an NLB configuration bug — it is the expected asynchronous
registration behaviour. The underlying behaviour is not documented in AWS
NLB documentation.

The fix introduced in commit `81c020af` adds a `waitForTargetRegistration()`
polling helper to the integration test. Constants from the compiled test
([`argocd-worker-stack.integration.test.js:273-275`](../../../infra/dist/tests/integration/kubernetes/argocd-worker-stack.integration.test.js)):

```javascript
const NLB_MAX_ATTEMPTS = 10;
const NLB_BACKOFF_MS = 15_000;   // 15 seconds between attempts
// Total max wait: 10 × 15s = 150s (~2.5 minutes)
```

Each test using NLB target verification also has a 180-second Jest timeout
([`argocd-worker-stack.integration.test.js:285, 290`](../../../infra/dist/tests/integration/kubernetes/argocd-worker-stack.integration.test.js)).

## How to diagnose

```bash
# Check current target health immediately after Spot replacement
aws elbv2 describe-target-health \
  --target-group-arn <tg-arn> \
  --profile dev-account

# Check ASG activity to confirm replacement timing
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name <asg-name> \
  --max-items 5 \
  --profile dev-account
```

If `DescribeTargetHealth` returns empty or shows `draining` only, wait 30–60
seconds and retry. If the new instance does not appear after 3 minutes,
the issue is not propagation delay — check ASG health status and NLB
listener configuration.

## How to fix

Add a polling helper to any integration test that verifies NLB target
registration. The pattern from the argocd-worker stack integration test:

```typescript
async function waitForTargetRegistration(
  client: ElasticLoadBalancingV2Client,
  tgArn: string,
  expectedInstanceId: string,
  maxAttempts: number,
  backoffMs: number,
): Promise<string[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const health = await client.send(
      new DescribeTargetHealthCommand({ TargetGroupArn: tgArn }),
    );
    const ids = (health.TargetHealthDescriptions ?? [])
      .filter((t) => t.TargetHealth?.State !== 'draining')
      .map((t) => t.Target?.Id ?? '');

    if (ids.includes(expectedInstanceId)) return ids;

    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error(`Instance ${expectedInstanceId} not registered after ${maxAttempts} attempts`);
}

// In the test
it('should register new instance in HTTP target group', async () => {
  const targetIds = await waitForTargetRegistration(
    elbv2Client, httpTgArn, expectedId, 10, 15_000,
  );
  expect(targetIds).toContain(expectedId);
}, 180_000); // 180s Jest timeout
```

## How to prevent

- **All NLB target group registration assertions need a retry loop.** Never
  call `DescribeTargetHealth` once and assert immediately after an ASG event.
  The propagation delay is inherent to how NLB target registration works.

- **Set a Jest test timeout that exceeds the maximum propagation window.**
  With 10 attempts × 15 seconds = 150 seconds plus buffer, a 180-second
  timeout is the minimum for NLB registration tests.

- **Filter out `draining` targets.** A `draining` target is the old instance
  being deregistered. Tests should exclude `draining` instances from
  "current target" assertions.

<!--
Evidence trail (auto-generated):
- Source: infra/dist/tests/integration/kubernetes/argocd-worker-stack.integration.test.js:273-290 (read on 2026-04-29)
- Source: infra/tests/integration/kubernetes/argocd-worker-stack-doc.md:76 (referenced on 2026-04-29)
- Commit: 81c020af — "fix(integration): add NLB target registration retry for Spot instance replacement" (read on 2026-04-29)
-->
