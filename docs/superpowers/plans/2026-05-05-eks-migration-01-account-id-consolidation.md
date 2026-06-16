# EKS Migration — Plan 1 / 6: Account-ID Consolidation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hardcoded AWS account IDs from `infra/lib/config/environments.ts`. The current target environment's account ID must come exclusively from `process.env.AWS_ACCOUNT_ID` (set by GH Actions Environment vars or local `.env`). CDK synth must fail loud if the env var is missing rather than silently using a wrong/stale ID.

**Architecture:** Single source of truth = environment variables. The `environments` Record in `environments.ts` keeps its shape (Record<Environment, EnvironmentConfig>) so callers don't break, but each entry's `account` field becomes a getter that reads `process.env.AWS_ACCOUNT_ID` (or `process.env.ROOT_ACCOUNT` for `Environment.MANAGEMENT`). `MANAGEMENT` already reads from env. A unit test enforces no 12-digit literal account IDs reappear in the file. The CI workflow `_deploy-stack.yml` already resolves `AWS_ACCOUNT_ID` from `vars.AWS_ACCOUNT_ID` per GH Environment — we add an `env:` export so the value reaches `process.env` at synth time.

**Tech Stack:** TypeScript, AWS CDK v2, Jest, GitHub Actions.

**Parent spec:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 9.1.

---

## File Structure

**Files to modify:**

| Path | Change |
|---|---|
| `infra/lib/config/environments.ts` | Replace literal account IDs with env-var getters |
| `infra/bin/app.ts` | Add early fail-loud assertion for `AWS_ACCOUNT_ID` |
| `.env.example` | Add `AWS_ACCOUNT_ID` documentation block |
| `.github/workflows/_deploy-stack.yml` | Export resolved `account_id` to `process.env.AWS_ACCOUNT_ID` for `cdk` step |

**Files to create:**

| Path | Purpose |
|---|---|
| `infra/tests/unit/config/environments.test.ts` | Unit tests: account resolution + forbidden-pattern guard |

---

## Task 1: Add forbidden-pattern test (TDD red)

**Files:**
- Create: `infra/tests/unit/config/environments.test.ts`

- [ ] **Step 1: Confirm test directory layout**

```bash
ls infra/tests/unit/ 2>/dev/null || echo "tests/unit does not exist"
find infra/tests -type d -maxdepth 3 2>/dev/null | head
```

Expected: `infra/tests/unit/` exists (jest config picks up `tests/unit/**`). If `infra/tests/unit/config/` does not exist, create it: `mkdir -p infra/tests/unit/config`.

- [ ] **Step 2: Write the failing test file**

Create `infra/tests/unit/config/environments.test.ts`:

```typescript
/**
 * @format
 * Unit tests for environments.ts.
 *
 * Enforces the single-source-of-truth invariant: AWS account IDs must come
 * from process.env (set by GH Environment vars or local .env), never
 * hardcoded in source. See:
 *   docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.1
 *   docs/superpowers/plans/2026-05-05-eks-migration-01-account-id-consolidation.md
 */
import * as fs from 'fs';
import * as path from 'path';

const ENVIRONMENTS_FILE = path.resolve(
    __dirname,
    '../../../lib/config/environments.ts'
);

describe('environments.ts — single-source-of-truth invariant', () => {
    let source: string;

    beforeAll(() => {
        source = fs.readFileSync(ENVIRONMENTS_FILE, 'utf8');
    });

    it('does not contain any hardcoded 12-digit AWS account IDs', () => {
        // Strip line and block comments so documentation examples don't trip the regex.
        const stripped = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const matches = stripped.match(/\b\d{12}\b/g) ?? [];
        expect(matches).toEqual([]);
    });
});

describe('environments.ts — runtime resolution', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it('reads DEVELOPMENT account from process.env.AWS_ACCOUNT_ID', () => {
        process.env.AWS_ACCOUNT_ID = '111111111111';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getEnvironmentConfig, Environment } = require('../../../lib/config/environments');
        expect(getEnvironmentConfig(Environment.DEVELOPMENT).account).toBe('111111111111');
    });

    it('reads MANAGEMENT account from process.env.ROOT_ACCOUNT', () => {
        process.env.ROOT_ACCOUNT = '222222222222';
        process.env.AWS_ACCOUNT_ID = '111111111111';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getEnvironmentConfig, Environment } = require('../../../lib/config/environments');
        expect(getEnvironmentConfig(Environment.MANAGEMENT).account).toBe('222222222222');
    });

    it('throws a clear error if AWS_ACCOUNT_ID is missing for non-management env', () => {
        delete process.env.AWS_ACCOUNT_ID;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getEnvironmentConfig, Environment } = require('../../../lib/config/environments');
        expect(() => getEnvironmentConfig(Environment.DEVELOPMENT).account).toThrow(
            /AWS_ACCOUNT_ID/
        );
    });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/config/environments.test.ts --no-coverage
```

