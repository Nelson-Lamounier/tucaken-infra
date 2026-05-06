# EKS Migration — Plan 5b: Pivot to ALB Ingress + ACM + ExternalDNS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if available) to implement this plan task-by-task. Plan execution must NOT begin until § 0 (Open Questions) is resolved.

**Goal:** Replace the V1 ingress stack (Traefik DaemonSet → NLB + cert-manager + Let's Encrypt) with the AWS-native pattern (ALB Ingress + ACM + ExternalDNS) before the workload migration of Plan 5 Task 4 begins. Public domains route through one shared ALB via `IngressGroup`; admin paths reach the same ALB with WAF IP-allowlist. Plan 5 Tasks 6 and 8 (CloudFront origin swap, Day-1 cutover) collapse — the ALB IS the public endpoint.

**Why this pivot:** Plan 5 V1 (Traefik+LE) was a literal port of the kubeadm pattern to EKS. AWS's official EKS Best Practices guide and IAM Pod Identity guidance recommend ALB Ingress + ACM as the canonical EKS path; Traefik on EKS is third-party with no AWS-side endorsement for in-region traffic. The kubeadm cluster is fully decommissioned (no parallel-cluster constraint left), so the V1 layer carries no cost-of-change benefit. ExternalDNS is already installed (`EksAddonsStack`) but produces no records because no `Ingress`/`Service` carries an annotation it can act on — switching workloads from `IngressRoute` to `Ingress` activates it for free.

**Architecture (target state):**

```
Internet
   │
   ├─→ Route53  (records driven by ExternalDNS)
   │      │
   │      └─ A/AAAA → ALB DNS name
   │
   ├─→ ALB (single shared, IngressGroup: public)
   │      │
   │      ├─ Listener :443 + ACM cert (multi-SAN via SNI)
   │      ├─ Listener :80 → :443 redirect
   │      ├─ WAF WebACL (IP-allowlist on /argocd, /grafana, /prometheus paths)
   │      └─ Target Groups (IP target type → pods directly)
   │
   └─→ CloudFront (kept for public production domains; bypassed for dev)
          │
          └─ Origin: ALB DNS name (was kubeadm EIP)
```

**Tech Stack:** AWS Load Balancer Controller (already running), ACM (eu-west-1 for ALB; us-east-1 for CloudFront), ExternalDNS (already running, needs reconfiguration), AWS WAFv2, ArgoCD v2.x, Helm 3, EKS Pod Identity.

**Parent spec:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 5.2 (V2 ingress migration — promoted from "deferred" to "now") + this plan as the executable spec.

**Supersedes (in Plan 5):** Tasks 2 (cert-manager), 3 (Traefik chart copy), 6 (CloudFront origin add), 8 (primary swap), 10 (cutover rollback runbook). Plan 5 Task 4 (workload Apps) is rewritten to use `Ingress` + `IngressGroup` instead of Traefik `IngressRoute`. Plan 5 Tasks 1 (ESO ClusterSecretStore), 3.5 (Argo Rollouts + Image Updater), 5 (monitoring) carry over unchanged.

**Repos touched:**
- `kubernetes-bootstrap` — workload Helm charts (`charts/<workload>/`), `argocd-apps/eks/development/`, removal of `charts/traefik/`, `charts/cert-manager-config/`.
- `cdk-monitoring` — `infra/lib/stacks/kubernetes/edge-stack.ts` (origin → ALB), `tucaken-edge-stack.ts` (origin → ALB), `eks-pod-identity-stack.ts` (ExternalDNS multi-zone scope), `eks-addons-stack.ts` (ExternalDNS Helm values).

**Dependencies (live, verified 2026-05-06):**
- Plan 1 ✅, Plan 2 ✅, Plan 3 ✅, Plan 4 ✅
- Plan 5 foundation ✅: ESO ClusterSecretStores Ready, Argo Rollouts running, Image Updater installed, ALB Controller healthy, ExternalDNS running.
- 🟡 Plan 5 Tasks 2 & 3 deployed (Traefik + cert-manager-config) — to be retired by this plan.

---

## § 0 — Resolved Questions (signed off 2026-05-06)

All open questions answered. Phase 1 unblocked.

### 0.1 Hosted zone topology — RESOLVED

All 3 hosted zones live in **mgmt-account `711387127421`**:
- `nelsonlamounier.com` → `Z04763221QPB6CZ9R77GM` (11 records).
- `tucaken.com` → `Z0985246TCY2EVREXYCY` (6 records).
- `tucaken.io` → `Z08895352CON78PXZQ6IB` (6 records).

ExternalDNS dev-account role's policy resource ARN references the cross-account `nelsonlamounier.com` zone but lacks `sts:AssumeRole`, so direct `ChangeResourceRecordSets` would currently fail with AccessDenied. No TXT records exist yet (no records ExternalDNS would have written) — confirms ExternalDNS has been a no-op since install. No other writers detected. Safe to keep `--txt-owner-id=eks-development`.

### 0.2 ACM certificate strategy — RESOLVED

**Single hostname space across all environments** (no `dev.` / `staging.` prefixes; solo developer simplification). Three eu-west-1 wildcard certs cover everything:

| Cert | SANs | Provisioning |
|---|---|---|
| nelsonlamounier wildcard | `nelsonlamounier.com`, `*.nelsonlamounier.com` | **Reuse existing** `arn:aws:acm:eu-west-1:771826808455:certificate/ebdbea79-d5ab-4559-ad77-dea2146dc1c0` (already ISSUED). |
| tucaken.io wildcard | `tucaken.io`, `*.tucaken.io` | New cert via CDK `acm.Certificate` with DNS validation through cross-account role. |
| tucaken.com wildcard | `tucaken.com`, `*.tucaken.com` | New cert via CDK `acm.Certificate` with DNS validation through cross-account role. |

All 3 ARNs published to SSM at `/k8s/development/eks/alb-cert-arns/{nelsonlamounier,tucaken-io,tucaken-com}`. Workload Ingresses reference them via `alb.ingress.kubernetes.io/certificate-arn` (controller picks the right cert per host via SNI).

ACM auto-renews via persistent DNS validation CNAMEs (CDK manages the `_acme-challenge.*` records through the cross-account role).

### 0.3 ExternalDNS — RESOLVED: single instance + role chaining

- ExternalDNS Pod Identity role (`EksPodIdentityStack`) gains `sts:AssumeRole` on `arn:aws:iam::711387127421:role/Route53DnsValidationRole`.
- Cross-account role's policy must include `route53:ChangeResourceRecordSets` on all 3 zones (audit/extend in Phase 2).
- Helm values (`EksAddonsStack`):
  - `--domain-filter=nelsonlamounier.com`
  - `--domain-filter=tucaken.io`
  - `--domain-filter=tucaken.com`
  - `--aws-assume-role=arn:aws:iam::711387127421:role/Route53DnsValidationRole`
  - `--policy=upsert-only` (retain — never delete records on its own).
  - `--txt-owner-id=eks-development` (retain).
- Single instance handles all 3 zones via the assumed role.

### 0.4 Admin paths — RESOLVED

| Decision | Answer |
|---|---|
| Same ALB or separate | **Same ALB**, single `IngressGroup: public`, host-based gating. |
| WAF resource | New WAFv2 WebACL `eks-public-development` deployed via CDK in cdk-monitoring. |
| Allowlist scope | Scope-down on `Host: admin.nelsonlamounier.com` AND `Host: ops.nelsonlamounier.com` → IP-set rule (allow these CIDRs only). |
| Allowlist CIDR source | New SSM StringList `/shared/development/admin-allowlist-cidrs`. Initially populated with operator's home IP; refresh manually as needed (cron + ESO is a Phase 2+ enhancement). |
| Public-api hardening | Same WebACL, separate scope-down on `Host: api.nelsonlamounier.com` with: AWSManagedRulesCommonRuleSet, AWSManagedRulesKnownBadInputsRuleSet, AWSManagedRulesSQLiRuleSet, AWSManagedRulesAmazonIpReputationList; rate-limit rule **2000 req/5min/IP** (AWS default; tune later). |
| nextjs / tucaken fronts | Apply the AWS Managed Rule Sets only (no rate limit, no IP allowlist). |
| Source IP preservation | ALB IP-target mode preserves source IP — WAF rules act on the actual client IP. |
| Cost estimate | $5 base + $1×4 managed rule sets + $1×1 IP-set rule + $1×1 rate-limit rule ≈ **$11/month**. |

### 0.5 CloudFront fate — RESOLVED: kill all 3 distributions across all environments

ALB is the public endpoint everywhere. AWS Shield Standard at ALB. No CDN tier. If static-asset CDN is ever needed, add CloudFront in front of S3 only (not in front of ALB).

Phase 5 of this plan deletes:
- `EdgeStack` (dev + any env) — distribution `EIXKG0VM7CBIS`, S3 `nextjs-article-assets-development` origin stays for direct app access.
- `TucakenEdgeStack` (dev + any env) — distributions `EAQTGLWU2USOL`, `E132LV40IHEC8R`.
- 8 us-east-1 ACM certs become orphaned (free to leave; cleanup PR optional).

Route53 records (apex + www aliases) become A/AAAA aliases pointing at the ALB DNS name, written by ExternalDNS from workload Ingress hostnames.

### 0.6 IngressGroup design — RESOLVED

Single ALB, single group `public`. Bare hostnames (no env prefix).

| Workload | Host(s) | group.order | WAF tier |
|---|---|---|---|
| admin-api | `admin.nelsonlamounier.com` | `100` | IP allowlist |
| public-api | `api.nelsonlamounier.com` | `200` | Managed rules + 2000/5m rate limit |
| tucaken-app .io | `tucaken.io`, `www.tucaken.io` | `300` | Managed rules |
| tucaken-app .com | `tucaken.com`, `www.tucaken.com` | `400` | Managed rules |
| ops admin (argocd/grafana/prometheus) | `ops.nelsonlamounier.com` | `500` | IP allowlist |
| nextjs (apex catch-all) | `nelsonlamounier.com`, `www.nelsonlamounier.com` | `900` | Managed rules |

Default backend: ALB returns 404 for unmatched rules — no default-backend Service needed.

Health checks: `/healthz` on each workload Service. Audit each workload chart in Phase 6 to confirm the path exists.

### 0.7 Cleanup scope — RESOLVED: aggressive cleanup in Phase 1

Delete:
- `argocd-apps/eks/development/traefik.yaml` (App).
- `argocd-apps/eks/development/cert-manager.yaml` (App, both manifest entries).
- `charts/traefik/` (entire directory).
- `charts/cert-manager-config/` (entire directory).
- `charts/argocd-ingress/` (kubeadm-only Traefik IngressRoute; replace via Phase 4 ALB Ingress).

Keep (still in use):
- `charts/argocd-eks/values.yaml` (ArgoCD bootstrap workflow).
- All other `argocd-apps/eks/development/*.yaml` Apps from Plan 5 foundation.

---

## § 1 — Phase Structure

Each phase is one or more PRs against `kubernetes-bootstrap` and/or `cdk-monitoring`. Phases are sequential.

### Phase 1 — Cleanup
**Branch:** `feat/eks-plan5b-cleanup`. Single PR.

- [ ] Delete `argocd-apps/eks/development/traefik.yaml`, `cert-manager.yaml` (both apps).
- [ ] Delete `charts/traefik/` and `charts/cert-manager-config/`.
- [ ] (Optional) Delete `charts/argocd-ingress/` if § 0.7 confirmed.
- [ ] After ArgoCD prunes: confirm Traefik NLB is gone, no `argocd-apps/eks/development/cert-manager-config` Application.
- [ ] Cluster intentionally has no ingress; nothing user-facing reachable. Plan 5 Task 4 (workload migration) lands ingress.

### Phase 2 — ExternalDNS reconfig + ACM provisioning (cdk-monitoring)
**Branch:** `feat/eks-plan5b-dns-acm`. Single PR in cdk-monitoring.

- [ ] **Update ExternalDNS Pod Identity policy** (`eks-pod-identity-stack.ts`): grant `route53:ChangeResourceRecordSets` on additional hosted zones from § 0.1. Add `sts:AssumeRole` on the cross-account DNS role if § 0.3 picks role-chaining.
- [ ] **Update ExternalDNS Helm values** (`eks-addons-stack.ts`): add `--domain-filter=tucaken.io`, `--domain-filter=tucaken.com`. Configure `--aws-assume-role` if needed.
- [ ] **Provision ACM certs** (new construct `infra/lib/constructs/networking/alb-cert.ts`): one cert per environment for the dev base domain, or per-domain wildcard. DNS validation via the existing cross-account role.
- [ ] **Write ACM cert ARN(s) to SSM** at e.g. `/k8s/development/eks/alb-cert-arn` so workload Apps can reference.
- [ ] Tests: unit tests for new construct.

### Phase 3 — Workload Ingress pattern
**Branch:** `feat/eks-plan5b-workload-ingress-template`. PR in kubernetes-bootstrap.

Author the canonical workload Ingress template and apply to ONE workload first (admin-api as canary). Once verified end-to-end (Route53 record created, ACM cert served, pod reachable), apply to remaining 8 workloads.

- [ ] **Each workload chart's `templates/ingress.yaml`**:
  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: Ingress
  metadata:
    name: {{ .Release.Name }}
    annotations:
      kubernetes.io/ingress.class: alb
      alb.ingress.kubernetes.io/scheme: internet-facing
      alb.ingress.kubernetes.io/target-type: ip
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
      alb.ingress.kubernetes.io/ssl-redirect: '443'
      alb.ingress.kubernetes.io/group.name: public
      alb.ingress.kubernetes.io/group.order: '{{ .Values.ingress.groupOrder }}'
      alb.ingress.kubernetes.io/healthcheck-path: /healthz
      external-dns.alpha.kubernetes.io/hostname: {{ .Values.ingress.host }}
  spec:
    rules:
      - host: {{ .Values.ingress.host }}
        http:
          paths:
            - path: /
              pathType: Prefix
              backend:
                service:
                  name: {{ .Release.Name }}
                  port:
                    number: 80
  ```
- [ ] Per-workload values:
  - `admin-api`: host `admin.dev.nelsonlamounier.com`, order `100`.
  - `public-api`: host `api.dev.nelsonlamounier.com`, order `200`.
  - `nextjs`: host `dev.nelsonlamounier.com`, order `900` (default-like fallback).
  - `tucaken-app` (.io): host `dev.tucaken.io`, order `300`.
  - `tucaken-app` (.com): host `dev.tucaken.com`, order `400`.

### Phase 4 — Admin paths (argocd / grafana / prometheus)
**Branch:** `feat/eks-plan5b-admin-ingress`. PR in kubernetes-bootstrap.

- [ ] Author `argocd-apps/eks/development/argocd-ingress.yaml` — Ingress with host `ops.dev.nelsonlamounier.com`, paths `/argocd`, `/grafana`, `/prometheus` routing to respective backends.
- [ ] Annotation `alb.ingress.kubernetes.io/wafv2-acl-arn` referencing a WebACL provisioned in cdk-monitoring with the IP-allowlist rule.
- [ ] Allowlist CIDRs sourced from ESO → SSM (existing `/shared/development/admin-allowlist-ipv4` etc.).

### Phase 5 — CloudFront edge stacks
**Branch:** `feat/eks-plan5b-cloudfront`. PR in cdk-monitoring.

Per § 0.5 decision:
- **If kill-dev**: delete dev `EdgeStack` and dev `TucakenEdgeStack`. Route53 records (created by ExternalDNS) point directly at ALB.
- **If keep-dev**: edit both edge stacks to read ALB DNS from SSM (`/k8s/development/eks/alb-dns-name`, written by ExternalDNS-side construct or CFN custom resource) and use as `HttpOrigin`. Drop the kubeadm EIP origin.

### Phase 6 — Plan 5 Task 4 (workload migration)
Use Phase 3 template + Phase 4 admin pattern. Per workload, one PR:
- `admin-api`, `public-api`, `nextjs`, `tucaken-app`, `article-pipeline`, `ingestion`, `job-strategist`, `resume-import`, `platform-rds`.

Migration drop-in: `Rollout` (already supported in `argo-rollouts`), `Ingress` (this plan), `ExternalSecret` referencing `aws-ssm` ClusterSecretStore.

### Phase 7 — Plan 5 Task 5 (monitoring)
Unchanged from Plan 5 — fresh PVCs, system MNG affinity, dashboards as-code.

### Phase 8 — Verification + acceptance
- [ ] Each domain resolves to ALB via Route53 (dig).
- [ ] Each domain serves HTTPS with valid ACM cert.
- [ ] WAF allows admin paths only from allowlist CIDRs (test from non-allowed source → 403).
- [ ] Health checks pass; ALB registers all pod IPs.
- [ ] CloudWatch alarms (Plan 5 Task 7 carries over) fire on canary failures.
- [ ] CloudFront prod fallback unchanged (Plan 5 Task 5/8 already-live behaviours).

---

## Cost (eu-west-1, monthly, dev workloads)

| Item | Replaces | $/month |
|---|---|---|
| 1 ALB (single shared, IngressGroup) | 1 NLB (Traefik) | ~$18–22 |
| ACM certs | LE certs | $0 |
| WAF WebACL (admin allowlist) | Traefik IPAllowlist middleware | ~$10 ($5 + 5 rules × $1) |
| ExternalDNS R53 calls | manual R53 / bootstrap script | ~$0 (free tier) |
| Route53 hosted zones | (unchanged) | $0.50/zone (existing) |

Net change versus Plan 5 V1: NLB→ALB cost-neutral; +$10 WAF; -Traefik chart maintenance burden; -cert-manager + LE chart burden.

---

## Risks

| Risk | Mitigation |
|---|---|
| Hosted zone audit reveals tucaken zones can't be written to from EKS dev account | Use cross-account role chaining (§ 0.3 option a). If blocked, defer tucaken to Phase 6+ and ship nelsonlamounier-only first. |
| ACM DNS validation creates `_acme-challenge` CNAMEs in mgmt account; cross-account role must permit it | Existing `Route53DnsValidationRole` already permits this (used today for kubeadm certs). Reuse. |
| WAF rule order misconfiguration drops legitimate traffic | Per-rule canary test; deploy WebACL in COUNT mode first, observe, switch to BLOCK. |
| ALB cert SAN list overflows the 25-cert per-listener limit | Current dev: ≤6 hostnames. No risk. Production: re-evaluate with wildcard certs. |
| ExternalDNS `--policy=upsert-only` leaves stale records | Run a periodic sync with `--policy=sync` in a maintenance window to reap; or accept cosmetic stale records. |
| Removing Traefik mid-session breaks any URL still pointing at the NLB | No URL points at the NLB today (no DNS wired). Safe. |

---

## References

- AWS Best Practices: Load Balancing — https://docs.aws.amazon.com/eks/latest/best-practices/load-balancing.html
- AWS Load Balancer Controller — IngressGroup annotation reference: https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
- ExternalDNS (sig-network) — https://kubernetes-sigs.github.io/external-dns/
- ACM DNS validation — https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html
- WAFv2 EKS integration — https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/#wafv2-acl-arn

---

## Out of Scope

- Migration of additional kubeadm-only Apps (ARC, descheduler, opencost, ecr-token-refresh, etc.) — handled per workload as needed; not all need EKS equivalents.
- Removal of CloudFront for production environments — Phase 5 only addresses dev.
- Auto Mode evaluation — explicitly rejected (decision recorded 2026-05-06).
- Plan 6 (`_deprecated_kubeadm/` rename of dead top-level `argocd-apps/`).

---

## Status

| Section | State | Date |
|---|---|---|
| § 0 Open Questions | ✅ resolved | 2026-05-06 |
| Phase 1 Cleanup | 🔴 not started | — |
| Phase 2 DNS+ACM | 🔴 not started | — |
| Phase 3 Workload template | 🔴 not started | — |
| Phase 4 Admin Ingress | 🔴 not started | — |
| Phase 5 CloudFront | 🔴 not started | — |
| Phase 6 Workloads | 🔴 not started | — |
| Phase 7 Monitoring | 🔴 not started | — |
| Phase 8 Acceptance | 🔴 not started | — |
