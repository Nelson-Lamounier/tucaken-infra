# @format
# justfile — Task runner for cdk-monitoring
#
# Usage:
#   just              List all recipes
#   just synth kubernetes development
#   just deploy kubernetes development
#   just test          Run all tests
#
# Prerequisites:
#   brew install just
#
# This file is the single CLI entry point for local development.
# CI/CD pipelines also use 'just' for code quality tasks (lint, build, typecheck).

# Default recipe — show help
default:
    @just --list --unsorted

# Shorthand alias for listing recipes
ls:
    @just --list --unsorted

# =============================================================================
# INTERNAL HELPERS
# =============================================================================

# Resolve AWS profile from environment name
[private]
_profile env:
    #!/usr/bin/env bash
    case "{{env}}" in
      development) echo "dev-account" ;;
      staging)     echo "staging-account" ;;
      production)  echo "prod-account" ;;
      *)           echo "dev-account" ;;
    esac

# =============================================================================
# CDK COMMANDS (run from infra/ — no interactive CLI layer)
# =============================================================================

# Synthesize CDK stacks (e.g., just synth kubernetes development)
[group('cdk')]
synth project environment *ARGS:
    cd infra && npx cdk synth --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Deploy CDK stacks (e.g., just deploy kubernetes development)
[group('cdk')]
deploy project environment *ARGS:
    cd infra && npx cdk deploy --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      --require-approval never \
      {{ARGS}}

# Deploy a single CDK stack (e.g., just deploy-stack ArgocdWorker-development kubernetes development)
[group('cdk')]
deploy-stack stack project environment *ARGS:
    cd infra && npx cdk deploy {{stack}} --exclusively \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      --require-approval never \
      {{ARGS}}

# Show diff between local and deployed stacks
[group('cdk')]
diff project environment *ARGS:
    cd infra && npx cdk diff --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Destroy CDK stacks (with CDK's built-in confirmation)
[group('cdk')]
destroy project environment *ARGS:
    cd infra && npx cdk destroy --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# List all CDK stacks for a project
[group('cdk')]
list project environment *ARGS:
    cd infra && npx cdk list \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Bootstrap CDK in an AWS account
[group('cdk')]
bootstrap account profile *ARGS:
    cd infra && npx cdk bootstrap aws://{{account}}/eu-west-1 \
      --profile {{profile}} \
      --qualifier hnb659fds \
      --toolkit-stack-name CDKToolkit \
      {{ARGS}}

# List all CloudFormation stacks in the account
# Shows: stack name, status, creation time, and drift status.
# Usage: just cfn-stacks development
#        just cfn-stacks development CREATE_COMPLETE   # filter by status
[group('cdk')]
cfn-stacks environment status="" region="eu-west-1":
    #!/usr/bin/env bash
    set -euo pipefail
    PROFILE=$(just _profile {{environment}})
    echo "══════════════════════════════════════════════════════════════"
    echo "  CloudFormation Stacks ({{environment}} / {{region}})"
    echo "══════════════════════════════════════════════════════════════"
    echo ""
    QUERY='StackSummaries[*].[StackName,StackStatus,CreationTime,DriftInformation.StackDriftStatus]'
    if [ -n "{{status}}" ]; then
      aws cloudformation list-stacks \
        --stack-status-filter "{{status}}" \
        --query "${QUERY}" \
        --output table \
        --region {{region}} --profile "${PROFILE}"
    else
      aws cloudformation list-stacks \
        --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE \
        --query "${QUERY}" \
        --output table \
        --region {{region}} --profile "${PROFILE}"
    fi

# Query CloudTrail for CloudFormation events on a specific stack
# Shows: who triggered the action, event name, timestamp, and error (if any).
# Usage: just cfn-trail Shared-SecurityBaseline-development development
#        just cfn-trail GoldenAmi-development development 30   # last 30 days
[group('cdk')]
cfn-trail stack environment days="14" region="eu-west-1":
    #!/usr/bin/env bash
    set -euo pipefail
    PROFILE=$(just _profile {{environment}})
    START=$(date -u -v-{{days}}d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '{{days}} days ago' '+%Y-%m-%dT%H:%M:%SZ')
    echo "══════════════════════════════════════════════════════════════"
    echo "  CloudTrail — {{stack}} (last {{days}} days)"
    echo "══════════════════════════════════════════════════════════════"
    echo ""
    aws cloudtrail lookup-events \
      --lookup-attributes "AttributeKey=ResourceName,AttributeValue={{stack}}" \
      --start-time "${START}" \
      --query 'Events[*].{Time:EventTime,Event:EventName,User:Username,Source:EventSource}' \
      --output table \
      --region {{region}} --profile "${PROFILE}"

# Audit SNS topics — list all topics and detail those without subscriptions
# Usage: just sns-orphans development
[group('cdk')]
sns-orphans environment region="eu-west-1":
    npx tsx scripts/local/sns-orphans.ts --env {{environment}} --profile $(just _profile {{environment}}) --region {{region}}

# Audit CloudWatch log groups — identify empty, stale, and unmanaged log groups
# Usage: just cw-log-audit development
[group('cdk')]
cw-log-audit environment region="eu-west-1":
    npx tsx scripts/local/cloudwatch-log-audit.ts --env {{environment}} --profile $(just _profile {{environment}}) --region {{region}}

# Fetch recent CloudWatch log events + SSM Run Command history as JSON
# Output is printed to terminal and saved to scripts/local/diagnostics/
# Usage: just cw-last-query /aws/lambda/my-function development
#        just cw-last-query /aws/eks/my-cluster development --instance-id i-0abc123 --hours 6 --limit 100
#        just cw-last-query /aws/eks/my-cluster development --region us-east-1
[group('cdk')]
cw-last-query log-group environment *EXTRA_ARGS:
    npx tsx scripts/local/cw-last-query.ts --log-group {{log-group}} --env {{environment}} --profile $(just _profile {{environment}}) {{EXTRA_ARGS}}

# Troubleshoot CloudFormation stack deployments — diagnose slow, stuck, or failed operations
# Usage: just cfn-troubleshoot ComputeStack-development development
[group('cdk')]
cfn-troubleshoot stack environment region="eu-west-1":
    npx tsx scripts/local/cfn-troubleshoot.ts --stack {{stack}} --env {{environment}} --profile $(just _profile {{environment}}) --region {{region}}

# Fetch /var/log/cloud-init-output.log from a remote EC2 instance via SSM
# Usage: just cloud-init-log i-0abc123def456 development
[group('cdk')]
cloud-init-log instance-id environment="development" region="eu-west-1" tail="200":
    #!/usr/bin/env bash
    set -euo pipefail
    PROFILE=$(just _profile {{environment}})
    LOG_DIR="scripts/local/diagnostics/.troubleshoot-logs"
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    LOG_FILE="${LOG_DIR}/cloud-init-{{instance-id}}-${TIMESTAMP}.log"
    mkdir -p "${LOG_DIR}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  cloud-init-output.log — {{instance-id}}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    CMD_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=[\"tail -n {{tail}} /var/log/cloud-init-output.log\"]" \
      --profile "${PROFILE}" \
      --region {{region}} \
      --query "Command.CommandId" \
      --output text)
    echo "SSM Command ID: ${CMD_ID}"
    echo "Waiting for command to complete..."
    aws ssm wait command-executed \
      --command-id "${CMD_ID}" \
      --instance-id "{{instance-id}}" \
      --profile "${PROFILE}" \
      --region {{region}} 2>/dev/null || true
    sleep 2
    OUTPUT=$(aws ssm get-command-invocation \
      --command-id "${CMD_ID}" \
      --instance-id "{{instance-id}}" \
      --profile "${PROFILE}" \
      --region {{region}} \
      --query "StandardOutputContent" \
      --output text)
    echo ""
    echo "${OUTPUT}"
    echo "${OUTPUT}" > "${LOG_FILE}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ Log saved to: ${LOG_FILE}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Audit EBS volume lifecycle — diagnose detach/attach timing during ASG rolling updates
# Usage: just ebs-lifecycle vol-09129364aa3bd586e development
#        just ebs-lifecycle vol-xxx development --stack ControlPlane-development --asg-logical-id ComputeAutoScalingGroupASG7021CF69
[group('cdk')]
ebs-lifecycle volume environment="development" *EXTRA_ARGS:
    npx tsx scripts/local/ebs-lifecycle-audit.ts --volume {{volume}} --env {{environment}} --profile $(just _profile {{environment}}) {{EXTRA_ARGS}}

# Validate Golden AMI build component YAML for known anti-patterns (no AWS calls)
# Usage: just test-ami-build
[group('cdk')]
test-ami-build:
    yarn jest tests/unit/constructs/compute/build-golden-ami-component.test.ts --verbose

# =============================================================================
# CI SCRIPTS (Non-interactive — used by GitHub Actions)
#
# These recipes are the ONLY interface between GitHub Actions and project scripts.
# All CI workflow steps MUST call justfile recipes — never raw yarn/npx commands.
# This ensures local and CI environments use identical execution paths.
# =============================================================================

# CI synth-validate: synthesize all projects for CI validation
# Validates that all CDK stacks synthesize correctly without AWS API calls.
# Uses --no-lookups to rely on cached cdk.context.json instead of live AWS lookups.
# Covers: k8s (8 stacks), bedrock (4 stacks), shared (1 stack).
# Called by: .github/workflows/ci.yml → validate-cdk job
[group('ci')]
ci-synth-validate:
    #!/usr/bin/env bash
    set -uo pipefail
    cd infra
    FAILURES=0

    echo "==========================================="
    echo "Validating K8s Project (dev)"
    echo "==========================================="
    if npx cdk synth -c project=kubernetes -c environment=dev -c adminAllowedIps=NONE --no-lookups --quiet; then
      echo "✓ K8s synth passed"
    else
      echo "✗ K8s synth FAILED"
      FAILURES=$((FAILURES + 1))
    fi

    echo ""
    echo "==========================================="
    echo "Validating Bedrock Project (dev)"
    echo "==========================================="
    if npx cdk synth -c project=bedrock -c environment=dev --no-lookups --quiet; then
      echo "✓ Bedrock synth passed"
    else
      echo "⚠ Bedrock synth failed (expected in container — no Docker daemon)"
      # Not counted as failure: Bedrock constructs require Docker for asset bundling
    fi

    echo ""
    echo "==========================================="
    echo "Validating Shared Project (dev)"
    echo "==========================================="
    if npx cdk synth -c project=shared -c environment=dev --no-lookups --quiet; then
      echo "✓ Shared synth passed"
    else
      echo "✗ Shared synth FAILED"
      FAILURES=$((FAILURES + 1))
    fi

    echo ""
    if [ "$FAILURES" -gt 0 ]; then
      echo "✗ CDK synthesis validation failed ($FAILURES project(s) failed)"
      exit 1
    fi
    echo "✓ CDK synthesis validation complete (all projects)"

# CI pipeline setup: validate account ID, resolve edge config, mask secrets
# Called by: .github/workflows/_deploy-kubernetes.yml → setup job
[group('ci')]
ci-pipeline-setup:
    npx tsx infra/scripts/ci/pipeline-setup.ts

# CI synth: synthesize + output stack names (e.g., just ci-synth kubernetes development)
# Used by deployment pipelines to get ordered stack names for targeted deploys.
# Called by: .github/workflows/_deploy-kubernetes.yml
[group('ci')]
ci-synth project environment:
    npx tsx infra/scripts/ci/synthesize.ts {{project}} {{environment}}

# CI preflight: validate inputs, verify credentials and bootstrap
[group('ci')]
ci-preflight *ARGS:
    npx tsx infra/scripts/ci/preflight-checks.ts {{ARGS}}

# CI rescue: detect and import orphaned CloudFormation resources before deploy
[group('ci')]
ci-cfn-rescue *ARGS:
    npx tsx infra/scripts/ci/cfn-import-rescue.ts {{ARGS}}

# CI deploy: deploy a specific stack (e.g., just ci-deploy ControlPlane-development)
[group('ci')]
ci-deploy *ARGS:
    npx tsx infra/scripts/cd/deploy.ts {{ARGS}}

# CI rollback: rollback a failed deployment
[group('ci')]
ci-rollback *ARGS:
    npx tsx infra/scripts/cd/diagnose-rollback.ts {{ARGS}} --mode rollback

# CI drift detection
[group('ci')]
ci-drift *ARGS:
    npx tsx infra/scripts/ci/drift-detection.ts {{ARGS}}

# CI log group audit: find empty CloudWatch log groups (no streams)
[group('ci')]
ci-log-audit *ARGS:
    npx tsx infra/scripts/ci/log-group-audit.ts {{ARGS}}

# CI security scan: run Checkov against synthesised CDK templates
# Blocks on CRITICAL/HIGH findings. Use --soft-fail for advisory mode.
# Called by: .github/workflows/ci.yml → iac-security-scan job
[group('ci')]
ci-security-scan *ARGS:
    npx tsx infra/scripts/ci/security-scan.ts {{ARGS}}