Expected: ALL 4 tests FAIL.
- `does not contain any hardcoded 12-digit AWS account IDs` → fails because lines 115/120/125/130 of `environments.ts` contain literal 12-digit IDs.
- `reads DEVELOPMENT account from process.env.AWS_ACCOUNT_ID` → fails because the file returns the hardcoded value.
- `reads MANAGEMENT account from process.env.ROOT_ACCOUNT` → may pass (already env-sourced) — that's fine.
- `throws a clear error if AWS_ACCOUNT_ID is missing` → fails because no error is thrown.

If `MANAGEMENT` test passes — keep it; it documents existing behaviour we want preserved.

- [ ] **Step 4: Commit the failing test**

```bash
git add infra/tests/unit/config/environments.test.ts
git commit -m "test(config): add account-id single-source-of-truth invariant"
```

---

## Task 2: Refactor `environments.ts` to env-var getters

**Files:**
- Modify: `infra/lib/config/environments.ts:104-134` (the `environments` Record)

- [ ] **Step 1: Read the current file to confirm exact line numbers**

```bash
sed -n '100,140p' infra/lib/config/environments.ts
```

Expected output: the `environments` Record literal with hardcoded IDs at the four `account:` lines.

- [ ] **Step 2: Replace the Record with env-var-backed getters**

Open `infra/lib/config/environments.ts`. Replace lines 103–134 (the comment block above + the `environments` Record literal) with:

```typescript
/**
 * Resolve the AWS account ID for a target environment from process.env.
 *
 * Single source of truth: each CDK invocation targets exactly one environment,
 * and that environment's account ID is supplied by the runner via
 * `AWS_ACCOUNT_ID` (set by the GH Actions workflow from `vars.AWS_ACCOUNT_ID`
 * scoped to the GH Environment, or from `.env` for local development).
 *
 * MANAGEMENT is the only exception: its account is the org root, which is
 * separately supplied via `ROOT_ACCOUNT` because cross-account constructs
 * (DNS validation roles) reference both the target env's account AND the
 * root account in the same synth.
 *
 * Throws if the required env var is missing — fail loud, not silent.
 */
function resolveAccount(env: Environment): string {
    const key = env === Environment.MANAGEMENT ? 'ROOT_ACCOUNT' : 'AWS_ACCOUNT_ID';
    const value = process.env[key];
    if (!value) {
        throw new Error(
            `${key} env var is required to resolve the ${env} account. ` +
            `Set it in your .env file or GH Environment vars (vars.AWS_ACCOUNT_ID / vars.ROOT_ACCOUNT).`
        );
    }
    return value;
}

/**
 * Environment configurations — cross-project identity.
 * Each environment targets a dedicated AWS account, but the account ID is
 * resolved lazily from process.env (single source of truth — no hardcoded IDs).
 *
 * IMPORTANT: The primary region is hardcoded, NOT derived from
 * CDK_DEFAULT_REGION. When the Edge deploy job configures AWS credentials
 * for us-east-1, CDK_DEFAULT_REGION also becomes us-east-1, which would
 * cause SSM cross-region readers in the Edge stack to look in the wrong
 * region for ALB DNS and assets bucket parameters.
 */
const environments: Record<Environment, EnvironmentConfig> = {
    [Environment.DEVELOPMENT]: {
        get account() { return resolveAccount(Environment.DEVELOPMENT); },
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.STAGING]: {
        get account() { return resolveAccount(Environment.STAGING); },
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.PRODUCTION]: {
        get account() { return resolveAccount(Environment.PRODUCTION); },
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.MANAGEMENT]: {
        get account() { return resolveAccount(Environment.MANAGEMENT); },
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
};
```

Note: TypeScript getters in object literals satisfy the `readonly account: string` field on `EnvironmentConfig` interface — the field is read-only from the consumer's perspective; the getter resolves on each read.

