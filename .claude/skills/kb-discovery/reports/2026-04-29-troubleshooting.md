# KB Discovery Report — cdk-monitoring (Troubleshooting Focus)

**Generated:** 2026-04-29
**Repository:** cdk-monitoring
**Scope:** Troubleshooting category only — targeted archaeology
**Passes completed:** 3 (decision archaeology), 4 (troubleshooting archaeology), 5.5 (depth assessment)
**Total troubleshooting candidates identified:** 11
**Commits inspected:** ~60 fix/resolve/revert commits
**Scripts read (deep):** control-plane-autofix.ts, control-plane-troubleshoot.ts, cfn-troubleshoot.ts, ebs-lifecycle-audit.ts, etcd-restore-rto-test.sh

---

## Executive summary

| Category | Count | Already documented | To document |
|:---------|------:|------------------:|------------:|
| Troubleshooting | 11 | 2 | 9 |

The two existing troubleshooting docs (`ami-refresh-iam-permissions.md`, `jwt-userid-source-security-fix.md`) are
well-formed. The nine undocumented candidates span four distinct surfaces:

- **CDK/CloudFormation gotchas** (3 candidates) — non-obvious constraints in the L2 construct layer
  that caused production failures or silent CI breakage
- **CloudFront edge behaviour** (3 candidates) — auth flow failures caused by AWS service limits and
  first-match evaluation semantics
- **Self-managed Kubernetes bootstrap failures** (2 candidates) — failure modes documented in
  automation scripts but never in the KB
- **Infrastructure operational failures** (2 candidates) — NLB/EBS production incidents with
  full root cause available in commit history

---

## Top 11 priority candidates

Ordered by combined skill-evidence × recruiter-relevance score.

| Rank | Candidate | Score | Primary commit/path |
|-----:|:----------|------:|:--------------------|
| 1 | K8s control plane bootstrap failure modes | 25 | `scripts/local/control-plane-autofix.ts` |
| 2 | NLB SG rule limit + Route53 A record drift | 25 | commit `cde0166f` |
| 3 | CloudFormation rejects `$Latest`/`$Default` in ASG LT version | 25 | commit `e411137d` |
| 4 | CloudFront behaviour first-match vs path specificity | 25 | commit `3dc412d0` |
| 5 | etcd restore: single-node control plane RTO | 20 | `scripts/local/etcd-restore-rto-test.sh` |
| 6 | CDK `valueFromLookup()` bakes AMI at synth time | 20 | commits `4008c9b4`, `286f0db8` |
| 7 | CloudFront OriginRequestPolicy blocks Authorization header | 20 | commit `2094a8c3` |
| 8 | CloudFront OriginRequestPolicy 10-cookie limit | 16 | commit `cafdf329` |
| 9 | CDK L2 LaunchTemplate `.launchTemplateName` always undefined | 16 | `infra/lib/constructs/compute/constructs/launch-template.ts:316` |
| 10 | NLB target registration propagation delay after Spot replacement | 16 | commit `81c020af` |
| 11 | RDS `allowMajorVersionUpgrade` required for CDK major PG upgrade | 12 | commit `6bcca0bf` |

---

## Existing documentation status

### Already documented — no action needed

- `docs/troubleshooting/ami-refresh-iam-permissions.md` — six-commit IAM series for AMI refresh Step Function
- `docs/troubleshooting/jwt-userid-source-security-fix.md` — userId taken from JWT payload not request body

---

## Troubleshooting

### High priority (score ≥ 16)

---

#### K8s control plane bootstrap failure modes

