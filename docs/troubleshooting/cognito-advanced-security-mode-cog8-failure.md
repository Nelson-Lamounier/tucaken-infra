---
title: cdk-nag COG8 Fails — Cognito AdvancedSecurityMode.ENFORCED Replaced by FeaturePlan.PLUS
type: troubleshooting
tags: [cognito, aws-cdk, cdk-nag, security, ci-cd]
sources:
  - infra/lib/stacks/shared/cognito-auth-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

CI `ci-synth-validate` fails on `Shared-CognitoAuth-development` with:

```
[Error at /Shared-CognitoAuth-development/AdminUserPool/Resource]
AwsSolutions-COG8: The Cognito user pool is not on the plus tier / feature plan.
```

Additionally, `cdk synth` emits three deprecation warnings pointing to the
same property:

```
aws-cdk-lib.aws_cognito.UserPoolProps#advancedSecurityMode is deprecated
aws-cdk-lib.aws_cognito.AdvancedSecurityMode is deprecated
aws-cdk-lib.aws_cognito.AdvancedSecurityMode#ENFORCED is deprecated
```

## Root cause

AWS Cognito replaced `AdvancedSecurityMode.ENFORCED` with the feature-plan
API. CDK v2 deprecated all three related symbols and the cdk-nag rule
`AwsSolutions-COG8` was updated to check for `FeaturePlan.PLUS` rather than
`advancedSecurityMode: ENFORCED`. Using the old API satisfies neither the
cdk-nag rule nor removes the deprecation warnings.

The old property still compiles and deploys — the CI failure is from the
cdk-nag Aspect running during `cdk synth`, not from CloudFormation.

## How to fix

Migrate `CognitoAuthStack` from `advancedSecurityMode` to `featurePlan`
([`cognito-auth-stack.ts:137-138`](../../infra/lib/stacks/shared/cognito-auth-stack.ts#L137)):

```typescript
// Before (deprecated, triggers cdk-nag COG8):
advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,

// After (current — same behavior + satisfies COG8):
featurePlan: cognito.FeaturePlan.PLUS,
standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
```

`FeaturePlan.PLUS` provides the same adaptive authentication and compromised
credentials detection that `ENFORCED` provided. The `standardThreatProtectionMode`
property is the new mechanism to express the full-enforcement posture.

## Cost impact

The Cognito Plus tier is priced at approximately $0.05 per MAU. For a
single-admin portfolio pool the cost is negligible — under $1/month
at any realistic usage level.

## How to verify

```bash
cd infra
yarn cdk synth --profile dev-account
# Should produce no AwsSolutions-COG8 errors and no deprecation warnings
```

The fix commit (`b7946970`) verified that `ci-synth-validate` passes for
both K8s and Shared projects after the migration.

## Related

- [cdk-monitoring Platform](../projects/cdk-monitoring-platform.md) — Shared
  project stack inventory including `Shared-CognitoAuth`

<!--
Evidence trail (auto-generated):
- Commit: b7946970 — "fix(cognito): migrate AdminUserPool to FeaturePlan.PLUS API (cdk-nag COG8)" (read on 2026-04-29)
- Source: infra/lib/stacks/shared/cognito-auth-stack.ts:132-138 (read on 2026-04-29)
-->