- [ ] **Step 3: Run the unit test — expect all 4 to pass**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/config/environments.test.ts --no-coverage
```

Expected: 4 passed.

- [ ] **Step 4: Run typecheck**

```bash
cd infra && yarn typecheck
```

Expected: no errors. If TypeScript complains that getters in an object literal aren't assignable to `readonly account: string`, the fix is to add an explicit return type to the getter — but the standard `Record<Environment, EnvironmentConfig>` should accept it.

- [ ] **Step 5: Run cdk synth for one stack to prove end-to-end works**

```bash
cd infra && AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=development \
  Data-development --quiet
```

Expected: synth succeeds, no errors. If a stack tries to read another env's account at synth time, this command will throw the new clear error — that's a discovery, not a failure of this task.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/config/environments.ts
git commit -m "refactor(config): resolve account IDs from env vars only

Drops the hardcoded dev/staging/prod/management account IDs from
environments.ts and replaces them with lazy getters that read
AWS_ACCOUNT_ID (or ROOT_ACCOUNT for management) at access time.

Fail-loud: getter throws with a clear error if the env var is unset,
preventing silent fallback to a stale or wrong account."
```

---

## Task 3: Add fail-loud assertion in `app.ts`

**Files:**
- Modify: `infra/bin/app.ts:31-55` (right after dotenv loads, before any project factory runs)

- [ ] **Step 1: Read the current `app.ts` to find insertion point**

```bash
sed -n '25,60p' infra/bin/app.ts
```

Expected: shows `dotenv.config(...)`, `const app = new cdk.App()`, and the project/environment context parsing.

- [ ] **Step 2: Insert the assertion after environment is resolved, before factory creation**

Open `infra/bin/app.ts`. After line 53 (`const projectConfig = getProjectConfig(projectContext as Project);`) and before line 55 (`console.log(...)`), insert:

```typescript
// ============================================================================
// 1b. Fail-loud assertion — AWS_ACCOUNT_ID must be present.
//
// Synth time is the right place to fail. If we let a missing AWS_ACCOUNT_ID
// silently default (e.g., to a CDK_DEFAULT_ACCOUNT picked up from the
// caller's CLI credentials), we risk synthesizing a template that targets
// the wrong account.
//
// MANAGEMENT env additionally needs ROOT_ACCOUNT — we don't enforce that
// here because not every project requires the root account ARN.
// ============================================================================
if (!process.env.AWS_ACCOUNT_ID) {
    throw new Error(
        'AWS_ACCOUNT_ID env var is required. Set it in .env (local) or via ' +
        'GH Environment vars.AWS_ACCOUNT_ID (CI). Never hardcode account IDs.'
    );
}
```

- [ ] **Step 3: Run the unit test (still must pass)**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' npx jest tests/unit/config/environments.test.ts --no-coverage
```

Expected: 4 passed.

- [ ] **Step 4: Verify assertion fires when env var is missing**

```bash
cd infra && unset AWS_ACCOUNT_ID && \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=development --quiet 2>&1 | tail -5
```

Expected: error containing `AWS_ACCOUNT_ID env var is required`. Exit code non-zero.

- [ ] **Step 5: Verify it succeeds when env var present**

```bash
cd infra && AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=development \
  Data-development --quiet
```

Expected: synth succeeds.

- [ ] **Step 6: Commit**

```bash
git add infra/bin/app.ts
git commit -m "feat(app): fail synth if AWS_ACCOUNT_ID is unset"
```

---

## Task 4: Document `AWS_ACCOUNT_ID` in `.env.example`

**Files:**
- Modify: `.env.example` (top of file, alongside other infra identifiers)

- [ ] **Step 1: Read current `.env.example`**

```bash
head -40 .env.example
```

Expected: shows the existing edge/CloudFront block at top.

- [ ] **Step 2: Insert new block at the top of the file (after the file header comment)**

Open `.env.example`. After the closing `# =====...===` of the header comment block (around line 11), insert:

```bash

# ── AWS Account & Region ─────────────────────────────────────────────────────
# Single source of truth for the AWS account ID targeted by CDK synth.
#
# CI:    set per GH Environment via vars.AWS_ACCOUNT_ID; the workflow
#        exports it into process.env before invoking cdk.
# Local: set here for the env you're synthing against (development by default).
#
# Required — synth fails loud if missing. See:
#   docs/superpowers/specs/2026-05-05-eks-migration-design.md § 9.1
AWS_ACCOUNT_ID=

# ROOT_ACCOUNT is the org root account, used by cross-account DNS validation
# and other shared-org constructs. Required only when synthing the `org`
# project or the management environment.
ROOT_ACCOUNT=
```