- **Category:** troubleshooting
- **Reference paths:**
  - `scripts/local/control-plane-autofix.ts` (JSDoc lines 5–28 enumerate 3 failure modes)
  - `scripts/local/control-plane-troubleshoot.ts` (diagnosis phases 1–4)
  - `docs/runbooks/bootstrap-deadlock-ccm.md` (permanent CCM fix)
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 5
- **Priority:** 25
- **Existing documentation:** partial — `docs/runbooks/bootstrap-deadlock-ccm.md` covers the CCM deadlock case only
- **Reference paths exist:** yes
- **Notes:** Three distinct production failure modes are explicitly catalogued in `control-plane-autofix.ts`
  but never written up as a troubleshooting doc: (1) **Missing `podSubnet` in kubeadm-config** — Calico
  operator reads this field from ConfigMap at install time; if SSM Automation writes the config before the
  value is available, Calico fails silently and the cluster runs with no pod networking; (2) **CCM taint
  not removed on timeout** — the Cloud Controller Manager step has a window; if it times out, worker nodes
  retain `node.cloudprovider.kubernetes.io/uninitialized` and all pods stay `Pending`; (3) **Stale
  `.calico-installed` / `.ccm-installed` markers** — partial bootstrap runs leave idempotency guard files
  on the control plane instance; a re-run skips already-completed steps even though they didn't fully
  succeed. Each has a known automated repair; none has diagnosis guidance outside the script JSDoc.
  High resume signal: self-managing Kubernetes bootstrap failure recovery at this level is rare.
- **Recommended companions:**
  - `docs/concepts/k8s-bootstrap-sequence.md` — full SSM Automation step sequence and phase diagram
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document K8s control plane bootstrap failure modes. Reference paths:
   - scripts/local/control-plane-autofix.ts
   - scripts/local/control-plane-troubleshoot.ts
   - docs/runbooks/bootstrap-deadlock-ccm.md"
  ```

---

#### NLB Security Group rule limit + Route53 A record drift

- **Category:** troubleshooting
- **Reference paths:**
  - commit `cde0166f` — full root cause analysis in commit body
  - `infra/lib/constructs/networking/elb/network-load-balancer.ts`
  - `infra/lib/stacks/kubernetes/base-stack.ts`
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 5
- **Priority:** 25
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** Two separate production failures in one commit, both with recoverable root cause. **SG rule
  limit:** Using the CloudFront managed prefix list (`pl-4fa04526`) for both port 80 and port 443 NLB
  inbound rules causes 55 + 55 = 110 effective rule slots against a hard 60-rule per-SG limit. The April
  9 deployment failed with `The maximum number of rules per security group has been reached`. Fix: port
  443 stays open (`anyIpv4`/`anyIpv6`) because K8s node ingress SG enforces the allowlist downstream;
  port 80 remains restricted to the prefix list. **Route53 A record drift:** CDK writes a placeholder IP
  (`10.0.0.1`) at Day-0 bootstrap; the control plane self-registers its real IP on first boot. On the
  next CDK deploy, the stack tried to delete the old record using the placeholder value — which no longer
  matched the live record — failing with `values provided do not match`. Fix: `CfnRecordSet` with
  `RETAIN` removal policy. Both failure modes are non-obvious and demonstrate production-grade
  infrastructure debugging.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the NLB security group rule limit and Route53 A record drift failures.
   Reference paths:
   - commit cde0166f
   - infra/lib/constructs/networking/elb/network-load-balancer.ts
   - infra/lib/stacks/kubernetes/base-stack.ts"
  ```

---

#### CloudFormation rejects `$Latest`/`$Default` as ASG LaunchTemplate version

