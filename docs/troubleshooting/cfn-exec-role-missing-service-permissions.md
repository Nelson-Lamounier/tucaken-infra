---
title: CloudFormation Stack Rollback — Execution Role Missing Service Permissions or Non-ASCII SG Description
type: troubleshooting
tags: [aws-cdk, cloudformation, iam, rds, security-group, bootstrap]
sources:
  - infra/scripts/bootstrap/policies/CDKCloudFormationEx.json
  - infra/lib/stacks/kubernetes/platform-rds-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom A — Stack rollback on first deploy of a new service

A CDK stack deploys successfully the first time but rolls back immediately
after CloudFormation begins resource creation:

```
Resource handler returned message: "User: arn:aws:sts::<account>:assumed-role/
cdk-hnb659fds-cfn-exec-role-.../AWSCloudFormation is not authorized to perform:
rds:DescribeDBSubnetGroups on resource: *"
```

`cdk deploy` exits with a non-zero code. The stack ends in
`ROLLBACK_COMPLETE` state. The CDK synth succeeds locally — no error at
synthesis time.

## Symptom B — HTTP 400 on SecurityGroup creation

Stack deployment fails at the SecurityGroup resource with:

```
Resource handler returned message: "GroupDescription must be ASCII-only."
```

The CloudFormation template renders correctly. `cdk synth` produces no
errors. Only the CloudFormation execution fails.

---

## Root cause A — CDK CloudFormation execution role

CDK uses a **dedicated execution role** (`cdk-hnb659fds-cfn-exec-role-*`) to
create and modify AWS resources. This role is separate from the CDK
deployment role used to call CloudFormation APIs.

The execution role policy is managed in
[`infra/scripts/bootstrap/policies/CDKCloudFormationEx.json`](../../infra/scripts/bootstrap/policies/CDKCloudFormationEx.json).
It has **no AWS managed policies** — every service must be explicitly
enumerated. When a stack introduces a new AWS service, the corresponding
permissions must be added to this policy and the CDK bootstrap redeployed
before the stack can deploy.

`PlatformRdsStack` was the first stack to use the RDS service. The execution
role was missing the `RelationalDatabaseServices` statement. CloudFormation
called `rds:DescribeDBSubnetGroups` during DB subnet group creation and
received an `AccessDenied` response, triggering an automatic rollback.

Current statement (added in commit `0ecf7457`):

```json
{
  "Sid": "RelationalDatabaseServices",
  "Effect": "Allow",
  "Action": "rds:*",
  "Resource": "*"
}
```

## Root cause B — Non-ASCII characters in SecurityGroup description

The EC2 API enforces that `GroupDescription` contains only ASCII characters.
CDK passes the `description` string from the construct directly to the API
without escaping. An em dash (`—`, U+2014) in the description string causes
an HTTP 400 response:

```
GroupDescription must be ASCII-only.
```

This is invisible at synth time because CDK generates the CloudFormation
template without validating character sets on string properties. The CDK
linter does not catch it. cfn-lint does not flag it.

## How to fix A — Add the missing service to CDKCloudFormationEx.json

1. Identify the denied action from the CloudFormation error message.
2. Add a statement to
   `infra/scripts/bootstrap/policies/CDKCloudFormationEx.json`:

   ```json
   {
     "Sid": "<ServiceName>",
     "Effect": "Allow",
     "Action": "<service>:*",
     "Resource": "*"
   }
   ```

3. Redeploy the CDK bootstrap to push the updated policy:

   ```bash
   cd infra
   just bootstrap development
   ```

4. Retry `cdk deploy` for the affected stack.

The full list of currently enumerated services can be seen in
[`CDKCloudFormationEx.json`](../../infra/scripts/bootstrap/policies/CDKCloudFormationEx.json) —
each service family has its own `Sid`.

## How to fix B — Replace non-ASCII characters in SG descriptions

Replace any typographic punctuation in SecurityGroup `description` strings
with ASCII equivalents:

- Em dash `—` (U+2014) → hyphen `-`
- En dash `–` (U+2013) → hyphen `-`
- Smart quotes `"` `"` → straight quotes `"`
- Ellipsis `…` (U+2026) → `...`

Current correct form in
[`platform-rds-stack.ts`](../../infra/lib/stacks/kubernetes/platform-rds-stack.ts#L62):

```typescript
description: 'Platform RDS - allow PostgreSQL from within VPC',
```

## How to prevent

- **New service checklist**: before deploying any stack that introduces a
  new AWS service (RDS, ElastiCache, Kinesis, etc.), verify the service
  appears in `CDKCloudFormationEx.json`. If absent, add it and bootstrap first.
- **ASCII-only SG descriptions**: treat EC2 `GroupDescription` and related
  string properties as ASCII-only fields. Avoid copy-pasting from word
  processors or documentation that may include typographic characters.

## Related

- [cdk-monitoring Platform](../projects/cdk-monitoring-platform.md) — CDK
  bootstrap and execution role ownership
- [`infra/scripts/bootstrap/policies/CDKCloudFormationEx.json`](../../infra/scripts/bootstrap/policies/CDKCloudFormationEx.json)
  — full execution role policy

<!--
Evidence trail (auto-generated):
- Commit: 0ecf7457 — "fix(rds): add rds:* to CFn exec policy + fix non-ASCII SG description" (read on 2026-04-29)
- Source: infra/scripts/bootstrap/policies/CDKCloudFormationEx.json (read on 2026-04-29)
- Source: infra/lib/stacks/kubernetes/platform-rds-stack.ts:62 (read on 2026-04-29)
-->