# CI diagnose: diagnose a failed CloudFormation stack deployment
[group('ci')]
ci-diagnose *ARGS:
    npx tsx infra/scripts/cd/diagnose-rollback.ts {{ARGS}} --mode diagnose

# CI failure report: aggregate multi-stack diagnostics for failed deployment
[group('ci')]
ci-failure-report *ARGS:
    npx tsx infra/scripts/cd/deployment-failure-report.ts {{ARGS}}

# CI sync-scripts: sync bootstrap and deploy scripts to S3
[group('ci')]
ci-sync-scripts *ARGS:
    npx tsx infra/scripts/cd/sync-bootstrap-scripts.ts {{ARGS}}

# CI trigger-bootstrap: trigger SSM Automation on K8s nodes
[group('ci')]
ci-trigger-bootstrap *ARGS:
    npx tsx infra/scripts/cd/trigger-bootstrap.ts {{ARGS}}

# CI observe-bootstrap: poll SSM Automation & stream CloudWatch logs
[group('ci')]
ci-observe-bootstrap *ARGS:
    npx tsx infra/scripts/cd/observe-bootstrap.ts {{ARGS}}

# CI deploy-monitoring-secrets: deploy monitoring secrets via SSM Automation
[group('ci')]
ci-deploy-monitoring-secrets *ARGS:
    npx tsx infra/scripts/cd/deploy-monitoring-secrets.ts {{ARGS}}

# CI deploy-nextjs-secrets: deploy Next.js secrets via SSM Automation
[group('ci')]
ci-deploy-nextjs-secrets *ARGS:
    npx tsx infra/scripts/cd/deploy-nextjs-secrets.ts {{ARGS}}

# CI deploy-admin-secrets: deploy start-admin secrets via SSM Automation
# Runs deploy.py on the control-plane to create/update the start-admin-secrets
# K8s Secret in the start-admin namespace. Uses the same consolidated
# k8s-deploy-secrets SSM Automation document as nextjs and monitoring.
[group('ci')]
ci-deploy-admin-secrets *ARGS:
    npx tsx infra/scripts/cd/deploy-admin-secrets.ts {{ARGS}}

# CI finalize: collect outputs, write summary, save artifacts
[group('ci')]
ci-finalize-deployment *ARGS:
    npx tsx infra/scripts/cd/finalize.ts {{ARGS}}

# CI summary: generate pipeline-wide deployment summary
# Usage: just ci-summary kubernetes development
[group('ci')]
ci-summary *ARGS:
    npx tsx infra/scripts/cd/finalize.ts {{ARGS}} --mode pipeline-summary

# CI verify ArgoCD: poll ArgoCD API for sync status
# Usage: just ci-verify-argocd --environment development --region eu-west-1
[group('ci')]
ci-verify-argocd *ARGS:
    npx tsx infra/scripts/cd/verify-argocd-sync.ts {{ARGS}}

# CI ArgoCD health: quick reachability check via SSM send-command
# Usage: just ci-argocd-health --environment development --region eu-west-1
[group('ci')]
ci-argocd-health *ARGS:
    npx tsx infra/scripts/cd/verify-argocd-sync.ts --mode health {{ARGS}}

# CI deploy-manifests: deploy K8s manifests via SSM Run Command
# Usage: just ci-deploy-manifests kubernetes development --region eu-west-1
[group('ci')]
ci-deploy-manifests *ARGS:
    npx tsx kubernetes-app/platform/charts/monitoring/scripts/deploy-manifests.ts {{ARGS}}

# CI smoke tests (Kubernetes Infrastructure — full kubeadm deployment)
[group('ci')]
ci-smoke-kubernetes-infra *ARGS:
    npx tsx infra/scripts/validation/smoke-tests-kubernetes.ts {{ARGS}}

# CI site smoke test — verify live CloudFront URL is serving HTTP 2xx
# Polls the public site URL with exponential backoff after bootstrap.
# Usage: just ci-smoke-site --environment development --region eu-west-1
[group('ci')]
ci-smoke-site *ARGS:
    npx tsx infra/scripts/cd/smoke-site.ts {{ARGS}}

# CI fetch boot logs from CloudWatch (failure diagnostics)
[group('ci')]
ci-fetch-boot-logs *ARGS:
    npx tsx kubernetes-app/k8s-bootstrap/scripts/fetch-boot-logs.ts {{ARGS}}




# =============================================================================
# TESTING
# =============================================================================

# Run all tests
[group('test')]
test *ARGS:
    cd infra && yarn test {{ARGS}}

# Run stack unit tests only (used by CI)
# Targets: tests/unit/stacks/ — covers all CDK stack snapshot + assertion tests.
# Called by: .github/workflows/ci.yml → test-stacks job
[group('test')]
test-stacks:
    cd infra && yarn test tests/unit/stacks --coverage

# Run tests in watch mode
[group('test')]
test-watch:
    cd infra && yarn test:watch

# Run tests with coverage
[group('test')]
test-coverage:
    cd infra && yarn test:coverage

# Run unit tests only
[group('test')]
test-unit:
    cd infra && yarn test:unit

# Run a specific test file (e.g., just test-file tests/unit/stacks/k8s/edge-stack.test.ts)
[group('test')]
test-file path:
    cd infra && CDK_BUNDLING_STACKS='[]' npx jest {{path}} --no-coverage

# Run integration tests (post-deployment — calls real AWS APIs)
# Usage: just ci-integration-test kubernetes development
[group('ci')]
ci-integration-test project environment *ARGS:
    cd infra && NODE_OPTIONS='--experimental-vm-modules' CDK_ENV={{environment}} npx jest --config jest.integration.config.js --testPathPattern="tests/integration/{{project}}" {{ARGS}}

# Run integration tests locally (with AWS profile)
# Usage: just test-integration kubernetes development
[group('test')]
test-integration project environment *ARGS:
    cd infra && NODE_OPTIONS='--experimental-vm-modules' AWS_PROFILE=$(just _profile {{environment}}) CDK_ENV={{environment}} npx jest --config jest.integration.config.js --testPathPattern="tests/integration/{{project}}" {{ARGS}}

# Run a specific integration test file locally (with AWS profile)
# Usage: just test-integration-file tests/integration/kubernetes/bluegreen.integration.test.ts development
[group('test')]
test-integration-file path environment *ARGS:
    cd infra && NODE_OPTIONS='--experimental-vm-modules' AWS_PROFILE=$(just _profile {{environment}}) CDK_ENV={{environment}} npx jest --config jest.integration.config.js {{path}} {{ARGS}}

# Run Golden AMI integration test locally
# Verifies AMI properties, security posture, tags, and pipeline freshness.
# Usage: just test-golden-ami development
[group('test')]
test-golden-ami environment *ARGS:
    cd infra && NODE_OPTIONS='--experimental-vm-modules' AWS_PROFILE=$(just _profile {{environment}}) CDK_ENV={{environment}} npx jest --config jest.integration.config.js --testPathPattern="tests/integration/kubernetes/golden-ami-stack" --verbose {{ARGS}}

# Run frontend-ops tests (sync script + workflow validation)
# Usage: just test-frontend-ops
[group('test')]
test-frontend-ops *ARGS:
    npx jest --config frontend-ops/jest.config.js {{ARGS}}

# =============================================================================
# CODE QUALITY
# =============================================================================

# Run ESLint
[group('quality')]
lint:
    cd infra && yarn lint

# Run ESLint with auto-fix
[group('quality')]
lint-fix:
    cd infra && yarn lint:fix

# TypeScript type checking (no emit)
[group('quality')]
typecheck:
    cd infra && yarn typecheck

# Full health check (lint + unused + deps)
[group('quality')]
health:
    cd infra && yarn health

# CI health check (stricter output)
[group('quality')]
health-ci:
    cd infra && yarn health:ci

# Validate dependency rules (local — interactive output)
# Uses dependency-cruiser to enforce architectural boundaries.
[group('quality')]
deps-check:
    cd infra && yarn deps:check

# Validate dependency rules (CI — stricter err-long output)
# Called by: .github/workflows/ci.yml → deps-check job
[group('quality')]
deps-check-ci:
    cd infra && yarn deps:check:ci

# Find unused exports
[group('quality')]
find-unused:
    cd infra && yarn find:unused

# CDK validation (synth + nag)
[group('quality')]
lint-cdk:
    cd infra && yarn lint:cdk

# Run security audit on dependencies
[group('quality')]
audit *ARGS:
    cd infra && yarn npm audit --all --recursive --no-deprecations --severity high {{ARGS}}

# Validate synthesized CloudFormation templates with cfn-lint
[group('quality')]
validate:
    #!/usr/bin/env bash
    if [ ! -d "infra/cdk.out" ]; then
      echo "❌ infra/cdk.out/ not found. Run 'just synth <project> <env>' first."
      exit 1
    fi
    templates=$(ls infra/cdk.out/*.template.json 2>/dev/null | wc -l)
    echo "ℹ Found ${templates} CloudFormation templates"
    cfn-lint "infra/cdk.out/**/*.template.json"

# Run Checkov IaC security scan against synthesized templates
[group('quality')]
security-scan *ARGS:
    #!/usr/bin/env bash
    if [ ! -d "infra/cdk.out" ]; then
      echo "❌ infra/cdk.out/ not found. Run 'just synth <project> <env>' first."
      exit 1
    fi
    mkdir -p security-reports
    checkov --directory infra/cdk.out --framework cloudformation --compact --quiet \
      -o cli -o json --output-file-path security-reports {{ARGS}}


# =============================================================================
# KUBERNETES
# =============================================================================

# Sync Grafana dashboards to S3
# TODO: sync-dashboards.ts does not exist yet — uncomment when implemented
# [group('k8s')]
# k8s-dashboards *ARGS:
#     npx tsx infra/scripts/pipeline/sync-dashboards.ts {{ARGS}}



# Trigger Golden AMI build (Image Builder)
[group('k8s')]
k8s-build-golden-ami env="development" region="eu-west-1":
    npx tsx kubernetes-app/infra-ami/scripts/build-golden-ami.ts {{env}} --region {{region}}

# Validate Grafana dashboard JSON files (syntax, schema, unique UIDs)
# Catches broken dashboards BEFORE Helm render or ArgoCD sync.
# Called by: .github/workflows/gitops-k8s-dev.yml → validate job
[group('k8s')]
validate-dashboards:
    npx tsx kubernetes-app/platform/charts/monitoring/scripts/validate-dashboards.ts

# Run dashboard validation test suite (per-file granularity)
# Uses node:test for IDE integration and detailed test reports.
[group('test')]
test-dashboards:
    npx tsx --test kubernetes-app/platform/charts/monitoring/tests/validate-dashboards.test.ts

# Validate all Helm charts (lint + template render)
# Catches rendering errors (broken delimiters, missing values) BEFORE ArgoCD sync.
# Called by: .github/workflows/gitops-k8s-dev.yml → validate job
[group('k8s')]
helm-validate-charts:
    #!/usr/bin/env bash
    set -euo pipefail
    ERRORS=0

    echo "=== Helm Chart Validation ==="
    echo ""

    # --- Next.js chart ---
    echo "--- Next.js chart ---"
    if helm lint kubernetes-app/workloads/charts/nextjs/chart \
         -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml 2>&1; then
      echo "  ✓ lint passed"
    else
      echo "  ✗ lint FAILED"
      ERRORS=$((ERRORS + 1))
    fi

    if helm template nextjs-app kubernetes-app/workloads/charts/nextjs/chart \
         -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml > /dev/null 2>&1; then
      echo "  ✓ template render passed"
    else
      echo "  ✗ template render FAILED"
      helm template nextjs-app kubernetes-app/workloads/charts/nextjs/chart \
        -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml 2>&1 || true
      ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # --- Monitoring chart ---
    echo "--- Monitoring chart ---"
    if helm lint kubernetes-app/platform/charts/monitoring/chart \
         -f kubernetes-app/platform/charts/monitoring/chart/values-development.yaml 2>&1; then
      echo "  ✓ lint passed"
    else
      echo "  ✗ lint FAILED"
      ERRORS=$((ERRORS + 1))
    fi

    if helm template monitoring-stack kubernetes-app/platform/charts/monitoring/chart \
         -f kubernetes-app/platform/charts/monitoring/chart/values-development.yaml > /dev/null 2>&1; then
      echo "  ✓ template render passed"
    else
      echo "  ✗ template render FAILED"
      helm template monitoring-stack kubernetes-app/platform/charts/monitoring/chart \
        -f kubernetes-app/platform/charts/monitoring/chart/values-development.yaml 2>&1 || true
      ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # --- Golden Path Service chart ---
    echo "--- Golden Path Service chart ---"
    if helm lint kubernetes-app/workloads/charts/golden-path-service/chart \
         -f kubernetes-app/workloads/charts/golden-path-service/chart/values.yaml 2>&1; then
      echo "  ✓ lint passed"
    else
      echo "  ✗ lint FAILED"
      ERRORS=$((ERRORS + 1))
    fi

    if helm template golden-path kubernetes-app/workloads/charts/golden-path-service/chart \
         -f kubernetes-app/workloads/charts/golden-path-service/chart/values.yaml > /dev/null 2>&1; then
      echo "  ✓ template render passed"
    else
      echo "  ✗ template render FAILED"
      helm template golden-path kubernetes-app/workloads/charts/golden-path-service/chart \
        -f kubernetes-app/workloads/charts/golden-path-service/chart/values.yaml 2>&1 || true
      ERRORS=$((ERRORS + 1))
    fi
    echo ""

    if [ $ERRORS -gt 0 ]; then
      echo "✗ $ERRORS chart validations FAILED"
      exit 1
    fi
    echo "✓ All Helm charts validated successfully"

# Render templates and verify nodeSelector placement (workload=frontend)
[group('k8s')]
helm-verify-selectors:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== NextJS Chart ==="
    helm template nextjs-app \
      kubernetes-app/workloads/charts/nextjs/chart \
      -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml \
      --namespace nextjs-app | grep -c "workload: frontend" | \
      xargs -I{} echo "  nodeSelector entries: {} (expected 1)"
    echo "Done."

# Check SourceDestCheck status on all K8s compute instances
# Filters by Stack tag to show only K8s nodes (control-plane, app-worker, mon-worker).
# SourceDestCheck must be false for Calico pod networking (required even with VXLANAlways).
[group('k8s')]
k8s-check-source-dest region="eu-west-1" profile="dev-account":
    aws ec2 describe-instances \
      --filters \
        "Name=tag:Stack,Values=KubernetesCompute,KubernetesWorkerApp,KubernetesWorkerMonitoring" \
        "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value|[0],NetworkInterfaces[0].SourceDestCheck]' \
      --output table \
      --region {{region}} \
      --profile {{profile}}

# List all running EC2 instances with private IP and SourceDestCheck
[group('k8s')]
ec2-list-instances region="eu-west-1" profile="dev-account":
    aws ec2 describe-instances \
      --filters "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,Tags[?Key==`Name`].Value|[0],NetworkInterfaces[0].SourceDestCheck]' \
      --output table \
      --region {{region}} \
      --profile {{profile}}

# Disable SourceDestCheck on a specific EC2 instance
# Required for Kubernetes pod networking (Calico VXLAN encapsulation).
# Usage: just ec2-disable-source-dest-check i-069286d4c9098608b
[group('k8s')]
ec2-disable-source-dest-check instance-id region="eu-west-1" profile="dev-account":
    aws ec2 modify-instance-attribute \
      --instance-id {{instance-id}} \
      --no-source-dest-check \
      --region {{region}} \
      --profile {{profile}}

# Trigger SSM Automation — Control Plane bootstrap (7 steps)
# Runs: validateGoldenAMI → initKubeadm → installCalicoCNI → configureKubectl
#       → syncManifests → bootstrapArgoCD → verifyCluster
# Usage: just ssm-run-controlplane i-0f1491fd3dc63fd66
[group('k8s')]
ssm-run-controlplane instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    # Map full env name → short env (matches CDK shortEnv() used in doc names)
    case "{{env}}" in
      development) SHORT_ENV="dev" ;;
      staging)     SHORT_ENV="stg" ;;
      production)  SHORT_ENV="prd" ;;
      *)           SHORT_ENV="{{env}}" ;;
    esac
    SSM_PREFIX="/k8s/{{env}}"
    S3_BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "Starting control-plane bootstrap on {{instance-id}}..."
    EXEC_ID=$(aws ssm start-automation-execution \
      --document-name "k8s-${SHORT_ENV}-bootstrap-control-plane" \
      --parameters "InstanceId={{instance-id}},SsmPrefix=${SSM_PREFIX},S3Bucket=${S3_BUCKET},Region={{region}}" \
      --region {{region}} --profile {{profile}} \
      --query "AutomationExecutionId" --output text)
    echo "Execution ID: ${EXEC_ID}"
    echo "Monitor:  just ssm-status ${EXEC_ID} {{region}} {{profile}}"