- [ ] **Step 3: Verify the file still parses as a valid env file**

```bash
# A valid .env file has KEY=VALUE lines and # comments only.
# This grep finds any line that is neither blank, a comment, nor KEY=VALUE.
grep -nv '^[[:space:]]*$\|^[[:space:]]*#\|^[A-Z_][A-Z0-9_]*=' .env.example | head
```

Expected: no output (every line matches one of the allowed patterns).

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(env): document AWS_ACCOUNT_ID and ROOT_ACCOUNT requirements"
```

---

## Task 5: Export `AWS_ACCOUNT_ID` to process env in CI workflow

**Files:**
- Modify: `.github/workflows/_deploy-stack.yml` — the `Pre-flight Checks` and `Deploy Stack` steps need `AWS_ACCOUNT_ID` in their `env:` blocks.

The workflow already resolves the account ID into `steps.resolve-account.outputs.account_id` (line 188). It currently passes it via positional arg to `just ci-preflight` and into env as `AWS_ACCOUNT_ID` for the `Pre-flight Checks` step (line 286). We need to confirm it also reaches the `Deploy Stack` step (line 304-319) and the `Finalize Deployment` step (line 333-358) for `cdk` invocation.

- [ ] **Step 1: Read the relevant workflow blocks to confirm current state**

```bash
sed -n '266,320p' .github/workflows/_deploy-stack.yml
```

Expected: shows `Pre-flight Checks` step with `AWS_ACCOUNT_ID:` in env (line ~286) and `Deploy Stack` step. Confirm whether `Deploy Stack` env block (lines ~311-319) already includes `AWS_ACCOUNT_ID`.

- [ ] **Step 2: Add `AWS_ACCOUNT_ID` to the `Deploy Stack` env block if missing**

Open `.github/workflows/_deploy-stack.yml`. In the `Deploy Stack` step env block (around lines 311-319), confirm the line:

```yaml
          AWS_ACCOUNT_ID: ${{ steps.resolve-account.outputs.account_id }}
```

is present. If absent, add it directly after the `STACK_NAME:` / `PROJECT:` lines, matching the pattern used in the `Pre-flight Checks` step.

If already present: this task is a no-op for the Deploy Stack — proceed to Step 3.

- [ ] **Step 3: Confirm `cdk` actually receives the env var**

The `just ci-deploy` recipe runs `cdk deploy`. CDK inherits the parent process env. As long as `AWS_ACCOUNT_ID` is in the step's env block, cdk receives it.

Read the `just ci-deploy` recipe to confirm no env scrubbing:

```bash
grep -A8 "^ci-deploy" justfile
```

Expected: no `env -i` or env-clearing in the recipe.

- [ ] **Step 4: Smoke test the workflow locally (act-style — optional)**

This is a manual verification step. If `act` is installed:

```bash
# act -j deploy -W .github/workflows/_deploy-stack.yml \
#   --secret AWS_OIDC_ROLE=arn:aws:iam::771826808455:role/dummy \
#   --var AWS_ACCOUNT_ID=771826808455 \
#   --input stack-name=Data-development --input project=kubernetes \
#   --input environment=development
```

Skip if `act` not available — Task 6 (full lint+test+synth) covers integration.

- [ ] **Step 5: Commit (only if Step 2 made a change)**

```bash
git add .github/workflows/_deploy-stack.yml
git commit -m "ci: export AWS_ACCOUNT_ID to Deploy Stack step env"
```

If no change was needed, skip the commit and note in the PR description that the workflow already propagated the value.

---

## Task 6: Full health check — lint, typecheck, all tests, synth all kubernetes stacks

**Files:** none (verification only)

- [ ] **Step 1: Lint**

```bash
cd infra && yarn lint
```

Expected: zero errors. ESLint runs with `--max-warnings 0`.

- [ ] **Step 2: Typecheck**

```bash
cd infra && yarn typecheck
```

Expected: no output, exit 0.

- [ ] **Step 3: Run full unit test suite**

```bash
cd infra && CDK_BUNDLING_STACKS='[]' yarn test:unit
```

Expected: all tests pass, including the four new ones in `tests/unit/config/environments.test.ts`. Coverage report generated. If any pre-existing test fails because it was depending on a hardcoded account ID — that test also needs updating (use `process.env.AWS_ACCOUNT_ID = '111111111111'` in its setup).

- [ ] **Step 4: Synth every kubernetes stack for `development`**

```bash
cd infra && AWS_ACCOUNT_ID=771826808455 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=development --quiet 2>&1 | tail -20
```

Expected: synth completes, lists all 11 kubernetes stack names, no errors.

- [ ] **Step 5: Synth for `staging` (proves env-var swap works)**

```bash
cd infra && AWS_ACCOUNT_ID=692738841103 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=staging --quiet 2>&1 | tail -5
```

Expected: synth completes for staging account.

- [ ] **Step 6: Synth for `production`**

```bash
cd infra && AWS_ACCOUNT_ID=607700977986 ROOT_ACCOUNT=711387127421 \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=production --quiet 2>&1 | tail -5
```

Expected: synth completes for production account.

- [ ] **Step 7: Verify failure mode — missing env var**

```bash
cd infra && unset AWS_ACCOUNT_ID; \
  CDK_BUNDLING_STACKS='[]' ENABLE_CDK_NAG=false \
  npx cdk synth -c project=kubernetes -c environment=development 2>&1 | tail -3