- **Category:** troubleshooting
- **Reference paths:**
  - commit `e411137d` — full root cause and fix
  - `infra/lib/constructs/compute/constructs/auto-scaling-group.ts:322`
  - `infra/lib/constructs/events/ami-refresh/handlers/update-launch-template.ts`
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 5
- **Priority:** 25
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** CloudFormation hard-rejects `$Latest` and `$Default` as the `Version` field in an ASG
  `LaunchTemplate` property at the resource level — the stack rolls back with a cryptic error. However,
  the AWS API (`UpdateAutoScalingGroup`) does accept `$Default` at runtime. The CDK L2 `AutoScalingGroup`
  writes a pinned version number at synth time via a CDK escape hatch (`addPropertyOverride`). The fix
  removes this override entirely and instead has the AMI refresh Lambda call `UpdateAutoScalingGroup` via
  API after creating the new LT version, achieving the same result without touching CloudFormation. The
  comment at `auto-scaling-group.ts:322` explains the invariant but not the failure mode — this is
  precisely the knowledge that belongs in a troubleshooting doc. Demonstrates CDK/CloudFormation boundary
  knowledge rarely documented anywhere.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the CloudFormation $Latest/$Default LaunchTemplate version rejection.
   Reference paths:
   - commit e411137d
   - infra/lib/constructs/compute/constructs/auto-scaling-group.ts
   - infra/lib/constructs/events/ami-refresh/handlers/update-launch-template.ts"
  ```

---

#### CloudFront cache behaviour first-match semantics (not path specificity)

- **Category:** troubleshooting
- **Reference paths:**
  - commit `3dc412d0` — root cause and fix
  - `infra/lib/stacks/kubernetes/edge-stack.ts:514`
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 5
- **Priority:** 25
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** CloudFront evaluates cache behaviours by **list order** (first path pattern that matches
  wins), NOT by path specificity. `/api/auth/*` was listed after `/api/*` in `edge-stack.ts`. The
  `/api/*` behaviour used the public EIP origin request policy (no cookies forwarded). Auth callbacks
  hitting `/api/auth/callback` matched `/api/*` first, so session cookies were stripped from the origin
  request, and `signIn()` silently failed without any CloudFront error. This class of bug produces no
  4xx/5xx response — the request reaches the origin correctly but is missing authentication state.
  Diagnosing it requires reading the CloudFront behaviour list order rather than inspecting request logs.
  This is a high-value troubleshooting doc because the symptom (auth works on some paths, not others)
  is a common pattern engineers misdiagnose as a cookie or CORS issue.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document CloudFront cache behaviour first-match evaluation and the /api/auth/*
   ordering failure. Reference paths:
   - commit 3dc412d0
   - infra/lib/stacks/kubernetes/edge-stack.ts"
  ```

---

#### etcd restore on single-node control plane — RTO test and SAN risk

- **Category:** troubleshooting
- **Reference paths:**
  - `scripts/local/etcd-restore-rto-test.sh`
  - `docs/runbooks/cross-az-recovery.md`
- **Skill-evidence score:** 5
- **Recruiter-relevance score:** 4
- **Priority:** 20
- **Existing documentation:** partial — `docs/runbooks/cross-az-recovery.md` covers the AZ-loss scenario but not the specific failure modes during etcd restore
- **Reference paths exist:** yes
- **Notes:** `etcd-restore-rto-test.sh` is a real-restore script that measures full RTO from snapshot pull
  to healthy cluster. It implies at least one production restore attempt exposed timing and certificate
  issues. The single-node control plane has a specific failure mode not in the runbook: when the control
  plane IP changes (new AZ → new EC2 instance → new private IP), the existing etcd certificate SANs
  no longer match. The restore sequence must regenerate API server certs via `kubeadm certs renew` before
  starting the API server, or kubelet will refuse to connect. This is not documented anywhere in
  `docs/`. The cross-AZ runbook mentions PKI backup but does not document the SAN-mismatch symptom or
  diagnosis (`kubeadm certs check-expiration` vs `openssl x509 -noout -text`). High resume signal:
  etcd DR on self-managed K8s is a differentiated skill.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document etcd restore failure modes on a single-node control plane.
   Reference paths:
   - scripts/local/etcd-restore-rto-test.sh
   - docs/runbooks/cross-az-recovery.md"
  ```

---

#### CDK `valueFromLookup()` bakes AMI ID at synth time — breaks CI `--no-lookups`

- **Category:** troubleshooting
- **Reference paths:**
  - commit `4008c9b4` — root cause and fix
  - commit `286f0db8` — preceding workaround (placeholder context seeding)
  - `infra/lib/stacks/kubernetes/control-plane-stack.ts`
  - `infra/lib/stacks/kubernetes/worker-asg-stack.ts`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 5
- **Priority:** 20
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** `valueFromLookup()` resolves SSM parameters at **CDK synth time**, requiring valid AWS
  credentials in every environment that runs `cdk synth`. In CI pipelines using `--no-lookups` (the
  standard production-grade CI pattern), this causes the synth to fail with a placeholder AMI ID
  (`ami-0placeholder00000001`) that is not a valid EC2 image ID. The workaround commit (`286f0db8`)
  manually seeded this placeholder into `cdk.context.json` — which then caused a separate problem: the
  stale context value drifts from the live SSM value. The permanent fix (`4008c9b4`) uses
  `fromSsmParameter()` instead, which generates a `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>`
  CloudFormation parameter that CloudFormation resolves at deploy time. This pattern is well-known but
  frequently confused with `valueFromLookup()` in CDK documentation. Two commits, two failure modes,
  one clean explanation.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the CDK valueFromLookup vs fromSsmParameter distinction for AMI IDs in CI.
   Reference paths:
   - commit 4008c9b4
   - commit 286f0db8
   - infra/lib/stacks/kubernetes/control-plane-stack.ts
   - infra/lib/stacks/kubernetes/worker-asg-stack.ts"
  ```

---

#### CloudFront OriginRequestPolicy blocks `Authorization` header — CachePolicy workaround

- **Category:** troubleshooting
- **Reference paths:**
  - commit `2094a8c3` — root cause (`UnscopedValidationError`) and fix
  - `infra/lib/constructs/networking/cloudfront.ts`
  - `infra/lib/config/nextjs.ts`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 5
- **Priority:** 20
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** AWS explicitly blocks `Authorization` from being included in a CloudFront
  `OriginRequestPolicy` and returns `UnscopedValidationError` at deploy time (not at request time).
  The natural place to forward auth headers is the OriginRequestPolicy — this is what the AWS
  documentation implies. The correct approach is to include `Authorization` in the `CachePolicy`'s
  `headerBehavior` with `TTL=0`; CloudFront then adds it to the cache key AND forwards it to origin,
  but with a zero TTL the key is never used for actual caching. This is non-obvious and appears in
  admin-api's internal dev flow where server functions call `/api/admin/*` via the public CloudFront
  URL (with Bearer tokens). The commit body is the best existing documentation of the root cause.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the CloudFront Authorization header forwarding constraint.
   Reference paths:
   - commit 2094a8c3
   - infra/lib/constructs/networking/cloudfront.ts"
  ```

---

#### CloudFront OriginRequestPolicy 10-cookie limit — Auth.js session tokens

- **Category:** troubleshooting
- **Reference paths:**
  - commit `cafdf329`
  - `infra/lib/config/nextjs.ts` (cookie list before/after the fix)
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** AWS CloudFront `OriginRequestPolicy` enforces a maximum of **10 forwarded cookies**. Auth.js
  v5 generates 9 distinct per-session cookie names (`__Secure-authjs.session-token`, `authjs.csrf-token`,
  `__Host-authjs.csrf-token`, `authjs.callback-url`, etc.) — already at the limit. Any additional
  cookie pushed the count over 10, silently dropping trailing cookies at the origin. Fix: consolidate
  to `authjs.*` wildcard pattern, which counts as one cookie rule regardless of how many actual cookies
  match. The symptom (auth intermittently fails after adding a new session flag) is misleading because
  the failure is in the forwarding policy, not in the application code. Related to the behaviour
  ordering candidate but a distinct failure mode and fix.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the CloudFront OriginRequestPolicy 10-cookie limit and Auth.js wildcard fix.
   Reference paths:
   - commit cafdf329
   - infra/lib/config/nextjs.ts"
  ```

---

#### CDK L2 `LaunchTemplate.launchTemplateName` always `undefined`

- **Category:** troubleshooting
- **Reference paths:**
  - `infra/lib/constructs/compute/constructs/launch-template.ts:316`
  - commit `a13c5821` — "commit concrete name properties — resolve TS2551 build failure"
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** The CDK L2 `LaunchTemplate` construct exposes a `launchTemplateName` property, but the
  property evaluates to `undefined` at runtime even when the `launchTemplateName` prop is set at
  construction time. The L2 stores it as an `IResolvable` token and never materialises it as a string
  in the CDK object. Any code that reads `lt.launchTemplateName` directly will silently pass `undefined`
  to downstream API calls — producing `'undefined'` as a literal string or a validation error depending
  on the caller. The fix pattern (used in `launch-template.ts:316-318`) is to build the concrete name
  directly: `this.concreteTemplateName = \`${namePrefix}-lt\`` and use `concreteTemplateName`
  throughout. The same problem affects `AutoScalingGroupConstruct.concreteAsgName`. TS2551 build failure
  (`a13c5821`) was the first symptom that surfaced this. Compact but useful troubleshooting doc.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the CDK L2 LaunchTemplate.launchTemplateName undefined gotcha.
   Reference paths:
   - infra/lib/constructs/compute/constructs/launch-template.ts
   - commit a13c5821"
  ```

---

#### NLB target registration propagation delay after Spot instance replacement

- **Category:** troubleshooting
- **Reference paths:**
  - commit `81c020af`
  - `infra/tests/integration/kubernetes/argocd-worker-stack.integration.test.ts`
- **Skill-evidence score:** 4
- **Recruiter-relevance score:** 4
- **Priority:** 16
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** After an ASG terminates and replaces a Spot instance, the new instance ID is registered
  in the NLB target group asynchronously. The propagation window is typically 15–60 seconds but can
  extend to 2.5 minutes under load. Integration tests that call `DescribeTargetHealth` immediately
  after an ASG event see the old instance as `draining` and the new instance as absent, causing
  transient failures in CI that cannot be reproduced locally. Fix: `waitForTargetRegistration()` polling
  helper — retry `DescribeTargetHealth` up to 10 times at 15-second intervals with a 180-second Jest
  timeout. The underlying behaviour (the delay itself) is undocumented in AWS NLB docs. Worth capturing
  because it manifests as a CI reliability problem that looks like an NLB configuration bug.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the NLB target registration propagation delay after Spot replacement.
   Reference paths:
   - commit 81c020af
   - infra/tests/integration/kubernetes/argocd-worker-stack.integration.test.ts"
  ```

---

### Medium priority (score 9–15)

---

#### RDS `allowMajorVersionUpgrade` required for PostgreSQL major version upgrade

- **Category:** troubleshooting
- **Reference paths:**
  - commit `6bcca0bf`
  - `infra/lib/stacks/kubernetes/platform-rds-stack.ts`
- **Skill-evidence score:** 3
- **Recruiter-relevance score:** 4
- **Priority:** 12
- **Existing documentation:** none
- **Reference paths exist:** yes
- **Notes:** CDK's `DatabaseInstance` construct maps to `AWS::RDS::DBInstance`. CloudFormation blocks
  a PostgreSQL major version upgrade (16.x → 18.x) unless `AllowMajorVersionUpgrade: true` is set
  on the resource. The CDK L2 exposes this as the `allowMajorVersionUpgrade` prop. When absent,
  CloudFormation returns a vague deployment error that does not mention the version boundary explicitly.
  Low complexity fix but useful to document because the error message does not mention the missing
  property by name. Compact — one paragraph plus the before/after diff from `6bcca0bf` is sufficient.
- **Suggested kb-doc invocation:**
  ```
  "Use kb-doc to document the RDS allowMajorVersionUpgrade CDK requirement.
   Reference paths:
   - commit 6bcca0bf
   - infra/lib/stacks/kubernetes/platform-rds-stack.ts"
  ```

---

## Skip list

| Path | Reason |
|:-----|:-------|
| `fix(admin-api): map PG fields to UI shape` (cc944cf6) | Application-layer bug, not infrastructure — no production impact, fixed in same session |
| `fix(ci): compact Lambda names JSON to single line` (7d550866) | CI plumbing, no architectural insight |
| `fix(lint): resolve ESLint errors` (cd7a7a76, 12441d82) | Linting, not skill evidence |
| `fix(rds): suppress AwsSolutions-RDS10 nag` (1fb01ca6) | CDK-nag suppression — already covered in `docs/concepts/iac-security-dual-layer.md` |
| `fix(admin-api): shadow delete early-return` (a83ff786) | Application-level guard, no production incident |
| `scripts/local/cloudwatch-log-audit.ts` | Log inspection utility — not a bug fix, no failure scenario documented |
| `scripts/local/sns-orphans.ts` | Audit/hygiene script — no troubleshooting scenario, no failure mode |

---

## Recommended next actions

Top 5 items to address with kb-doc, in suggested order:

1. **K8s control plane bootstrap failure modes** (`scripts/local/control-plane-autofix.ts`) —
   Highest resume signal, three failure modes already described in code comments, minimal investigation needed
2. **CloudFormation rejects `$Latest`/`$Default` in ASG LT version** (commit `e411137d`) —
   Non-obvious CDK/CloudFormation boundary; commit body is already a complete root cause analysis
3. **NLB SG rule limit + Route53 A record drift** (commit `cde0166f`) —
   Two production failures, commit body contains full diagnostics
4. **CloudFront behaviour first-match semantics** (commit `3dc412d0`) —
   Diagnosable symptom pattern (auth breaks on subset of paths), high recruiter-relevance
5. **CDK `valueFromLookup()` vs `fromSsmParameter()`** (commits `4008c9b4`, `286f0db8`) —
   Clear before/after with two commits showing the full failure-then-fix arc

Suggested kb-doc invocations:

```
"Use kb-doc to document K8s control plane bootstrap failure modes. Reference paths:
 - scripts/local/control-plane-autofix.ts
 - scripts/local/control-plane-troubleshoot.ts
 - docs/runbooks/bootstrap-deadlock-ccm.md"

"Use kb-doc to document the CloudFormation $Latest/$Default LaunchTemplate version rejection.
 Reference paths:
 - commit e411137d
 - infra/lib/constructs/compute/constructs/auto-scaling-group.ts"

"Use kb-doc to document the NLB security group rule limit and Route53 A record drift failures.
 Reference paths:
 - commit cde0166f
 - infra/lib/constructs/networking/elb/network-load-balancer.ts"

"Use kb-doc to document CloudFront cache behaviour first-match evaluation.
 Reference paths:
 - commit 3dc412d0
 - infra/lib/stacks/kubernetes/edge-stack.ts"

"Use kb-doc to document the CDK valueFromLookup vs fromSsmParameter distinction for AMI IDs.
 Reference paths:
 - commit 4008c9b4
 - commit 286f0db8
 - infra/lib/stacks/kubernetes/control-plane-stack.ts"
```

---

## Coverage gaps

- `scripts/local/control-plane-troubleshoot.ts` — 4 diagnostic phases with pass/fail verdicts; only the
  JSDoc was sampled. Full read may surface additional failure modes not captured in the autofix script.
- `infra/lib/constructs/networking/cloudfront.ts` — read at grep level only; contains at least two more
  CloudFront workaround comments (`// because log files are never overwritten`) that may warrant entries.
- `infra/scripts/cd/verify-argocd-sync.ts` — referenced in the NLB target retry fix but not read in full;
  may contain additional retry/timeout failure modes in ArgoCD sync verification logic.

---

## Delta from previous scan

**Previous report:** `.claude/skills/kb-discovery/reports/2026-04-28-cdk-monitoring.md`

### New troubleshooting candidates since last scan

| Candidate | Score | Path |
|:----------|------:|:-----|
| K8s control plane bootstrap failure modes | 25 | `scripts/local/control-plane-autofix.ts` |
| NLB SG rule limit + Route53 A record drift | 25 | commit `cde0166f` |
| CloudFormation `$Latest`/`$Default` rejection | 25 | commit `e411137d` |
| CloudFront behaviour first-match semantics | 25 | commit `3dc412d0` |
| etcd restore RTO + SAN mismatch | 20 | `scripts/local/etcd-restore-rto-test.sh` |
| CDK `valueFromLookup()` CI breakage | 20 | commits `4008c9b4`, `286f0db8` |
| CloudFront OriginRequestPolicy blocks Authorization | 20 | commit `2094a8c3` |
| CloudFront 10-cookie limit | 16 | commit `cafdf329` |
| CDK L2 `launchTemplateName` undefined | 16 | `launch-template.ts:316` |
| NLB target registration delay after Spot | 16 | commit `81c020af` |
| RDS `allowMajorVersionUpgrade` | 12 | commit `6bcca0bf` |

### Candidates still outstanding from previous scan

| Candidate | Outstanding since | Score |
|:----------|:-----------------|------:|
| (All previous troubleshooting candidates were documented in the prior session) | 2026-04-28 | — |