# Trigger SSM Automation — Worker node bootstrap (2 steps)
# Runs: validateGoldenAMI → joinCluster
# Run AFTER control-plane has completed (workers need join credentials).
# Usage: just ssm-run-worker i-071c910118e0c0beb
[group('k8s')]
ssm-run-worker instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    # Map full env name → short env (matches CDK shortEnv() used in doc names)
    case "{{env}}" in
      development) SHORT_ENV="dev" ;;
      staging)     SHORT_ENV="stg" ;;
      production)  SHORT_ENV="prd" ;;
      *)           SHORT_ENV="{{env}}" ;;
    esac
    SSM_PREFIX="/k8s/{{env}}"
    S3_BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "Starting worker bootstrap on {{instance-id}}..."
    EXEC_ID=$(aws ssm start-automation-execution \
      --document-name "k8s-${SHORT_ENV}-bootstrap-worker" \
      --parameters "InstanceId={{instance-id}},SsmPrefix=${SSM_PREFIX},S3Bucket=${S3_BUCKET},Region={{region}}" \
      --region {{region}} --profile {{profile}} \
      --query "AutomationExecutionId" --output text)
    echo "Execution ID: ${EXEC_ID}"
    echo "Monitor:  just ssm-status ${EXEC_ID} {{region}} {{profile}}"

# Check SSM Automation execution status and step progress
# Usage: just ssm-status <execution-id>
[group('k8s')]
ssm-status execution-id region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    aws ssm get-automation-execution \
      --automation-execution-id {{execution-id}} \
      --query "AutomationExecution.{Status:AutomationExecutionStatus,Steps:StepExecutions[*].{Step:StepName,Status:StepStatus,Start:ExecutionStartTime,End:ExecutionEndTime}}" \
      --output table \
      --region {{region}} --profile {{profile}}

# List latest SSM Automation executions for all bootstrap documents
# Shows: execution ID, status, timing, and per-step progress for each
# bootstrap type (control-plane + worker).
# Usage: just ssm-bootstrap-status
#        just ssm-bootstrap-status 5          # last 5 executions per doc
[group('k8s')]
ssm-bootstrap-status count="3" env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    # Map full environment names to short abbreviations (matches CDK shortEnv())
    case "{{env}}" in
      development) SHORT_ENV="dev" ;;
      staging)     SHORT_ENV="stg" ;;
      production)  SHORT_ENV="prd" ;;
      *)           SHORT_ENV="{{env}}" ;;
    esac
    DOCS=("k8s-${SHORT_ENV}-bootstrap-control-plane" "k8s-${SHORT_ENV}-bootstrap-worker")
    for DOC in "${DOCS[@]}"; do
      echo "═══════════════════════════════════════════════════════════"
      echo "  📄  ${DOC}"
      echo "═══════════════════════════════════════════════════════════"
      echo ""
      EXEC_IDS=$(aws ssm describe-automation-executions \
        --filters "Key=DocumentNamePrefix,Values=${DOC}" \
        --max-results {{count}} \
        --query "AutomationExecutionMetadataList[*].[AutomationExecutionId,AutomationExecutionStatus,ExecutionStartTime,ExecutionEndTime]" \
        --output text \
        --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
      if [ -z "$EXEC_IDS" ]; then
        echo "  (no executions found)"
        echo ""
        continue
      fi
      while IFS=$'\t' read -r EXEC_ID STATUS START END; do
        echo "  ▸ ${EXEC_ID}"
        echo "    Status: ${STATUS}  |  Start: ${START}  |  End: ${END:-—}"
        echo "    Steps:"
        aws ssm get-automation-execution \
          --automation-execution-id "${EXEC_ID}" \
          --query "AutomationExecution.StepExecutions[*].[StepName,StepStatus]" \
          --output text \
          --region {{region}} --profile {{profile}} 2>/dev/null | \
          while IFS=$'\t' read -r STEP_NAME STEP_STATUS; do
            case "${STEP_STATUS}" in
              Success)    ICON="✅" ;;
              Failed)     ICON="❌" ;;
              InProgress) ICON="🔄" ;;
              Cancelled)  ICON="⛔" ;;
              TimedOut)   ICON="⏰" ;;
              *)          ICON="⬜" ;;
            esac
            printf "      %s  %-40s %s\n" "${ICON}" "${STEP_NAME}" "${STEP_STATUS}"
          done
        echo ""
      done <<< "$EXEC_IDS"
    done

