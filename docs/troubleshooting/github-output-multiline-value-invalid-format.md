---
title: GITHUB_OUTPUT Rejects Multi-line Value — "Invalid format" from aws-cli JSON
type: troubleshooting
tags: [github-actions, ci-cd, aws-cli, jq, shell]
sources:
  - .github/workflows/_deploy-kubernetes.yml
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

A GitHub Actions step that writes a value to `GITHUB_OUTPUT` fails with:

```
Error: Invalid format 'PhysicalResourceId'
```

Or the step writes silently but a later step that reads the output receives
only the first line of a multi-line value, causing JSON parse errors:

```
Error: Unexpected token '\n', "[\n  \"ami..." is not valid JSON
```

This affects the **Discover AMI Refresh Lambdas** step in
`_deploy-kubernetes.yml` which writes a JSON array of Lambda function names
to `GITHUB_OUTPUT` for use by the downstream invoke step.

## Root cause

`aws cloudformation list-stack-resources --output json` returns
**pretty-printed multi-line JSON** by default:

```json
[
  "ami-refresh-dev-UpdateLt",
  "ami-refresh-dev-CheckStatus",
  "ami-refresh-dev-StartRefresh"
]
```

GitHub Actions `GITHUB_OUTPUT` does not support multi-line values written
via the `echo "name=value"` syntax. Multi-line values must use a heredoc
delimiter syntax. The simpler fix is to compact the JSON to a single line
before writing it.

## How to fix

Pipe the `aws` command output through `jq -c '.'` to produce compact
single-line JSON before assigning to `GITHUB_OUTPUT`
([`.github/workflows/_deploy-kubernetes.yml:579-583`](../../.github/workflows/_deploy-kubernetes.yml#L579)):

```bash
# Before (broken — aws --output json is pretty-printed):
LAMBDAS=$(aws cloudformation list-stack-resources \
  --output json)
echo "lambda_names=$LAMBDAS" >> "$GITHUB_OUTPUT"

# After (correct — jq -c '.' compacts to single line):
LAMBDAS=$(aws cloudformation list-stack-resources \
  --output json | jq -c '.')
echo "lambda_names=$LAMBDAS" >> "$GITHUB_OUTPUT"
```

`jq -c '.'` is the identity transformation with compact output — it
validates the JSON and strips all whitespace including newlines.

## General rule

Any multi-line string written to `GITHUB_OUTPUT` with `echo "name=<value>"`
will fail or be silently truncated. Either:

1. **Compact JSON** — pipe through `jq -c '.'` (for JSON values)
2. **Use heredoc syntax** — for arbitrary multi-line strings:

   ```bash
   {
     echo "name<<EOF"
     echo "$MULTILINE_VALUE"
     echo "EOF"
   } >> "$GITHUB_OUTPUT"
   ```

The `--output json` flag on all `aws` CLI commands that return arrays
or objects will produce multi-line output. Always pipe through `jq -c '.'`
before assigning to shell variables that will be written to `GITHUB_OUTPUT`.

## Related

- [`.github/workflows/_deploy-kubernetes.yml`](../../.github/workflows/_deploy-kubernetes.yml)
  — the Discover + Invoke AMI Refresh steps using this pattern

<!--
Evidence trail (auto-generated):
- Commit: 7d550866 — "fix(ci): compact Lambda names JSON to single line for GITHUB_OUTPUT" (read on 2026-04-29)
- Source: .github/workflows/_deploy-kubernetes.yml:579-598 (read on 2026-04-29)
-->
