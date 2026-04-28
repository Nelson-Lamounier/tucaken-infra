---
title: AMI Refresh IAM Permission Failures
type: troubleshooting
tags: [ami-refresh, iam, ec2, autoscaling, step-functions, aws, kubernetes, launch-template]
sources:
  - infra/lib/constructs/events/ami-refresh/ami-refresh-construct.ts
  - infra/lib/constructs/events/ami-refresh/handlers/update-launch-template.ts
created: 2026-04-28
updated: 2026-04-28
---

## Symptom

The AMI refresh Step Functions state machine enters `FAILED` after a golden
AMI SSM parameter update. The state machine alarm fires (or, if the alarm was
not yet deployed, the failure goes undetected). The error surfaced in the
execution history is:

```
"not authorized to use launch template"
```

or a variant of:

```
An error occurred (UnauthorizedOperation) when calling the
UpdateAutoScalingGroup operation
```

The ASG's Launch Template version does not advance; Kubernetes nodes
continue to boot from the previous AMI.

This failure pattern was observed in practice from approximately 2026-04-25
to 2026-04-27 before manual investigation surfaced it. The silence was
possible because the golden-AMI SSM parameter updated successfully and the
state machine failed without a notification action attached to the CloudWatch
alarm — the exact scenario the alarm and SNS topic were subsequently added
to prevent
([ami-refresh-construct.ts L311-L342](../../infra/lib/constructs/events/ami-refresh/ami-refresh-construct.ts#L311-L342)).

## Root cause

The `UpdateAutoScalingGroup` API call with a `LaunchTemplate` argument
triggers an **internal IAM authorization simulation** on the calling
principal's identity. AWS AutoScaling evaluates whether the caller is
permitted to perform the actions that a fresh instance launch would require —
specifically `ec2:RunInstances`, `ec2:CreateTags` (because the Launch
Template carries `TagSpecifications`), and `iam:PassRole` (for the instance
profile role attached in the Launch Template).

This simulation runs in the **Lambda execution role's identity context**, not
as a chained service call. As a result:

1. The `aws:CalledVia` condition key is empty during the check. Any policy
   statement that uses `aws:CalledVia: ["autoscaling.amazonaws.com"]` will
   **never match** and the permission will evaluate as an implicit deny.

2. If the Launch Template includes `TagSpecifications`, `ec2:RunInstances`
   alone is insufficient — `ec2:CreateTags` must also be granted.

3. The error message "not authorized to use launch template" is the generic
   error AutoScaling returns when **any** of these checks fail (RunInstances,
   CreateTags, or PassRole). It does not identify which permission is missing.

The Lambda itself never calls `ec2:RunInstances`, `ec2:CreateTags`, or
`iam:PassRole` directly. These grants exist solely so the AutoScaling-side
simulation can pass
([ami-refresh-construct.ts L99-L129](../../infra/lib/constructs/events/ami-refresh/ami-refresh-construct.ts#L99-L129)).

A related subtlety: `ec2:DescribeLaunchTemplates` and
`ec2:DescribeLaunchTemplateVersions` do not support resource-level scoping
and must be granted on `*`. When they are absent or scoped to a specific
resource ARN, AutoScaling's internal LT validation fails with the same
misleading "not authorized to use launch template" error, even though the
real cause is an implicit deny on a Describe action
([ami-refresh-construct.ts L84-L97](../../infra/lib/constructs/events/ami-refresh/ami-refresh-construct.ts#L84-L97)).

### Sequence of discovered permissions

The policy was built iteratively through six fix commits:

| Commit | Permission added | Notes |
|---|---|---|
| `01998902` | `ec2:RunInstances` | First missing permission identified |
| `41412376` | `iam:PassRole` with `aws:CalledVia` | Initial attempt used CalledVia condition |
| `cb50ca54` | Dropped `aws:CalledVia` from RunInstances and PassRole | CalledVia is empty in ASG simulation context; condition made policies never match |
| `97a9ec41` | `ec2:Describe*` on `*` | ASG LT validation calls Describe; resource scoping is not supported |
| `55c524bd` | `ec2:CreateTags` | Actual root cause — LT has TagSpecifications; RunInstances alone is insufficient |
| `e411137d` | `autoscaling:UpdateAutoScalingGroup` | Required to set ASG to use new LT version |

## How to diagnose

### Step 1 — Confirm the state machine is failing

```bash
aws stepfunctions list-executions \
  --state-machine-arn <ARN> \
  --status-filter FAILED \
  --query 'executions[*].[name,startDate,stopDate]' \
  --output table
```

Retrieve the execution ARN of the most recent failure, then inspect its
history:

```bash
aws stepfunctions get-execution-history \
  --execution-arn <EXECUTION_ARN> \
  --query 'events[?type==`TaskFailed`]'
```

The `cause` field in the `TaskFailed` event contains the AutoScaling error
message, including the specific `UnauthorizedOperation` verb.

### Step 2 — Identify the missing permission via CloudTrail

Open CloudTrail → Event history, filter by:
- **Event source:** `autoscaling.amazonaws.com` or `ec2.amazonaws.com`
- **Event name:** contains `UpdateAutoScalingGroup`
- **Time range:** around the state machine execution start time

Look for events with `errorCode: "Client.UnauthorizedOperation"` or
`errorCode: "AccessDenied"`. The `errorMessage` field names the denied
action.

Alternatively, use CloudTrail Insights or Athena if the volume of events
makes the console view unwieldy.

### Step 3 — Use IAM Access Analyzer policy simulation

Obtain the Lambda execution role ARN from the CDK stack outputs or:

```bash
aws iam list-roles \
  --query 'Roles[?contains(RoleName, `ami-refresh`)].RoleName'
```

Then simulate the specific denied action:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<ACCOUNT>:role/<ROLE_NAME> \
  --action-names ec2:CreateTags ec2:RunInstances iam:PassRole \
  --resource-arns '*'
```

`EvalDecision: allowed` for each action confirms the policy is correct.

## How to fix

The final correct policy in `AmiRefreshConstruct` grants the following
statements on the shared Lambda execution role
([ami-refresh-construct.ts L76-L142](../../infra/lib/constructs/events/ami-refresh/ami-refresh-construct.ts#L76-L142)):

```ts
// Launch Template mutations — resource-scoped
{ actions: ['ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate'],
  resources: [`arn:aws:ec2:${region}:${account}:launch-template/*`] }

// Describe — must be on '*' (resource scoping not supported)
{ actions: ['ec2:DescribeLaunchTemplates', 'ec2:DescribeLaunchTemplateVersions'],
  resources: ['*'] }

// AutoScaling simulation grants — Lambda never calls these directly
{ actions: ['ec2:RunInstances', 'ec2:CreateTags'],
  resources: ['*'] }

// PassRole for instance profile — required by simulation, no CalledVia
{ actions: ['iam:PassRole'],
  resources: ['*'] }

// ASG operations
{ actions: ['autoscaling:StartInstanceRefresh',
            'autoscaling:DescribeInstanceRefreshes',
            'autoscaling:UpdateAutoScalingGroup'],
  resources: ['*'] }

// SSM reads — scoped to ami-refresh parameters only
{ actions: ['ssm:GetParameter'],
  resources: [`arn:aws:ssm:${region}:${account}:parameter${ssmPrefix}/ami-refresh/*`,
              `arn:aws:ssm:${region}:${account}:parameter${ssmPrefix}/golden-ami/latest`] }
```

If the permissions are already deployed but the state machine is still
failing, redeploy the CDK stack to ensure the policy version has been
updated:

```bash
cd infra
just deploy k8s development
```

Then trigger a manual state machine execution to confirm:

```bash
aws stepfunctions start-execution \
  --state-machine-arn <ARN> \
  --input '{"paramName":"/k8s/development/golden-ami/latest"}'
```

## How to prevent

**CloudWatch alarm with SNS notification** — the construct now creates a
CloudWatch alarm on `ExecutionsFailed` with a threshold of 1 and an SNS
topic that can send email notifications
([ami-refresh-construct.ts L319-L342](../../infra/lib/constructs/events/ami-refresh/ami-refresh-construct.ts#L319-L342)).
Pass `notificationEmail` in `AmiRefreshProps` to subscribe an operator
email address. Without this, a failing state machine can go undetected for
days while AMI bakes continue to succeed and create a false sense of
correctness.

**IAM policy simulator in CDK tests** — before adding or modifying IAM
statements in `AmiRefreshConstruct`, run IAM Access Analyzer policy
simulation against the synthesised template to verify all required actions
evaluate as `allowed` without `CalledVia` conditions.

**Do not use `aws:CalledVia` for ASG-initiated simulation checks** — the
`aws:CalledVia` condition key is only populated when AWS services make calls
on behalf of a principal (service-to-service chaining). The AutoScaling
authorization simulation evaluates in the Lambda role's own context, so
`CalledVia` is empty and any policy gated on it will implicitly deny.

**`ec2:Describe*` must be on `*`** — EC2 Describe actions do not support
resource-level scoping in IAM. Any attempt to scope them to a specific
launch template ARN results in an implicit deny that produces the same
opaque "not authorized to use launch template" error.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/constructs/events/ami-refresh/ami-refresh-construct.ts (read on 2026-04-28)
- Source: infra/lib/constructs/events/ami-refresh/handlers/update-launch-template.ts (read on 2026-04-28)
- Git log: git log --oneline | grep ami-refresh (run on 2026-04-28); commits 01998902, 41412376, cb50ca54, 97a9ec41, 55c524bd, e411137d verified in log
-->