# Retrieve stdout/stderr logs for each step of the latest SSM Automation
# bootstrap execution. Fetches per-step output via `get-command-invocation`.
# Usage: just ssm-bootstrap-logs
#        just ssm-bootstrap-logs 100                  # last 100 lines per step
#        just ssm-bootstrap-logs 50 development worker # worker doc only
[group('k8s')]
ssm-bootstrap-logs tail="50" env="development" doc="all" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    # Map full environment names to short abbreviations (matches CDK shortEnv())
    case "{{env}}" in
      development) SHORT_ENV="dev" ;;
      staging)     SHORT_ENV="stg" ;;
      production)  SHORT_ENV="prd" ;;
      *)           SHORT_ENV="{{env}}" ;;
    esac
    # Build document list based on doc filter
    case "{{doc}}" in
      control-plane) DOCS=("k8s-${SHORT_ENV}-bootstrap-control-plane") ;;
      worker)        DOCS=("k8s-${SHORT_ENV}-bootstrap-worker") ;;
      *)             DOCS=("k8s-${SHORT_ENV}-bootstrap-control-plane" "k8s-${SHORT_ENV}-bootstrap-worker") ;;
    esac
    for DOC in "${DOCS[@]}"; do
      echo ""
      echo "╔═══════════════════════════════════════════════════════════╗"
      echo "║  📄  ${DOC}"
      echo "╚═══════════════════════════════════════════════════════════╝"
      echo ""
      # Get the latest execution for this document
      LATEST=$(aws ssm describe-automation-executions \
        --filters "Key=DocumentNamePrefix,Values=${DOC}" \
        --max-results 1 \
        --query "AutomationExecutionMetadataList[0].AutomationExecutionId" \
        --output text \
        --region {{region}} --profile {{profile}} 2>/dev/null || echo "None")
      if [ "$LATEST" = "None" ] || [ -z "$LATEST" ]; then
        echo "  (no executions found)"
        continue
      fi
      echo "  Execution: ${LATEST}"
      echo ""
      # Get step details: name, status, and commandId
      STEPS_JSON=$(aws ssm get-automation-execution \
        --automation-execution-id "${LATEST}" \
        --query "AutomationExecution.StepExecutions[*].{Name:StepName,Status:StepStatus,Outputs:Outputs}" \
        --output json \
        --region {{region}} --profile {{profile}} 2>/dev/null)
      STEP_COUNT=$(echo "$STEPS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
      if [ "$STEP_COUNT" = "0" ]; then
        echo "  (no steps found)"
        continue
      fi
      for i in $(seq 0 $(( STEP_COUNT - 1 ))); do
        STEP_NAME=$(echo "$STEPS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[$i]['Name'])")
        STEP_STATUS=$(echo "$STEPS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[$i]['Status'])")
        # Extract CommandId from step outputs (aws:runCommand outputs include CommandId)
        COMMAND_ID=$(echo "$STEPS_JSON" | python3 -c "
    import sys, json
    d = json.load(sys.stdin)
    outputs = d[$i].get('Outputs', {})
    cmd_id = outputs.get('CommandId', [''])[0] if outputs else ''
    print(cmd_id)
    " 2>/dev/null || echo "")
        case "${STEP_STATUS}" in
          Success)    ICON="✅" ;;
          Failed)     ICON="❌" ;;
          InProgress) ICON="🔄" ;;
          Cancelled)  ICON="⛔" ;;
          TimedOut)   ICON="⏰" ;;
          *)          ICON="⬜" ;;
        esac
        echo "  ┌─────────────────────────────────────────────────────────"
        printf "  │ %s  %-40s %s\n" "${ICON}" "${STEP_NAME}" "${STEP_STATUS}"
        echo "  └─────────────────────────────────────────────────────────"
        if [ -z "$COMMAND_ID" ]; then
          echo "    (no command output available — step may not have executed)"
          echo ""
          continue
        fi
        # Resolve the target instance ID from the automation parameters
        INSTANCE_ID=$(aws ssm get-automation-execution \
          --automation-execution-id "${LATEST}" \
          --query "AutomationExecution.Parameters.InstanceId[0]" \
          --output text \
          --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
        if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
          echo "    (could not resolve instance ID)"
          echo ""
          continue
        fi
        # Fetch command invocation output (stdout + stderr)
        OUTPUT_JSON=$(aws ssm get-command-invocation \
          --command-id "${COMMAND_ID}" \
          --instance-id "${INSTANCE_ID}" \
          --query "{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}" \
          --output json \
          --region {{region}} --profile {{profile}} 2>/dev/null || echo '{"Status":"NotFound","Stdout":"","Stderr":""}')
        STDOUT=$(echo "$OUTPUT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('Stdout',''))" 2>/dev/null || echo "")
        STDERR=$(echo "$OUTPUT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('Stderr',''))" 2>/dev/null || echo "")
        if [ -n "$STDOUT" ]; then
          echo "    ── stdout (last {{tail}} lines) ──"
          echo "$STDOUT" | tail -n {{tail}} | sed 's/^/    /'
        fi
        if [ -n "$STDERR" ]; then
          echo "    ── stderr (last {{tail}} lines) ──"
          echo "$STDERR" | tail -n {{tail}} | sed 's/^/    /'
        fi
        if [ -z "$STDOUT" ] && [ -z "$STDERR" ]; then
          echo "    (output empty or truncated — check CloudWatch log group /ssm/k8s/{{env}}/bootstrap)"
        fi
        echo ""
      done
    done

# Run unified SSM bootstrap diagnostics — combines execution status,
# step logs (stdout/stderr), and S3 sync verification into a single report.
# Usage: just ssm-diagnose
#        just ssm-diagnose --env staging --tail 100
[group('k8s')]
ssm-diagnose *ARGS:
    ./scripts/local/diagnostics/ssm-bootstrap-diagnose.sh {{ARGS}}

# Show last S3 sync status for SSM Automation bootstrap and chart scripts.
# Displays per-prefix file counts and most recently modified objects.
# Usage: just ssm-s3-sync-status
#        just ssm-s3-sync-status development 10  # last 10 files per prefix
[group('k8s')]
ssm-s3-sync-status env="development" count="5" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{env}}/scripts-bucket"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  🪣  S3 Sync Status — {{env}}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    # Resolve bucket name from SSM
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region {{region}} \
      --profile "{{profile}}" 2>/dev/null | sed 's|^s3://||;s|/$||')
    if [ -z "$BUCKET" ]; then
      echo "  ❌ SSM parameter ${SSM_KEY} not found."
      echo "     Has the infrastructure pipeline been deployed?"
      exit 1
    fi
    echo "  Bucket: s3://${BUCKET}"
    echo ""
    PREFIXES=("k8s-bootstrap/" "platform/charts/" "workloads/charts/")
    for PREFIX in "${PREFIXES[@]}"; do
      echo "  ┌─────────────────────────────────────────────────────────"
      echo "  │ 📂 ${PREFIX}"
      echo "  └─────────────────────────────────────────────────────────"
      # List all objects under this prefix
      LISTING=$(aws s3api list-objects-v2 \
        --bucket "${BUCKET}" \
        --prefix "${PREFIX}" \
        --query "Contents[*].{Key:Key,Modified:LastModified,Size:Size}" \
        --output json \
        --region {{region}} --profile "{{profile}}" 2>/dev/null || echo "[]")
      TOTAL=$(echo "$LISTING" | python3 -c "
    import sys, json
    d = json.load(sys.stdin)
    print(len(d) if isinstance(d, list) else 0)
    " 2>/dev/null || echo "0")
      if [ "$TOTAL" = "0" ] || [ "$TOTAL" = "null" ]; then
        echo "    (no files found)"
        echo ""
        continue
      fi
      # Find the most recent modification timestamp
      NEWEST=$(echo "$LISTING" | python3 -c "
    import sys, json
    data = json.load(sys.stdin)
    if data:
        print(max(d['Modified'] for d in data))
    else:
        print('N/A')
    " 2>/dev/null || echo "N/A")
      echo "    Total files : ${TOTAL}"
      echo "    Last sync   : ${NEWEST}"
      echo ""
      # Show the N most recently modified files
      echo "    Most recently modified (last {{count}}):"
      echo "$LISTING" | python3 -c "
    import sys, json
    data = json.load(sys.stdin)
    if not data:
        sys.exit(0)
    data.sort(key=lambda x: x['Modified'], reverse=True)
    for obj in data[:{{count}}]:
        size_kb = obj['Size'] / 1024
        ts = obj['Modified'][:19].replace('T', ' ')
        name = obj['Key'].replace('${PREFIX}', '', 1)
        print(f'      {ts}  {size_kb:>7.1f} KB  {name}')
    " 2>/dev/null
      echo ""
    done

# =============================================================================
# LOCAL BOOTSTRAP TESTING (push to S3 → pull on instance → run)
#
# Workflow for testing ArgoCD bootstrap changes on the control plane
# without going through CI/CD:
#   1. just bootstrap-sync          — push local scripts to S3
#   2. just bootstrap-pull <id>     — pull from S3 onto the instance
#   3. just bootstrap-dry-run <id>  — dry-run the bootstrap on the instance
#   4. just bootstrap-run <id>      — run the real bootstrap
#
# Or use the combined recipe:
#   just bootstrap-test <id>        — sync + pull + dry-run (all-in-one)
# =============================================================================

# Sync local k8s-bootstrap scripts to S3 (push your changes)
# Usage: just bootstrap-sync
[group('k8s')]
bootstrap-sync env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{env}}/scripts-bucket"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region {{region}} --profile {{profile}})
    if [ -z "$BUCKET" ]; then
      echo "❌ SSM parameter ${SSM_KEY} not found."
      exit 1
    fi
    echo "📤 Syncing local k8s-bootstrap → s3://${BUCKET}/k8s-bootstrap/"
    aws s3 sync kubernetes-app/k8s-bootstrap/ "s3://${BUCKET}/k8s-bootstrap/" \
      --delete \
      --exclude '__pycache__/*' \
      --exclude '*.pyc' \
      --exclude 'tests/*' \
      --exclude '.venv/*' \
      --exclude '.pyre_configuration' \
      --exclude '.pyre_configuration.local' \
      --exclude 'pyproject.toml' \
      --exclude '.mypy_cache/*' \
      --region {{region}} --profile {{profile}}
    echo ""
    echo "✅ Scripts pushed to S3. Next: just bootstrap-pull <instance-id>"

# Pull latest scripts from S3 onto the control plane instance
# Usage: just bootstrap-pull i-0f1491fd3dc63fd66
[group('k8s')]
bootstrap-pull instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{env}}/scripts-bucket"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region {{region}} --profile {{profile}})
    echo "📥 Pulling scripts from S3 onto {{instance-id}}..."
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['aws s3 sync s3://${BUCKET}/k8s-bootstrap/ /data/k8s-bootstrap/ --delete --region {{region}} && echo \"✅ Scripts synced to /data/k8s-bootstrap/\"']" \
      --timeout-seconds 120 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}"
    echo "  Waiting for completion..."
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}}
    echo ""
    echo "✅ Scripts pulled. Next: just bootstrap-dry-run {{instance-id}}"

# Dry-run the ArgoCD bootstrap on the control plane (no changes applied)
# Usage: just bootstrap-dry-run i-0f1491fd3dc63fd66
[group('k8s')]
bootstrap-dry-run instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "🧪 Running ArgoCD bootstrap --dry-run on {{instance-id}}..."
    # Delegates to bootstrap-argocd.sh which self-heals pip3 on AL2023.
    # Direct pip3 calls fail with exit 127 because python3-pip is not pre-installed.
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['KUBECONFIG=/etc/kubernetes/admin.conf bash /data/k8s-bootstrap/system/argocd/bootstrap-argocd.sh --dry-run 2>&1']" \
      --timeout-seconds 300 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}"
    echo "  Waiting for completion (up to 5 min)..."
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}}

# Run the real ArgoCD bootstrap on the control plane (output saved to local log)
# Usage: just bootstrap-run i-0f1491fd3dc63fd66
[group('k8s')]
bootstrap-run instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    LOG_DIR="kubernetes-app/k8s-bootstrap/logs"
    mkdir -p "${LOG_DIR}"
    TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
    LOG_FILE="${LOG_DIR}/bootstrap-run-${TIMESTAMP}.log"
    echo "🚀 Running ArgoCD bootstrap on {{instance-id}}..."
    echo "   ⚠ This will apply real changes to the cluster!"
    echo "   📄 Log: ${LOG_FILE}"
    echo ""
    {
      echo "=== ArgoCD Bootstrap Run ==="
      echo "Instance:    {{instance-id}}"
      echo "Environment: {{env}}"
      echo "Region:      {{region}}"
      echo "Timestamp:   ${TIMESTAMP}"
      echo ""
    } | tee "${LOG_FILE}"
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['KUBECONFIG=/etc/kubernetes/admin.conf bash /data/k8s-bootstrap/system/argocd/bootstrap-argocd.sh 2>&1']" \
      --timeout-seconds 600 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}" | tee -a "${LOG_FILE}"
    echo "  Waiting for completion (up to 10 min)..." | tee -a "${LOG_FILE}"
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}} | tee -a "${LOG_FILE}"
    echo ""
    echo "✅ Log saved to: ${LOG_FILE}"

# Full bootstrap test workflow: sync → pull → dry-run (all-in-one)
# Usage: just bootstrap-test i-0f1491fd3dc63fd66
[group('k8s')]
bootstrap-test instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🔄  Bootstrap Test Workflow"
    echo "  Instance: {{instance-id}}"
    echo "  Environment: {{env}}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "── Step 1/3: Sync scripts to S3 ──"
    just bootstrap-sync {{env}} {{region}} {{profile}}
    echo ""
    echo "── Step 2/3: Pull scripts onto instance ──"
    just bootstrap-pull {{instance-id}} {{env}} {{region}} {{profile}}
    echo ""
    echo "── Step 3/3: Dry-run bootstrap ──"
    just bootstrap-dry-run {{instance-id}} {{env}} {{region}} {{profile}}
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  ✅  Dry-run complete! To apply for real:"
    echo "     just bootstrap-run {{instance-id}}"
    echo "═══════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────────────────────
# Config Orchestrator (SM-B) — local developer recipes
#
# SM-B injects all application secrets into K8s without re-running bootstrap.
# It is triggered automatically by EventBridge when SM-A succeeds, but you
# can also invoke it manually via these recipes during:
#   - Local secret rotation testing
#   - Standalone config re-injection after a partial failure
#   - Verifying new deploy.py scripts before committing to CI
#
# Pre-requisites:
#   1. SsmAutomation CDK stack deployed  (just deploy-stack SsmAutomation-development)
#   2. SM-A has run at least once  (SSM param control-plane-instance-id populated)
# ─────────────────────────────────────────────────────────────────────────────

# Trigger Config Orchestrator (SM-B) — injects all app secrets into K8s
# Usage: just config-run development
# Usage: just config-run development eu-west-1
[group('k8s')]
config-run env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🔑  Config Orchestrator (SM-B)"
    echo "  Environment : {{env}}"
    echo "  Region      : {{region}}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    npx tsx infra/scripts/cd/trigger-config.ts \
        --environment {{env}} \
        --region {{region}} \
        --max-wait 3600
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  ✅  Config injection complete"
    echo "═══════════════════════════════════════════════════════════"