```

Expected: error message `AWS_ACCOUNT_ID env var is required...`. Exit code non-zero.

- [ ] **Step 8: Sanity-check the spec-required invariant**

```bash
grep -nE '\b(771826808455|692738841103|607700977986|711387127421)\b' \
  infra/lib infra/bin -r --include='*.ts' 2>&1 | head
```

Expected: no matches in `infra/lib/config/` or `infra/bin/`. Matches in test files or CDK output dirs are acceptable; matches in `infra/lib/config/environments.ts` are a bug (means Task 2 was incomplete).

- [ ] **Step 9: No commit — verification only**

This task produces no code changes; it verifies the previous tasks. If any step fails, return to the relevant earlier task.

---

## Task 7: Update parent spec acceptance criteria — mark Plan 1 done

**Files:**
- Modify: `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 9.1 footer

- [ ] **Step 1: Append a status line to § 9.1**

Open `docs/superpowers/specs/2026-05-05-eks-migration-design.md`. Find the section `### 9.1 Account ID consolidation`. After the `**Inventory task in plan:**` bullet, append:

```markdown

**Status:** ✅ Done (2026-MM-DD) — see `docs/superpowers/plans/2026-05-05-eks-migration-01-account-id-consolidation.md`. Inventory finding: all `Stack.of(this).account` reads in existing stacks are token references resolved at deploy time (safe). The only synth-time hardcoding lived in `environments.ts` lines 113–134, removed by Task 2.
```

Replace `2026-MM-DD` with today's date when committing.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-05-eks-migration-design.md
git commit -m "docs(eks): mark Plan 1 (account-id consolidation) complete"
```

---

## Acceptance Criteria — Plan 1 Done When

1. `infra/lib/config/environments.ts` contains no 12-digit literal account IDs (enforced by unit test).
2. `getEnvironmentConfig(env).account` returns `process.env.AWS_ACCOUNT_ID` for non-management envs and `process.env.ROOT_ACCOUNT` for management.
3. `cdk synth -c project=kubernetes -c environment=development` succeeds with `AWS_ACCOUNT_ID` set, fails loud with a clear message when unset.
4. Same synth succeeds for staging and production envs by swapping only the `AWS_ACCOUNT_ID` env var.
5. `yarn lint`, `yarn typecheck`, `yarn test:unit` all pass.
6. `.env.example` documents `AWS_ACCOUNT_ID` and `ROOT_ACCOUNT` with their purpose.
7. `_deploy-stack.yml` propagates `AWS_ACCOUNT_ID` to the `Deploy Stack` step's process env (verified by reading the file).
8. Parent spec § 9.1 marked Done with a back-pointer to this plan.

---

## Out of Scope (handled by later plans)

- Renaming kubeadm-era stacks to `Deprecated_*` — Plan 2.
- New EKS CDK stacks — Plan 3.
- `kubernetes-bootstrap` repo restructure — Plan 4.
- New `deploy-eks-*.yml` workflows — Plan 5.
- Cutover runbook + CloudFront origin failover — Plan 6.
