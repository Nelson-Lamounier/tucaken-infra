# Phase 5b — AWS Destroy Runbook

> Phase 5 commits removed CDK stack code + Lambda handler files. Deployed AWS resources still exist until you run the destroy commands below.
>
> **Reset point:** if anything goes wrong, `git revert` the Phase 5 commits and `cdk deploy` re-creates the deleted stacks. Once `cdk destroy` runs the resources are gone.

## Prerequisites

- Phases 1–4 deployed and running for ≥7 days with zero error metrics on the K8s replacements.
- All admin-api + public-api traffic confirmed serving from PG (check Loki for `[admin-api]` / `[public-api]` log lines, no DynamoDB throttle/error metrics).
- ECR repos provisioned at `/shared/ecr-{ingestion,article-pipeline,job-strategist}/development/repository-uri` (Phase 5 C1 workflows fail fast without these).
- New images built + pushed via the C1 workflows; admin-api pod ConfigMap updated with `INGESTION_IMAGE`, `ARTICLE_PIPELINE_IMAGE`, `STRATEGIST_PIPELINE_IMAGE`.

## Destroy order

CDK destroys must respect cross-stack SSM consumers. Execute strictly bottom-up:

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications/infra

# 1. Pipelines (no other stack depends on them)
npx cdk destroy Bedrock-Pipeline-development           -c project=bedrock -c environment=development --force
npx cdk destroy Bedrock-Strategist-Pipeline-development -c project=bedrock -c environment=development --force

# 2. Public API (consumed nothing inside CDK; CloudFront route already swung to k8s pod)
npx cdk destroy Bedrock-Public-Api-development         -c project=bedrock -c environment=development --force

# 3. Ingestion (depends on RDS VPC + SG — must go before RDS)
npx cdk destroy Bedrock-Ingestion-development          -c project=bedrock -c environment=development --force

# 4. RDS pgvector (legacy — Phase 1 platform RDS in kubernetes-bootstrap is the replacement)
npx cdk destroy Bedrock-Aurora-development             -c project=bedrock -c environment=development --force

# 5. Data layer DynamoDB stacks (admin-api/public-api are PG-only — confirmed before destroy)
npx cdk destroy Bedrock-Strategist-Data-development    -c project=bedrock -c environment=development --force
npx cdk destroy Bedrock-Content-development            -c project=bedrock -c environment=development --force
```

Stack-name suffix tracks the `environment` context. Substitute `staging` / `production` for non-dev runs.

## DynamoDB tables

`cdk destroy` will delete the tables only if `removalPolicy: DESTROY` was set. Production typically uses `RETAIN`, so the tables survive even when their stacks are gone. Force-delete manually:

```bash
# Resolve actual table names from SSM (or AWS console). Names follow:
#   bedrock-development-content
#   bedrock-development-strategist

aws dynamodb delete-table --table-name bedrock-development-content   --region eu-west-1
aws dynamodb delete-table --table-name bedrock-development-strategist --region eu-west-1
```

Verify deletion:

```bash
aws dynamodb list-tables --region eu-west-1 \
  | jq -r '.TableNames[]' \
  | grep -E "bedrock-development-(content|strategist)" || echo "✓ tables gone"
```

## Orphaned resources to verify cleared

After CDK destroys complete, confirm these are gone (CDK should remove them, but watch for retention policies):

- S3 staging bucket: `bedrock-development-ingestion-staging`
- Step Functions state machines: `bedrock-development-article-pipeline`, `bedrock-development-strategist-analysis`, `bedrock-development-strategist-coaching`
- VPC: the legacy `Bedrock-Aurora-development` VPC and its endpoints (Secrets Manager, Bedrock Runtime, S3)
- Lambda function log groups: `/aws/lambda/bedrock-development-{trigger,research,writer,qa,publish,version-history,fetcher,worker,...}` — set to RETAIN by default; delete manually with:
  ```bash
  aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/bedrock-development-" --region eu-west-1 \
    | jq -r '.logGroups[].logGroupName' | xargs -I {} aws logs delete-log-group --log-group-name "{}" --region eu-west-1
  ```

## ECR repository for old images (optional)

The `admin-api` and `public-api` ECR repos remain in use. The Lambda function code packaged inside CDK had no separate ECR repo. If any deleted Lambdas used container images (e.g. `applications/article-pipeline/` shipped via ECR rather than zip), their ECR repos are now orphaned. Inspect:

```bash
aws ecr describe-repositories --region eu-west-1 \
  | jq -r '.repositories[] | select(.repositoryName | startswith("bedrock-development-")) | .repositoryName'
```

Delete with `aws ecr delete-repository --repository-name <name> --force --region eu-west-1`.

## Secrets

The legacy GitHub PAT secret `bedrock-development/github-token` is still consumed by the new ingestion K8s Job (via Phase 3 ESO `ingestion-secrets`). **Do NOT delete it.**

The legacy RDS credentials secret `bedrock-development/rds-pgvector/credentials` becomes orphaned after `Bedrock-Aurora-development` destroys — delete after stack is gone:

```bash
aws secretsmanager delete-secret --secret-id bedrock-development/rds-pgvector/credentials \
  --recovery-window-in-days 7 --region eu-west-1
```

7-day recovery window provides a rollback safety net.

## Rollback strategy

If destroy fails partway and you need to redeploy the legacy infrastructure:

```bash
git revert ae8a059        # Phase 5 deletion commit
cdk deploy --all -c project=bedrock -c environment=development
```

The original 11-stack architecture comes back. K8s replacements continue running in parallel. To re-attempt the migration, fix the failing piece and re-cherry-pick or re-do Phase 5.

## Final verification

```bash
# CDK should show only 4 stacks
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications/infra
npx cdk list -c project=bedrock -c environment=development
# Expected:
#   Bedrock-Data-development
#   Bedrock-Kb-development
#   Bedrock-Agent-development
#   Bedrock-Api-development

# Smoke-test admin-api + public-api end-to-end
kubectl logs -n admin-api  -l app=admin-api  --tail=50 | grep -E "PG|error" | head -10
kubectl logs -n nextjs     -l app=public-api --tail=50 | grep -E "PG|error" | head -10

# Trigger an ingestion job
curl -X POST https://admin.nelsonlamounier.com/api/admin/ingestion/trigger \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  -H "Content-Type: application/json" \
  -d '{"repoFullName":"Nelson-Lamounier/portfolio"}'

# Watch the Job
kubectl logs -n ingestion -l app=ingestion-worker --tail=200 -f
```

## Phase 5 completion criteria

- [ ] `cdk list` returns exactly 4 stacks
- [ ] `aws dynamodb list-tables` no longer shows the 2 bedrock tables
- [ ] No `[articles] DynamoDB` / `[applications] DynamoDB` log lines in admin-api for 24h
- [ ] No `Cache-Control` 5xx spike on the public site after public-api swap
- [ ] All 3 K8s Job pipelines (ingestion / article / strategist / coach) green-tested end-to-end