# Show recent Config Orchestrator (SM-B) execution history
# Usage: just config-status
# Usage: just config-status 5 staging eu-west-1 dev-account
[group('k8s')]
config-status count="3" env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PREFIX="/k8s/{{env}}"
    CONFIG_SM_ARN=$(aws ssm get-parameter \
        --name "${SSM_PREFIX}/bootstrap/config-state-machine-arn" \
        --query Parameter.Value --output text \
        --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
    if [ -z "$CONFIG_SM_ARN" ] || [ "$CONFIG_SM_ARN" = "None" ]; then
        echo "❌  Config SM ARN not found at ${SSM_PREFIX}/bootstrap/config-state-machine-arn"
        echo "    Run: just deploy-stack SsmAutomation-{{env}} kubernetes {{env}}"
        exit 1
    fi
    echo "Config Orchestrator (SM-B) — last {{count}} executions"
    echo "ARN: $CONFIG_SM_ARN"
    echo ""
    aws stepfunctions list-executions \
        --state-machine-arn "$CONFIG_SM_ARN" \
        --max-results {{count}} \
        --query "executions[].{Name:name,Status:status,Start:startDate,Stop:stopDate}" \
        --output table \
        --region {{region}} --profile {{profile}}

# Run k8s-bootstrap Python tests locally (unit + static validation)
# Usage: just bootstrap-pytest
# Usage: just bootstrap-pytest tests/system/test_dr_scripts.py   (specific file)
[group('k8s')]
bootstrap-pytest *args:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🧪  k8s-bootstrap — Python Test Suite"
    echo "═══════════════════════════════════════════════════════════"
    cd kubernetes-app/k8s-bootstrap
    python -m pytest {{args}}

# Run boot/ tests locally (mocked — no AWS credentials required)
# Usage: just boot-test-local                           (all boot tests)
# Usage: just boot-test-local test_ebs_volume.py        (single file)
# Usage: just boot-test-local -k "test_returns_nvme"    (single test)
[group('test')]
boot-test-local *args:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🧪  boot/ — Local Unit Tests (mocked)"
    echo "═══════════════════════════════════════════════════════════"
    cd kubernetes-app/k8s-bootstrap
    python -m pytest tests/boot/ -v {{args}}

# Run deploy_helpers/ tests locally (mocked — no AWS credentials required)
# Usage: just deploy-test-local                           (all deploy tests)
# Usage: just deploy-test-local test_ssm.py               (single file)
# Usage: just deploy-test-local -k "test_resolves_single"  (single test)
[group('test')]
deploy-test-local *args:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🧪  deploy_helpers/ — Local Unit Tests (mocked)"
    echo "═══════════════════════════════════════════════════════════"
    cd kubernetes-app/k8s-bootstrap
    python -m pytest tests/deploy/ -v {{args}}

# Run deploy.py on a live instance via SSM RunCommand (dry-run by default)
# Prerequisites: just bootstrap-sync && just bootstrap-pull <id>
# Usage: just deploy-test-live i-0f1491fd3dc63fd66 nextjs
# Usage: just deploy-test-live i-0f1491fd3dc63fd66 monitoring
# Usage: just deploy-test-live i-0f1491fd3dc63fd66 nextjs --no-dry-run
[group('test')]
deploy-test-live instance-id app="nextjs" dry_run="--dry-run" env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    LOG_DIR="kubernetes-app/k8s-bootstrap/logs"
    mkdir -p "${LOG_DIR}"
    TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
    LOG_FILE="${LOG_DIR}/deploy-{{app}}-${TIMESTAMP}.log"

    # Determine script path based on app
    if [[ "{{app}}" == "nextjs" ]]; then
      SCRIPT_PATH="/data/app-deploy/nextjs/deploy.py"
    elif [[ "{{app}}" == "monitoring" ]]; then
      SCRIPT_PATH="/data/app-deploy/monitoring/deploy.py"
    else
      echo "❌ Unknown app: {{app}} (expected 'nextjs' or 'monitoring')"
      exit 1
    fi

    # Build command (dry-run by default)
    DRY_FLAG=""
    if [[ "{{dry_run}}" == "--dry-run" ]]; then
      DRY_FLAG="--dry-run"
      echo "  🧪 Dry-run mode (use --no-dry-run for real deployment)"
    else
      echo "  ⚠ LIVE mode — will apply real changes!"
    fi

    echo "═══════════════════════════════════════════════════════════"
    echo "  🚀  Deploy Live Test — {{app}}"
    echo "  Instance: {{instance-id}}"
    echo "  Script:   ${SCRIPT_PATH}"
    echo "  Mode:     ${DRY_FLAG:-LIVE}"
    echo "  📄 Log:   ${LOG_FILE}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""

    {
      echo "=== Deploy Live Test ==="
      echo "App:         {{app}}"
      echo "Instance:    {{instance-id}}"
      echo "Environment: {{env}}"
      echo "Region:      {{region}}"
      echo "Dry-run:     {{dry_run}}"
      echo "Timestamp:   ${TIMESTAMP}"
      echo ""
    } | tee "${LOG_FILE}"

    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['source /etc/profile.d/k8s-env.sh 2>/dev/null || true && KUBECONFIG=/etc/kubernetes/admin.conf python3 ${SCRIPT_PATH} ${DRY_FLAG}']" \
      --timeout-seconds 300 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)

    echo "  Command ID: ${COMMAND_ID}" | tee -a "${LOG_FILE}"
    echo "  Waiting for completion (up to 5 min)..." | tee -a "${LOG_FILE}"

    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true

    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}} | tee -a "${LOG_FILE}"

    echo ""
    echo "✅ Log saved to: ${LOG_FILE}"

# Run control plane bootstrap on a live instance via SSM RunCommand
# Prerequisites: just bootstrap-sync && just bootstrap-pull <id>
# Usage: just boot-test-cp i-0f1491fd3dc63fd66
[group('k8s')]
boot-test-cp instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    LOG_DIR="kubernetes-app/k8s-bootstrap/logs"
    mkdir -p "${LOG_DIR}"
    TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
    LOG_FILE="${LOG_DIR}/boot-cp-${TIMESTAMP}.log"
    echo "🚀 Running control plane bootstrap on {{instance-id}}..."
    echo "   ⚠ This will apply real changes to the instance!"
    echo "   📄 Log: ${LOG_FILE}"
    echo ""
    {
      echo "=== Control Plane Bootstrap Run ==="
      echo "Instance:    {{instance-id}}"
      echo "Environment: {{env}}"
      echo "Region:      {{region}}"
      echo "Timestamp:   ${TIMESTAMP}"
      echo ""
    } | tee "${LOG_FILE}"
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['source /etc/profile.d/k8s-env.sh 2>/dev/null || true && cd /data/k8s-bootstrap/boot/steps && python3 control_plane.py']" \
      --timeout-seconds 900 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}" | tee -a "${LOG_FILE}"
    echo "  Waiting for completion (up to 15 min)..." | tee -a "${LOG_FILE}"
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}} | tee -a "${LOG_FILE}"
    echo ""
    echo "✅ Log saved to: ${LOG_FILE}"

# Run worker bootstrap on a live instance via SSM RunCommand
# Prerequisites: just bootstrap-sync && just bootstrap-pull <id>
# Run AFTER control plane has completed (worker needs join credentials).
# Usage: just boot-test-worker i-071c910118e0c0beb
[group('k8s')]
boot-test-worker instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    LOG_DIR="kubernetes-app/k8s-bootstrap/logs"
    mkdir -p "${LOG_DIR}"
    TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
    LOG_FILE="${LOG_DIR}/boot-worker-${TIMESTAMP}.log"
    echo "🚀 Running worker bootstrap on {{instance-id}}..."
    echo "   ⚠ This will apply real changes to the instance!"
    echo "   📄 Log: ${LOG_FILE}"
    echo ""
    {
      echo "=== Worker Bootstrap Run ==="
      echo "Instance:    {{instance-id}}"
      echo "Environment: {{env}}"
      echo "Region:      {{region}}"
      echo "Timestamp:   ${TIMESTAMP}"
      echo ""
    } | tee "${LOG_FILE}"
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['source /etc/profile.d/k8s-env.sh 2>/dev/null || true && cd /data/k8s-bootstrap/boot/steps && python3 worker.py']" \
      --timeout-seconds 600 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}" | tee -a "${LOG_FILE}"
    echo "  Waiting for completion (up to 10 min)..." | tee -a "${LOG_FILE}"
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}} | tee -a "${LOG_FILE}"
    echo ""
    echo "✅ Log saved to: ${LOG_FILE}"

# Full boot live test workflow: sync → pull → run control plane (all-in-one)
# Usage: just boot-test-live i-0f1491fd3dc63fd66                  (control plane)
# Usage: just boot-test-live i-071c910118e0c0beb worker           (worker)
[group('k8s')]
boot-test-live instance-id node="cp" env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🔄  Boot Live Test Workflow"
    echo "  Instance: {{instance-id}}"
    echo "  Node:     {{node}}"
    echo "  Environment: {{env}}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "── Step 1/3: Sync scripts to S3 ──"
    just bootstrap-sync {{env}} {{region}} {{profile}}
    echo ""
    echo "── Step 2/3: Pull scripts onto instance ──"
    just bootstrap-pull {{instance-id}} {{env}} {{region}} {{profile}}
    echo ""
    echo "── Step 3/3: Run bootstrap ({{node}}) ──"
    if [[ "{{node}}" == "worker" ]]; then
      just boot-test-worker {{instance-id}} {{env}} {{region}} {{profile}}
    else
      just boot-test-cp {{instance-id}} {{env}} {{region}} {{profile}}
    fi
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  ✅  Boot live test complete!"
    echo "═══════════════════════════════════════════════════════════"

# Usage: just cert-test i-0f1491fd3dc63fd66
# Usage: just cert-test i-0f1491fd3dc63fd66 backup     (backup only)
# Usage: just cert-test i-0f1491fd3dc63fd66 restore    (restore only)
[group('k8s')]
cert-test instance-id mode="both" secret="ops-tls-cert" namespace="kube-system" env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  🔒  TLS Certificate Persist — Dry-Run Test"
    echo "  Instance:  {{instance-id}}"
    echo "  Secret:    {{namespace}}/{{secret}}"
    echo "  Mode:      {{mode}}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""

    CERT_SCRIPT="/data/k8s-bootstrap/system/cert-manager/persist-tls-cert.py"
    BASE_CMD="KUBECONFIG=/etc/kubernetes/admin.conf python3 ${CERT_SCRIPT}"

    run_ssm_cmd() {
      local label="$1"
      local cmd="$2"
      echo "── ${label} ──"
      COMMAND_ID=$(aws ssm send-command \
        --instance-ids "{{instance-id}}" \
        --document-name "AWS-RunShellScript" \
        --parameters "commands=['${cmd}']" \
        --timeout-seconds 120 \
        --region {{region}} --profile {{profile}} \
        --query "Command.CommandId" --output text)
      echo "  Command ID: ${COMMAND_ID}"
      aws ssm wait command-executed \
        --command-id "${COMMAND_ID}" \
        --instance-id "{{instance-id}}" \
        --region {{region}} --profile {{profile}} 2>/dev/null || true
      aws ssm get-command-invocation \
        --command-id "${COMMAND_ID}" \
        --instance-id "{{instance-id}}" \
        --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
        --output yaml \
        --region {{region}} --profile {{profile}}
      echo ""
    }

    if [[ "{{mode}}" == "both" || "{{mode}}" == "backup" ]]; then
      run_ssm_cmd "Backup dry-run" "${BASE_CMD} --backup --secret {{secret}} --namespace {{namespace}} --dry-run"
    fi
    if [[ "{{mode}}" == "both" || "{{mode}}" == "restore" ]]; then
      run_ssm_cmd "Restore dry-run" "${BASE_CMD} --restore --secret {{secret}} --namespace {{namespace}} --dry-run"
    fi

    echo "═══════════════════════════════════════════════════════════"
    echo "  ✅  Dry-run complete! To run for real, use SSM directly:"
    echo "     --backup  → backs up K8s secret to SSM"
    echo "     --restore → restores K8s secret from SSM"
    echo "═══════════════════════════════════════════════════════════"

# Test etcd backup script on the control plane via SSM
# Usage: just etcd-test i-0f1491fd3dc63fd66          (check config only)
# Usage: just etcd-test i-0f1491fd3dc63fd66 run       (take a real backup)
[group('k8s')]
etcd-test instance-id mode="check" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "═══════════════════════════════════════════════════════════"
    echo "  💾  etcd Backup — Test (mode: {{mode}})"
    echo "  Instance: {{instance-id}}"
    echo "═══════════════════════════════════════════════════════════"
    echo ""

    if [[ "{{mode}}" == "check" ]]; then
      # Validate config without taking a snapshot — uses multiple commands to avoid quote nesting
      CMD="source /etc/profile.d/k8s-env.sh 2>/dev/null || true && echo S3_BUCKET=\${S3_BUCKET:-NOT_SET} && echo AWS_REGION=\${AWS_REGION:-NOT_SET} && echo [etcd certs] && ls -la /etc/kubernetes/pki/etcd/ 2>/dev/null || echo No etcd certs found && echo [etcdctl] && { command -v etcdctl && etcdctl version || echo etcdctl not in PATH, will use container fallback; } && echo [timer status] && systemctl is-active etcd-backup.timer 2>/dev/null || echo Timer not installed yet"
    elif [[ "{{mode}}" == "run" ]]; then
      CMD="bash /data/k8s-bootstrap/system/dr/etcd-backup.sh"
    else
      echo "ERROR: Unknown mode '{{mode}}'. Use 'check' or 'run'."
      exit 1
    fi

    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "{{instance-id}}" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=['${CMD}']" \
      --timeout-seconds 120 \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)
    echo "  Command ID: ${COMMAND_ID}"
    echo "  Waiting for completion..."
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "{{instance-id}}" \
      --query "{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}" \
      --output yaml \
      --region {{region}} --profile {{profile}}

# =============================================================================
# CROSS-ACCOUNT & OPS (delegates to standalone scripts)
# =============================================================================

# Deploy CrossAccountDnsRoleStack to root account (one-time setup)
# TODO: setup-dns-role.ts does not exist yet — uncomment when implemented
# [group('ops')]
# setup-dns-role profile hosted-zone-ids trusted-account-ids *ARGS:
#     npx tsx infra/scripts/pipeline/setup-dns-role.ts \
#       --profile {{profile}} \
#       --hosted-zone-ids {{hosted-zone-ids}} \
#       --trusted-account-ids {{trusted-account-ids}} \
#       {{ARGS}}

# Get CrossAccountDnsRoleStack outputs (role ARN)
# TODO: get-dns-role.ts does not exist yet — uncomment when implemented
# [group('ops')]
# get-dns-role profile *ARGS:
#     npx tsx infra/scripts/pipeline/get-dns-role.ts \
#       --profile {{profile}} \
#       {{ARGS}}

# Deploy Steampipe cross-account ReadOnly roles
# TODO: deploy-steampipe-roles.ts does not exist yet — uncomment when implemented
# [group('ops')]
# deploy-steampipe-roles monitoring-account *ARGS:
#     npx tsx infra/scripts/pipeline/deploy-steampipe-roles.ts \
#       --monitoring-account {{monitoring-account}} \
#       {{ARGS}}

# Delete a CloudFormation stack (e.g., just delete-stack MyStack eu-west-1 dev-account)
[group('ops')]
delete-stack stack region profile:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "⚠  About to DELETE stack '{{stack}}' in region '{{region}}' using profile '{{profile}}'"
    read -rp "Are you sure? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
    echo "→ Deleting stack '{{stack}}'…"
    aws cloudformation delete-stack \
      --stack-name "{{stack}}" \
      --region "{{region}}" \
      --profile "{{profile}}"
    echo "→ Waiting for stack deletion to complete…"
    aws cloudformation wait stack-delete-complete \
      --stack-name "{{stack}}" \
      --region "{{region}}" \
      --profile "{{profile}}"
    echo "✓ Stack '{{stack}}' deleted successfully."

# Delete a CloudWatch log group (e.g., just delete-log-group /aws/lambda/my-fn eu-west-1 dev-account)
[group('ops')]
delete-log-group log-group region profile:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "⚠  About to DELETE log group '{{log-group}}' in region '{{region}}' using profile '{{profile}}'"
    read -rp "Are you sure? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
    aws logs delete-log-group \
      --log-group-name "{{log-group}}" \
      --region "{{region}}" \
      --profile "{{profile}}"
    echo "✓ Log group '{{log-group}}' deleted."

# List k8s-bootstrap S3 contents (e.g., just list-k8s-bootstrap development eu-west-1 dev-account)
[group('ops')]
list-k8s-bootstrap env region profile:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ Resolving scripts bucket from SSM /k8s/{{env}}/scripts-bucket…"
    BUCKET=$(aws ssm get-parameter \
      --name "/k8s/{{env}}/scripts-bucket" \
      --query 'Parameter.Value' --output text \
      --region "{{region}}" \
      --profile "{{profile}}" 2>/dev/null || echo "")
    if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
      echo "✗ SSM parameter /k8s/{{env}}/scripts-bucket not found"
      exit 1
    fi
    BUCKET=$(echo "$BUCKET" | sed 's|^s3://||' | sed 's|/$||')
    echo "→ Listing s3://${BUCKET}/k8s-bootstrap/"
    echo ""
    aws s3 ls "s3://${BUCKET}/k8s-bootstrap/" \
      --recursive \
      --region "{{region}}" \
      --profile "{{profile}}"

# Update an inline IAM policy on a role (e.g., just update-oidc-policy eu-west-1 dev-account DevAccountOIDCRole ArgocdHealthCheckPolicy argocdHealthcheck.json)
[group('ops')]
update-oidc-policy region profile role-name policy-name policy-file:
    #!/usr/bin/env bash
    set -euo pipefail
    POLICY_FILE="infra/scripts/bootstrap/policies/{{policy-file}}"
    echo "→ Updating inline policy '{{policy-name}}' on role '{{role-name}}'"
    echo "  Source: ${POLICY_FILE}"
    aws iam put-role-policy \
      --role-name "{{role-name}}" \
      --policy-name "{{policy-name}}" \
      --policy-document "file://${POLICY_FILE}" \
      --profile "{{profile}}" \
      --region "{{region}}"
    echo "✓ Inline policy '{{policy-name}}' updated on role '{{role-name}}'."



# ---------------------------------------------------------------------------
# GitHub Workflow Dispatch (gh CLI)
# ---------------------------------------------------------------------------

# Trigger Pipeline A: K8s Infrastructure (e.g., just pipeline-infra develop)
[group('ops')]
pipeline-infra ref="develop":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ Triggering Pipeline A (Infrastructure) on ref: {{ref}}"
    gh workflow run deploy-kubernetes-dev.yml --ref {{ref}}
    sleep 2
    gh run list --workflow=deploy-kubernetes-dev.yml --limit=1

# Trigger Pipeline B: GitOps Applications (e.g., just pipeline-gitops develop)
[group('ops')]
pipeline-gitops ref="develop":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ Triggering Pipeline B (GitOps) on ref: {{ref}}"
    gh workflow run gitops-k8s-dev.yml --ref {{ref}}
    sleep 2
    gh run list --workflow=gitops-k8s-dev.yml --limit=1

# Watch the latest workflow run (blocks until complete)
[group('ops')]
pipeline-watch:
    gh run watch

# List recent workflow runs (all pipelines)
[group('ops')]
pipeline-status:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Pipeline A (Infrastructure) ==="
    gh run list --workflow=deploy-kubernetes-dev.yml --limit=3
    echo ""
    echo "=== Pipeline B (GitOps) ==="
    gh run list --workflow=gitops-k8s-dev.yml --limit=3

# Sync k8s-bootstrap scripts to S3 (e.g., just sync-k8s-bootstrap development dev-account)
[group('k8s')]
sync-k8s-bootstrap environment="development" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{environment}}/scripts-bucket"
    echo "→ Looking up S3 bucket from SSM: ${SSM_KEY}"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region eu-west-1 \
      --profile "{{profile}}" 2>/dev/null | sed 's|^s3://||;s|/$||')
    if [ -z "$BUCKET" ]; then
      echo "❌ SSM parameter ${SSM_KEY} not found. Has the Infra pipeline been deployed?"
      exit 1
    fi
    echo "→ Syncing kubernetes-app/k8s-bootstrap → s3://${BUCKET}/k8s-bootstrap/"
    aws s3 sync kubernetes-app/k8s-bootstrap "s3://${BUCKET}/k8s-bootstrap/" \
      --delete --region eu-west-1 --profile "{{profile}}"
    FILE_COUNT=$(aws s3 ls "s3://${BUCKET}/k8s-bootstrap/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    echo "✓ Bootstrap sync complete (${FILE_COUNT} files on S3)"

# Sync platform + workloads charts to S3 (e.g., just sync-k8s-charts development dev-account)
[group('k8s')]
sync-k8s-charts environment="development" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{environment}}/scripts-bucket"
    echo "→ Looking up S3 bucket from SSM: ${SSM_KEY}"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region eu-west-1 \
      --profile "{{profile}}" 2>/dev/null | sed 's|^s3://||;s|/$||')
    if [ -z "$BUCKET" ]; then
      echo "❌ SSM parameter ${SSM_KEY} not found. Has the Infra pipeline been deployed?"
      exit 1
    fi
    echo "→ Syncing platform charts → s3://${BUCKET}/platform/charts/"
    aws s3 sync kubernetes-app/platform/charts "s3://${BUCKET}/platform/charts/" \
      --delete --region eu-west-1 --profile "{{profile}}"
    echo "→ Syncing workloads charts → s3://${BUCKET}/workloads/charts/"
    aws s3 sync kubernetes-app/workloads/charts "s3://${BUCKET}/workloads/charts/" \
      --delete --region eu-west-1 --profile "{{profile}}"
    PLATFORM_COUNT=$(aws s3 ls "s3://${BUCKET}/platform/charts/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    WORKLOADS_COUNT=$(aws s3 ls "s3://${BUCKET}/workloads/charts/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    echo "✓ Charts sync complete (platform: ${PLATFORM_COUNT}, workloads: ${WORKLOADS_COUNT} files on S3)"

# Sync ALL k8s content (bootstrap + charts) to S3
[group('k8s')]
sync-k8s-all environment="development" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Syncing all K8s content to S3 ==="
    echo ""
    just sync-k8s-bootstrap "{{environment}}" "{{profile}}"
    echo ""
    just sync-k8s-charts "{{environment}}" "{{profile}}"
    echo ""
    echo "✓ All K8s content synced"

# Start an SSM session to an EC2 instance (e.g., just ec2-session i-09c7e747aad57520b dev-account)
[group('ops')]
ec2-session instance-id profile="dev-account":
    aws ssm start-session --target {{instance-id}} --profile {{profile}}

# Port-forward K8s API server (6443) via SSM tunnel
# Requires: local ~/.kube/config with server: https://127.0.0.1:6443
# Usage: just k8s-tunnel i-046a1035c0d593dc7
[group('k8s')]
k8s-tunnel instance-id region="eu-west-1" profile="dev-account":
    aws ssm start-session \
      --target {{instance-id}} \
      --document-name AWS-StartPortForwardingSession \
      --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
      --region {{region}} --profile {{profile}}

# Port-forward K8s API server — auto-resolves control plane instance ID from SSM
# Usage: just k8s-tunnel-auto
[group('k8s')]
k8s-tunnel-auto env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    INSTANCE_ID=$(aws ssm get-parameter \
      --name "/k8s/{{env}}/bootstrap/control-plane-instance-id" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "→ Control plane instance: ${INSTANCE_ID}"
    echo "→ Opening tunnel to K8s API (port 6443)…"
    aws ssm start-session \
      --target "${INSTANCE_ID}" \
      --document-name AWS-StartPortForwardingSession \
      --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
      --region {{region}} --profile {{profile}}

# Fetch kubeconfig from SSM and write to ~/.kube/config
# The control plane bootstrap stores a tunnel-ready kubeconfig in SSM
# after every kubeadm init (server address rewritten to 127.0.0.1:6443).
# Usage: just k8s-fetch-kubeconfig
[group('k8s')]
k8s-fetch-kubeconfig env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PATH="/k8s/{{env}}/kubeconfig"
    echo "→ Fetching kubeconfig from SSM: ${SSM_PATH}"
    KUBECONFIG_CONTENT=$(aws ssm get-parameter \
      --name "${SSM_PATH}" \
      --with-decryption \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
    if [ -z "$KUBECONFIG_CONTENT" ]; then
      echo "✗ SSM parameter ${SSM_PATH} not found."
      echo "  The control plane bootstrap publishes this after kubeadm init."
      echo "  If the cluster was just rebuilt, wait for the bootstrap to complete."
      exit 1
    fi
    KUBE_DIR="$HOME/.kube"
    mkdir -p "$KUBE_DIR"
    if [ -f "$KUBE_DIR/config" ]; then
      BACKUP="$KUBE_DIR/config.backup.$(date +%Y%m%d%H%M%S)"
      cp "$KUBE_DIR/config" "$BACKUP"
      echo "→ Backed up existing config → $BACKUP"
    fi
    echo "$KUBECONFIG_CONTENT" > "$KUBE_DIR/config"
    chmod 600 "$KUBE_DIR/config"
    echo "✓ Kubeconfig written to $KUBE_DIR/config"
    echo ""
    echo "→ Validating connectivity (requires active SSM tunnel)…"
    if kubectl get nodes 2>/dev/null; then
      echo ""
      echo "✓ Cluster access restored successfully"
    else
      echo ""
      echo "⚠ kubectl failed — ensure the SSM tunnel is active:"
      echo "  just k8s-tunnel-auto"
    fi
# Requires: active SSM tunnel (just k8s-tunnel-auto), k8sgpt CLI, Bedrock auth configured
# Setup: k8sgpt auth add --backend amazonbedrock --model eu.anthropic.claude-sonnet-4-20250514-v1:0 --providerRegion eu-central-1
[group('k8s')]
k8s-diagnose environment="development":
    AWS_PROFILE=$(just _profile {{environment}}) k8sgpt analyze --explain --backend amazonbedrock

# Diagnose K8s cluster issues without AI (free — no Bedrock cost)
# Requires: active SSM tunnel (just k8s-tunnel-auto), k8sgpt CLI
[group('k8s')]
k8s-diagnose-raw:
    k8sgpt analyze

# Port-forward Prometheus for local MCP access
# Required by: Prometheus MCP server (mcp_config.json → host.docker.internal:9090)
# Usage: just prom-forward
[group('k8s')]
prom-forward:
    #!/usr/bin/env bash
    if lsof -i :9090 &>/dev/null; then
      echo "⚠  Port 9090 already in use (Prometheus forward may be running)"
      lsof -i :9090 | head -3
      exit 0
    fi
    echo "→ Starting Prometheus port-forward on localhost:9090…"
    kubectl port-forward svc/prometheus 9090:9090 -n monitoring &
    sleep 2
    echo "✓ Prometheus available at http://localhost:9090/prometheus"
    echo "  Stop with: just prom-forward-stop"

# Check if Prometheus port-forward is running
[group('k8s')]
prom-forward-status:
    #!/usr/bin/env bash
    if lsof -i :9090 &>/dev/null; then
      echo "✓ Prometheus port-forward is running"
      lsof -i :9090 | head -3
    else
      echo "✗ Prometheus port-forward is NOT running"
      echo "  Start with: just prom-forward"
    fi

# Stop Prometheus port-forward
[group('k8s')]
prom-forward-stop:
    #!/usr/bin/env bash
    if pkill -f "port-forward svc/prometheus"; then
      echo "✓ Prometheus port-forward stopped"
    else
      echo "ℹ  No Prometheus port-forward was running"
    fi

# Trigger an ad-hoc etcd backup via SSM Run Command
# Use before: maintenance, upgrades, Crossplane changes, or node recycling
# Backup → s3://<scripts-bucket>/dr-backups/etcd/<timestamp>.db
[group('k8s')]
k8s-etcd-backup env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PREFIX="/k8s/{{env}}"
    INSTANCE_ID=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/bootstrap/control-plane-instance-id" \
      --region {{region}} --profile {{profile}} \
      --query 'Parameter.Value' --output text 2>/dev/null || true)
    if [[ -z "${INSTANCE_ID}" ]]; then
      echo "✗ Could not resolve control plane instance ID from SSM"
      exit 1
    fi
    echo "Triggering etcd backup on ${INSTANCE_ID}..."
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "${INSTANCE_ID}" \
      --document-name "AWS-RunShellScript" \
      --parameters 'commands=["sudo /usr/local/bin/etcd-backup.sh"]' \
      --region {{region}} --profile {{profile}} \
      --query 'Command.CommandId' --output text)
    echo "SSM Command: ${COMMAND_ID}"
    echo "Waiting for completion..."
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --region {{region}} --profile {{profile}} \
      --query '[Status, StandardOutputContent]' --output text

# =============================================================================
# LOCAL DEBUGGING — No pipeline required
#
# These recipes let you interact with the live cluster or test Python scripts
# locally without pushing code or triggering GitHub Actions.
# =============================================================================

# Sync a single deploy script (or entire chart directory) directly to S3.
# Bypasses the full CI pipeline — push a local change and immediately test it
# via `just ssm-shell` or `just deploy-script` without committing first.
#
# HOW IT WORKS:
#   1. Resolves the scripts S3 bucket from SSM (same param as CI uses)
#   2. Uploads deploy.py only (mode=file) or entire directory (mode=full)
#   3. Prints the EC2 path and the commands to pull and run it interactively
#
# SINGLE FILE  — fastest, for iterating on deploy.py:
#   just deploy-sync admin-api
#   just deploy-sync public-api
#
# FULL DIRECTORY — when helpers or other files also changed:
#   just deploy-sync admin-api development full
#   just deploy-sync public-api development full
#
# THEN TEST — open a shell and run the synced script directly:
#   just ssm-shell
#   > aws s3 cp s3://<bucket>/app-deploy/admin-api/deploy.py /data/app-deploy/admin-api/deploy.py
#   > KUBECONFIG=/etc/kubernetes/admin.conf python3 /data/app-deploy/admin-api/deploy.py --dry-run
[group('k8s')]
deploy-sync script env="development" mode="file" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -exo pipefail
    export HOME="${HOME:-/root}"
    SSM_PREFIX="/k8s/{{env}}"
    LOCAL_DIR="kubernetes-app/workloads/charts/{{script}}"
    if [ ! -f "${LOCAL_DIR}/deploy.py" ]; then
      echo "✗ deploy.py not found at ${LOCAL_DIR}/deploy.py"
      echo "  Supported scripts: admin-api, public-api, nextjs, monitoring, start-admin"
      exit 1
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  deploy-sync  :  {{script}} → S3  (mode: {{mode}})"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --region {{region}} --profile {{profile}} \
      --query "Parameter.Value" --output text)
    if [ -z "${BUCKET}" ] || [ "${BUCKET}" = "None" ]; then
      echo "✗ Could not resolve scripts bucket from ${SSM_PREFIX}/scripts-bucket"
      exit 1
    fi
    S3_PREFIX="app-deploy/{{script}}"
    S3_DEST="s3://${BUCKET}/${S3_PREFIX}"
    echo "  Local source : ${LOCAL_DIR}/"
    echo "  S3 dest      : ${S3_DEST}/"
    echo "  Bucket       : ${BUCKET}"
    echo ""
    if [ "{{mode}}" = "full" ]; then
      echo "  Mode: FULL — syncing entire directory (with --delete)"
      aws s3 sync \
        "${LOCAL_DIR}/" \
        "${S3_DEST}/" \
        --delete \
        --exclude "chart/*" \
        --exclude "__pycache__/*" \
        --exclude "*.pyc" \
        --exclude "test_*" \
        --region {{region}} \
        --profile {{profile}}
    else
      echo "  Mode: FILE — uploading deploy.py only"
      aws s3 cp \
        "${LOCAL_DIR}/deploy.py" \
        "${S3_DEST}/deploy.py" \
        --region {{region}} \
        --profile {{profile}}
    fi
    EC2_PATH="/data/${S3_PREFIX}/deploy.py"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅  Sync complete → ${S3_DEST}/deploy.py"
    echo ""
    echo "  ── Interactive (recommended): open shell, then run ────────"
    echo "    just ssm-shell {{env}}"
    echo ""
    echo "  Inside the shell — paste each line individually:"
    echo "    aws s3 cp ${S3_DEST}/deploy.py ${EC2_PATH} --region {{region}}"
    echo ""
    echo "    KUBECONFIG=/etc/kubernetes/admin.conf SSM_PREFIX=${SSM_PREFIX} /opt/k8s-venv/bin/python3 ${EC2_PATH} --dry-run"
    echo ""
    echo "    # Live run (applies K8s resources):"
    echo "    KUBECONFIG=/etc/kubernetes/admin.conf SSM_PREFIX=${SSM_PREFIX} /opt/k8s-venv/bin/python3 ${EC2_PATH}"
    echo ""
    echo "  ── One-shot: trigger via SSM + tail CloudWatch ─────────────"
    echo "    just deploy-script {{script}} {{env}}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Open an interactive SSM Session Manager shell on the control-plane node.
# Connects as ROOT — no sudo password needed, no SSH key required.
# Use this for real-time debugging: sync scripts, inspect logs, run deploy.py.
#
# Why root: /data/app-deploy/ is owned by root (created during bootstrap).
# AWS-StartInteractiveCommand runs sudo su - before handing you the prompt,
# so you land directly in a root shell regardless of ssm-user sudo config.
#
# After entering the shell:
#   aws s3 cp s3://... /data/app-deploy/admin-api/deploy.py   # no sudo needed
#   /opt/k8s-venv/bin/python3 /data/app-deploy/admin-api/deploy.py
#
# Usage:
#   just ssm-shell                              # control-plane (default)
#   just ssm-shell development i-0abc123def456  # specific instance
[group('k8s')]
ssm-shell env="development" instance-id="" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -exo pipefail
    export HOME="${HOME:-/root}"
    SSM_PREFIX="/k8s/{{env}}"
    if [ -z "{{instance-id}}" ]; then
      INSTANCE_ID=$(aws ssm get-parameter \
        --name "${SSM_PREFIX}/bootstrap/control-plane-instance-id" \
        --region {{region}} --profile {{profile}} \
        --query "Parameter.Value" --output text 2>/dev/null || echo "")
    else
      INSTANCE_ID="{{instance-id}}"
    fi
    if [ -z "${INSTANCE_ID}" ] || [ "${INSTANCE_ID}" = "None" ]; then
      echo "✗ Could not resolve instance ID. Is the cluster running?"
      exit 1
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  SSM Root Shell → ${INSTANCE_ID}  ({{env}})"
    echo "  Python: /opt/k8s-venv/bin/python3"
    echo "  Scripts: /data/app-deploy/<service>/deploy.py"
    echo "  Ctrl-D to exit"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    aws ssm start-session \
      --target "${INSTANCE_ID}" \
      --document-name AWS-StartInteractiveCommand \
      --parameters '{"command":["sudo su -"]}' \
      --region {{region}} --profile {{profile}}

# Trigger a single deploy.py script via the deploy-runner SSM document and
# tail the CloudWatch output in real-time — no pipeline, no Step Functions.
# The script pulled from S3 is whatever was last synced by ci-sync-scripts.
#
# Usage:
#   just deploy-script admin-api               # deploy admin-api
#   just deploy-script public-api              # deploy public-api
#   just deploy-script nextjs development      # specify env
[group('k8s')]
deploy-script script env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -exo pipefail
    export HOME="${HOME:-/root}"
    SSM_PREFIX="/k8s/{{env}}"
    LOG_GROUP="/ssm/k8s/{{env}}/deploy"

    INSTANCE_ID=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/bootstrap/control-plane-instance-id" \
      --region {{region}} --profile {{profile}} \
      --query "Parameter.Value" --output text)

    S3_BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --region {{region}} --profile {{profile}} \
      --query "Parameter.Value" --output text)

    DOC_NAME=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/ssm/deploy-runner-document-name" \
      --region {{region}} --profile {{profile}} \
      --query "Parameter.Value" --output text 2>/dev/null \
      || echo "k8s-dev-deploy-runner")

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Deploy script : app-deploy/{{script}}/deploy.py"
    echo "  Instance      : ${INSTANCE_ID}"
    echo "  S3 bucket     : ${S3_BUCKET}"
    echo "  Document      : ${DOC_NAME}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    CMD_ID=$(aws ssm send-command \
      --instance-ids "${INSTANCE_ID}" \
      --document-name "${DOC_NAME}" \
      --parameters "{
        \"ScriptPath\": [\"app-deploy/{{script}}/deploy.py\"],
        \"SsmPrefix\": [\"${SSM_PREFIX}\"],
        \"S3Bucket\":  [\"${S3_BUCKET}\"],
        \"Region\":    [\"{{region}}\"]
      }" \
      --cloud-watch-output-config "{
        \"CloudWatchLogGroupName\": \"${LOG_GROUP}\",
        \"CloudWatchOutputEnabled\": true
      }" \
      --region {{region}} --profile {{profile}} \
      --query "Command.CommandId" --output text)

    echo "CommandId: ${CMD_ID}"
    echo "Tailing CloudWatch logs (Ctrl-C to stop, script continues on EC2)..."
    echo ""

    aws logs tail "${LOG_GROUP}" \
      --region {{region}} --profile {{profile}} \
      --follow --format short &
    TAIL_PID=$!

    # Poll until done, then kill the tail
    for i in $(seq 1 60); do
      STATUS=$(aws ssm get-command-invocation \
        --command-id "${CMD_ID}" --instance-id "${INSTANCE_ID}" \
        --region {{region}} --profile {{profile}} \
        --query "Status" --output text 2>/dev/null || echo "Pending")
      if [[ "${STATUS}" == "Success" || "${STATUS}" == "Failed" || "${STATUS}" == "Cancelled" || "${STATUS}" == "TimedOut" ]]; then
        sleep 2  # let CW flush final lines
        kill "${TAIL_PID}" 2>/dev/null || true
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  Status: ${STATUS}"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        [[ "${STATUS}" != "Success" ]] && exit 1
        break
      fi
      sleep 5
    done

# Run deploy.py unit tests locally — no AWS credentials, no cluster required.
# Uses env-var overrides to bypass all boto3 and kubectl calls.
# Tests: config defaults, SSM env bypass, Secret/ConfigMap split, dry-run, errors.
#
# Usage:
#   just deploy-test admin-api        # test admin-api deploy.py
#   just deploy-test public-api       # test public-api deploy.py
[group('k8s')]
deploy-test script:
    #!/usr/bin/env bash
    set -exo pipefail
    SCRIPT_DIR="kubernetes-app/workloads/charts/{{script}}"
    TEST_FILE="${SCRIPT_DIR}/test_deploy_local.py"
    if [ ! -f "${TEST_FILE}" ]; then
      echo "✗ No local test file found at ${TEST_FILE}"
      echo "  Expected: test_deploy_local.py alongside deploy.py"
      exit 1
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Running local tests for {{script}}/deploy.py"
    echo "  No AWS credentials or cluster required"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    cd "${SCRIPT_DIR}" && python3 test_deploy_local.py -v

# Simulate the SSM deploy-runner shell preamble locally.
# Validates the bash script that wraps deploy.py — the exact commands the
# SSM document runs on EC2 — without touching AWS or the cluster.
# Useful for testing the 'set -u' fix and HOME export in isolation.
#
# Usage:
#   just ssm-preamble-test            # test the preamble only (no Python)
[group('k8s')]
ssm-preamble-test:
    #!/usr/bin/env bash
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Simulating SSM deploy-runner preamble locally"
    echo "  (matches what SsmRunCommandDocument generates)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    bash -c '
      set -exo pipefail
      export HOME="${HOME:-/root}"
      echo "=== SSM Step: runScript started at $(date) ==="
      export PATH="/opt/k8s-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
      echo "HOME   = ${HOME}"
      echo "PATH   = ${PATH}"
      echo "USER   = ${USER:-<not set>}"
      echo "SHELL  = ${SHELL:-<not set>}"
      echo "=== Preamble OK — no \$HOME error ==="
    '

# Build the unified MCP infrastructure server (K8s + AWS diagnostics → dist/)
[group('mcp')]
mcp-build:
    cd mcp-servers/mcp-infra-server && yarn build

# Build all MCP server Docker images (multi-stage Alpine builds)
[group('mcp')]
mcp-docker-build:
    docker compose -f docker-compose.mcp.yml build

# Build a single MCP server Docker image
# Usage: just mcp-docker-build-one infra
#        just mcp-docker-build-one docs
#        just mcp-docker-build-one diagram
[group('mcp')]
mcp-docker-build-one name:
    docker compose -f docker-compose.mcp.yml build {{name}}

# Verify MCP handshake on all Docker images (initialize → response check)
[group('mcp')]
mcp-docker-test:
    #!/usr/bin/env bash
    set -euo pipefail
    INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}'
    ERRORS=0
    for IMAGE in mcp-infra-server mcp-portfolio-docs mcp-infra-diagram; do
      echo "--- Testing ${IMAGE} ---"
      RESPONSE=$(echo "${INIT}" | docker run -i --rm "${IMAGE}:latest" 2>/dev/null | head -1)
      if echo "${RESPONSE}" | grep -q '"serverInfo"'; then
        SERVER_NAME=$(echo "${RESPONSE}" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
        echo "  ✓ Handshake OK — server: ${SERVER_NAME}"
      else
        echo "  ✗ Handshake FAILED"
        echo "  Response: ${RESPONSE}"
        ERRORS=$((ERRORS + 1))
      fi
    done
    echo ""
    if [ $ERRORS -gt 0 ]; then
      echo "✗ ${ERRORS} handshake(s) FAILED"
      exit 1
    fi
    echo "✓ All MCP servers respond correctly"
    echo ""
    echo "=== Image Sizes ==="
    docker images | head -1 && docker images | grep mcp

# Discover SSM parameters for Next.js or Bedrock stacks
# Usage: just mcp-ssm-discover /nextjs/development
#        just mcp-ssm-discover /bedrock/development
[group('mcp')]
mcp-ssm-discover prefix environment="development":
    AWS_PROFILE=$(just _profile {{environment}}) aws ssm get-parameters-by-path \
      --path "{{prefix}}" \
      --recursive \
      --query "Parameters[].{Name:Name,Value:Value}" \
      --output table \
      --region eu-west-1

# Generate ArgoCD CI bot token and store in Secrets Manager.
# Run AFTER Pipeline A (deploy-kubernetes) Day-1 completes and ArgoCD pods are Running.
# Prerequisites:
#   - SSM session to the control plane node
#   - ArgoCD pods in Running state
#   - ci-bot account registered (done by bootstrap_argocd.py Step 9)
# On the control plane node, run:
#   kubectl config set-context --current --namespace=argocd
#   argocd account generate-token --account ci-bot --core --grpc-web
# Then store the token:
[group('ops')]
argocd-ci-token region="eu-west-1" profile="dev-account" environment="development":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== ArgoCD CI Bot Token ==="
    echo ""
    echo "This command stores a pre-generated token in Secrets Manager."
    echo "To generate the token, SSM into the control plane and run:"
    echo ""
    echo "  kubectl config set-context --current --namespace=argocd"
    echo "  argocd account generate-token --account ci-bot --core --grpc-web"
    echo ""
    read -p "Paste the token: " TOKEN
    if [ -z "$TOKEN" ]; then
      echo "✗ No token provided"
      exit 1
    fi
    SECRET_ID="k8s/{{environment}}/argocd-ci-token"
    # Create or update the secret
    if aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
         --profile "{{profile}}" --region "{{region}}" &>/dev/null; then
      aws secretsmanager put-secret-value \
        --secret-id "$SECRET_ID" \
        --secret-string "$TOKEN" \
        --profile "{{profile}}" \
        --region "{{region}}"
      echo "✓ Secret updated: $SECRET_ID"
    else
      aws secretsmanager create-secret \
        --name "$SECRET_ID" \
        --secret-string "$TOKEN" \
        --profile "{{profile}}" \
        --region "{{region}}"
      echo "✓ Secret created: $SECRET_ID"
    fi

# Seed NextAuth.js authentication SSM parameters (one-time setup).
#
# These four SecureString parameters are consumed by the Next.js container
# at runtime for admin authentication (Credentials provider + JWT sessions).
#
# CDK Reference: infra/lib/stacks/kubernetes/edge-stack.ts
#   - CloudFront forwards NextAuth.js session cookies (__Secure-authjs.session-token,
#     __Host-authjs.csrf-token, authjs.callback-url) via AdminOriginRequestPolicy
#     on /api/auth/* and /admin/* paths.
#   - See also: infra/lib/config/ssm-paths.ts → NextjsSsmPaths.auth
#   - See also: infra/lib/config/nextjs.ts → CloudFrontConfig.adminCookies
#
# Prerequisites:
#   - AWS CLI configured with the correct profile
#   - Run once per account; values persist across redeployments
#
# Usage: just seed-nextauth-ssm
#        just seed-nextauth-ssm development eu-west-1 dev-account
[group('ops')]
seed-nextauth-ssm env="development" region="eu-west-1" profile="dev-account" prefix="nextjs":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PREFIX="/{{prefix}}/{{env}}/auth"
    echo "=== Seeding NextAuth.js SSM Parameters ==="
    echo "  Prefix: ${SSM_PREFIX}"
    echo "  Region: {{region}}"
    echo "  Profile: {{profile}}"
    echo ""

    # 1. NEXTAUTH_SECRET — random JWT signing key
    echo "→ Generating NEXTAUTH_SECRET (base64, 32 bytes)…"
    aws ssm put-parameter \
      --name "${SSM_PREFIX}/nextauth-secret" \
      --value "$(openssl rand -base64 32)" \
      --type SecureString \
      --overwrite \
      --region "{{region}}" --profile "{{profile}}"
    echo "  ✓ ${SSM_PREFIX}/nextauth-secret"

    # 2. Admin username
    echo "→ Setting admin username…"
    aws ssm put-parameter \
      --name "${SSM_PREFIX}/admin-username" \
      --value "admin" \
      --type SecureString \
      --overwrite \
      --region "{{region}}" --profile "{{profile}}"
    echo "  ✓ ${SSM_PREFIX}/admin-username"

    # 3. Admin password (placeholder — change immediately after seeding)
    echo "→ Setting admin password (⚠ change this value after seeding!)…"
    aws ssm put-parameter \
      --name "${SSM_PREFIX}/admin-password" \
      --value "your-secure-password" \
      --type SecureString \
      --overwrite \
      --region "{{region}}" --profile "{{profile}}"
    echo "  ✓ ${SSM_PREFIX}/admin-password"

    # 4. NEXTAUTH_URL — base URL for callbacks
    echo "→ Setting NEXTAUTH_URL…"
    aws ssm put-parameter \
      --name "${SSM_PREFIX}/nextauth-url" \
      --value "https://nelsonlamounier.com" \
      --type SecureString \
      --overwrite \
      --region "{{region}}" --profile "{{profile}}"
    echo "  ✓ ${SSM_PREFIX}/nextauth-url"

    echo ""
    echo "✓ All NextAuth.js parameters seeded under ${SSM_PREFIX}"
    echo ""
    echo "⚠  IMPORTANT: Update the admin password before going live:"
    echo "   aws ssm put-parameter --name '${SSM_PREFIX}/admin-password' \\"
    echo "     --value '<YOUR_REAL_PASSWORD>' --type SecureString --overwrite \\"
    echo "     --region {{region}} --profile {{profile}}"

# =============================================================================
# DOCUMENTATION
# =============================================================================

# Generate TypeDoc API docs
[group('docs')]
docs:
    cd infra && yarn docs

# Serve API docs locally
[group('docs')]
docs-serve:
    cd infra && yarn docs:serve

# Generate all dependency graphs
[group('docs')]
deps-graph:
    cd infra && yarn deps:graphs

# =============================================================================
# UTILITIES
# =============================================================================

# Build TypeScript
[group('util')]
build:
    cd infra && yarn build

# Clean build artifacts
[group('util')]
clean:
    rm -rf infra/cdk.out infra/dist .cache

# Delete backup files
[group('util')]
clean-backups:
    find . \( -name '*.backup' -o -name '*.bak' -o -name '*.backup.ts' \) -not -path './node_modules/*' -delete

# Preview untracked files that would be removed (dry run)
[group('util')]
clean-untracked:
    git clean -fd --dry-run

# Remove all untracked files and directories
[group('util')]
clean-untracked-force:
    git clean -fd

# Remove macOS duplicate " 2" files (created by Finder copy conflicts)
[group('util')]
clean-duplicates:
    find . -name "* 2*" -not -path "./.git/*" -not -path "./node_modules/*" -delete

# Delete log files (e.g., cluster-overview.log, boot.log)
[group('util')]
clean-logs:
    find . -name "*.log" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./infra/cdk.out/*" -delete
    echo "✓ Log files removed"

# Install dependencies (all workspaces)
[group('util')]
install:
    yarn install


# Kubernetes healty
[group('k8s')]
cluster-health:
   ./scripts/cluster-health.sh


# =============================================================================
# GITHUB WORKFLOW AUTOMATION
# =============================================================================

# Commit local changes to .github/ and automatically dispatch a workflow on the current branch.
# Usage: just gh-dispatch deploy-frontend.yml
[group('gh')]
gh-dispatch workflow:
    npx tsx scripts/local/gh-dispatch.ts {{workflow}}


# =============================================================================
# LOCAL DOCKER TESTING — admin-api
#
# Full local development cycle for the admin-api BFF container.
# Requirements:
#   - Docker Desktop or colima running
#   - ~/.aws credentials for the dev-account profile (or AWS SSO session active)
#   - api/admin-api/.env file with real ARNs and table names
#
# Usage:
#   just admin-api-up           # Stop any running container, build, and start
#   just admin-api-down         # Stop and remove container
#   just admin-api-logs         # Tail container logs
#   just admin-api-test TOKEN   # Smoke-test the health + draft endpoints
# =============================================================================

# Build the admin-api Docker image and start it in detached mode.
# Mounts ~/.aws read-only and passes AWS_PROFILE for credential resolution.
[group('local-dev')]
admin-api-up profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    AWS_PROFILE={{profile}} bash api/admin-api/scripts/local-admin-api.sh

# Stop and remove the local admin-api container.
[group('local-dev')]
admin-api-down:
    docker compose -f api/admin-api/docker-compose.yml down --remove-orphans --timeout 10
    echo "✓ admin-api container stopped"

# Tail logs from the local admin-api container.
[group('local-dev')]
admin-api-logs:
    docker compose -f api/admin-api/docker-compose.yml logs --follow

# Run a smoke test against the local admin-api container.
# Requires a valid Cognito JWT token — copy from browser dev tools on the admin UI.
# Usage: just admin-api-test <your-jwt-token>
[group('local-dev')]
admin-api-test token slug="test-smoke-slug-$(date +%s)":
    #!/usr/bin/env bash
    set -euo pipefail
    BASE="http://localhost:3002"
    echo "── Health check ──────────────────────────────────────"
    curl --silent --fail "${BASE}/healthz" | python3 -m json.tool
    echo ""
    echo "── Draft upload (POST /api/admin/drafts/{{slug}}) ───"
    curl --silent --fail --show-error \
      -X POST "${BASE}/api/admin/drafts/{{slug}}" \
      -H "Authorization: Bearer {{token}}" \
      -H "Content-Type: application/json" \
      -d '{"content": "# Smoke Test\n\nLocal Docker test at '"'"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"'"'."}' \
      | python3 -m json.tool
    echo ""
    echo "── Pipeline re-trigger (POST /api/admin/pipelines/article) ───"
    curl --silent --fail --show-error \
      -X POST "${BASE}/api/admin/pipelines/article" \
      -H "Authorization: Bearer {{token}}" \
      -H "Content-Type: application/json" \
      -d '{"slug": "{{slug}}"}' \
      | python3 -m json.tool


# =============================================================================
# LOCAL DOCKER TESTING — frontend images (start-admin + site)
#
# Builds and runs the frontend images against the already-running admin-api.
# Admin-api must be started first with `just admin-api-up`.
#
# Network wiring (matches production):
#   K8s:   start-admin → http://admin-api.admin-api:3002
#   Local: start-admin → http://admin-api:3002  (Docker DNS alias)
#
# Requirements:
#   - admin-api running locally (just admin-api-up)
#   - ~/.aws credentials for the dev-account profile
#   - ../frontend-portfolio/apps/start-admin/.env.local with Cognito vars
#
# Usage:
#   just cluster-up              # Stop → build → start frontend images
#   just cluster-up --no-rebuild # Use cached images (faster restarts)
#   just cluster-logs            # Tail combined logs
#   just cluster-down            # Stop and remove frontend containers
# =============================================================================

FRONTEND_REPO := justfile_directory() + "/../frontend-portfolio"

# Stop → build → start frontend images (start-admin + site) against local admin-api.
[group('local-dev')]
cluster-up profile="dev-account" *flags="":
    #!/usr/bin/env bash
    set -euo pipefail
    AWS_PROFILE={{profile}} npx tsx "{{FRONTEND_REPO}}/scripts/local-dev.ts" {{flags}}

# Stop → start using cached images (skips docker build, faster restarts).
[group('local-dev')]
cluster-fast profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    AWS_PROFILE={{profile}} npx tsx "{{FRONTEND_REPO}}/scripts/local-dev.ts" --no-rebuild

# Stop → build → start → tail combined logs (Ctrl+C detaches, containers stay up).
[group('local-dev')]
cluster-logs profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    AWS_PROFILE={{profile}} npx tsx "{{FRONTEND_REPO}}/scripts/local-dev.ts" --logs

# Build and start only start-admin (skip site).
[group('local-dev')]
cluster-admin profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    AWS_PROFILE={{profile}} npx tsx "{{FRONTEND_REPO}}/scripts/local-dev.ts" --admin-only

# Stop and remove frontend containers only (admin-api unaffected).
[group('local-dev')]
cluster-down:
    npx tsx "{{FRONTEND_REPO}}/scripts/local-dev.ts" --stop

