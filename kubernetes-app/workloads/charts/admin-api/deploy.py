#!/usr/bin/env python3
"""Create admin-api Kubernetes resources (Secret + ConfigMap + IngressRoute) from SSM parameters.

Called by the SSM Automation pipeline on the control plane instance.

Resolves from SSM:
  - Cognito auth parameters         → K8s Secret  (admin-api-secrets)
  - DynamoDB, S3, Lambda references → K8s ConfigMap (admin-api-config)
  - Traefik IngressRoute            → routes /api/admin/* to admin-api:3002

Credential model:
  admin-api-secrets   Opaque Secret  — COGNITO_* values only (encrypted at rest)
  admin-api-config    ConfigMap      — table names, bucket, ARNs, region (plain text)
  IMDS                              — AWS SDK credentials (NOT in K8s at all)

Consumer:
  start-admin TanStack application — BFF for the admin dashboard.

Usage:
    KUBECONFIG=/etc/kubernetes/admin.conf python3 deploy.py
    python3 deploy.py --dry-run   # Print config and exit

Environment overrides:
    MANIFESTS_DIR          — path to admin-api manifests dir   (default: /data/workloads/charts/admin-api)
    SSM_PREFIX             — SSM parameter path prefix         (default: /k8s/development)
    FRONTEND_SSM_PREFIX    — nextjs SSM prefix                 (auto-derived from SSM_PREFIX)
    AWS_REGION             — AWS region                        (default: eu-west-1)
    KUBECONFIG             — kubeconfig path                   (default: /etc/kubernetes/admin.conf)
    S3_BUCKET              — re-sync from S3                   (optional)
    S3_KEY_PREFIX          — S3 key prefix                     (default: k8s)
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Ensure deploy_helpers is importable from the k8s-bootstrap directory.
_BOOTSTRAP_DIR = os.environ.get(
    "DEPLOY_HELPERS_PATH",
    str(Path(__file__).resolve().parents[2] / "k8s-bootstrap"),
)
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)

from deploy_helpers.config import DeployConfig
from deploy_helpers.k8s import ensure_namespace, load_k8s, upsert_configmap, upsert_secret
from deploy_helpers.logging import log_info, log_warn
from deploy_helpers.s3 import sync_from_s3
from deploy_helpers.ssm import resolve_secrets

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: CDK flatName() short environment abbreviations.
SHORT_ENV_MAP: dict[str, str] = {
    "development": "dev",
    "staging": "stg",
    "production": "prd",
}

#: SSM parameters resolved from the shared nextjs/Cognito pool prefix.
#: Values are env var names injected into the admin-api Secret.
_COGNITO_SSM_MAP: dict[str, str] = {
    "auth/cognito-user-pool-id": "COGNITO_USER_POOL_ID",
    "auth/cognito-client-id": "COGNITO_CLIENT_ID",
    "auth/cognito-issuer-url": "COGNITO_ISSUER_URL",
}

#: Keys that go into the K8s Opaque Secret (sensitive — encrypted at rest).
_SECRET_KEYS: list[str] = [
    "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID",
    "COGNITO_ISSUER_URL",
]

#: Keys that go into the K8s ConfigMap (non-sensitive infrastructure config).
_CONFIG_KEYS: list[str] = [
    "DYNAMODB_TABLE_NAME",
    "DYNAMODB_GSI1_NAME",
    "DYNAMODB_GSI2_NAME",
    "ASSETS_BUCKET_NAME",
    "PUBLISH_LAMBDA_ARN",
    "ARTICLE_TRIGGER_ARN",
    "STRATEGIST_TRIGGER_ARN",
    "STRATEGIST_TABLE_NAME",
    "SSM_BEDROCK_PREFIX",
    "AWS_DEFAULT_REGION",
    "AWS_REGION",
]


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class AdminApiConfig(DeployConfig):
    """admin-api deployment configuration.

    Extends DeployConfig with the manifests_dir and frontend_ssm_prefix
    fields used for admin-api secret resolution.
    """

    manifests_dir: str = field(
        default_factory=lambda: os.getenv(
            "MANIFESTS_DIR", "/data/app-deploy/admin-api"
        ),
    )
    namespace: str = "admin-api"

    @property
    def frontend_ssm_prefix(self) -> str:
        """Derive frontend SSM prefix: /k8s/development → /nextjs/development.

        admin-api shares the same Cognito user pool as start-admin and nextjs.
        """
        override = os.getenv("FRONTEND_SSM_PREFIX", "")
        if override:
            return override
        env = self.ssm_prefix.rsplit("/", 1)[-1]
        return f"/nextjs/{env}"

    @property
    def environment_name(self) -> str:
        """Extract environment name from ssm_prefix (e.g. 'development')."""
        return self.ssm_prefix.rsplit("/", 1)[-1]

    @property
    def short_env(self) -> str:
        """Short environment abbreviation for CDK resource names."""
        return SHORT_ENV_MAP.get(self.environment_name, self.environment_name)


# ---------------------------------------------------------------------------
# SSM Resolution
# ---------------------------------------------------------------------------

def _load_boto3() -> tuple:
    """Lazily import boto3 and ClientError.

    Returns:
        Tuple of (boto3_module, ClientError_class).
    """
    import boto3 as _boto3
    from botocore.exceptions import ClientError as _ClientError
    return _boto3, _ClientError


def resolve_public_api_config(
    cfg: AdminApiConfig,
    ssm_client: object,
    client_error_cls: type,
) -> dict[str, str]:
    """Resolve admin-api application config from SSM.

    Resolution order:
    1. Cognito params     — from /nextjs/{env}/auth/* (shared pool with start-admin)
    2. DynamoDB table     — from /bedrock-{env}/content-table-name
    3. Assets bucket      — from /bedrock-{env}/assets-bucket-name
    4. Lambda ARNs        — from /bedrock-{env}/pipeline-*-function-arn
    5. Strategist params  — from /bedrock-{env}/strategist-*
    6. Constants          — GSI names, region, SSM prefix

    Args:
        cfg: admin-api deployment configuration.
        ssm_client: boto3 SSM client instance.
        client_error_cls: botocore ClientError class.

    Returns:
        Dict of env_var_name → value for all resolved parameters.
    """
    log_info("=== Resolving admin-api config from SSM ===")
    resolved: dict[str, str] = {}

    # 1. Cognito auth params — shared pool with start-admin / nextjs
    cognito = resolve_secrets(
        ssm_client,
        cfg.frontend_ssm_prefix,
        _COGNITO_SSM_MAP,
        client_error_cls=client_error_cls,
    )
    resolved.update(cognito)

    # 2. DynamoDB table — Bedrock ai-content table
    _bedrock_params: dict[str, str] = {
        "content-table-name": "DYNAMODB_TABLE_NAME",
        "assets-bucket-name": "ASSETS_BUCKET_NAME",
        "pipeline-publish-function-arn": "PUBLISH_LAMBDA_ARN",
        "pipeline-trigger-function-arn": "ARTICLE_TRIGGER_ARN",
        "strategist-trigger-function-arn": "STRATEGIST_TRIGGER_ARN",
        "strategist-table-name": "STRATEGIST_TABLE_NAME",
    }

    for param_suffix, env_var in _bedrock_params.items():
        path = f"/bedrock-{cfg.short_env}/{param_suffix}"
        log_info("Resolving Bedrock param", env_var=env_var, ssm_path=path)
        try:
            resp = ssm_client.get_parameter(Name=path, WithDecryption=True)
            resolved[env_var] = resp["Parameter"]["Value"]
            log_info("Resolved", env_var=env_var)
        except client_error_cls:
            log_warn("Not found", env_var=env_var, ssm_path=path)

    # 3. Constants — always injected (not from SSM)
    resolved["DYNAMODB_GSI1_NAME"] = "gsi1-status-date"
    resolved["DYNAMODB_GSI2_NAME"] = "gsi2-tag-date"
    resolved["SSM_BEDROCK_PREFIX"] = f"/bedrock-{cfg.short_env}"
    resolved["AWS_DEFAULT_REGION"] = cfg.aws_region
    # AWS_REGION is the canonical env var read by AWS SDK v3 (smithy).
    # AWS_DEFAULT_REGION is a fallback but not always resolved by the SDK.
    resolved["AWS_REGION"] = cfg.aws_region

    return resolved


# ---------------------------------------------------------------------------
# Kubernetes resource creation
# ---------------------------------------------------------------------------

def create_public_api_k8s_resources(v1: object, cfg: AdminApiConfig) -> None:
    """Create or update admin-api-secrets and admin-api-config.

    Splits resolved parameters into:
      - admin-api-secrets (Opaque Secret)  — Cognito creds (encrypted at rest)
      - admin-api-config  (ConfigMap)      — infra refs (plain text)

    Args:
        v1: Kubernetes CoreV1Api instance.
        cfg: admin-api deployment configuration with resolved secrets.
    """
    log_info("=== Creating admin-api Kubernetes resources ===")
    ensure_namespace(v1, cfg.namespace)

    # --- Secret (Cognito auth creds only) ---
    secret_data: dict[str, str] = {
        k: cfg.secrets[k] for k in _SECRET_KEYS if k in cfg.secrets and cfg.secrets[k]
    }

    if not secret_data:
        raise RuntimeError(
            "admin-api-secrets: no Cognito values resolved from SSM. "
            f"Ensure /nextjs/development/auth/cognito-* parameters exist "
            f"(frontend_ssm_prefix={cfg.frontend_ssm_prefix!r})."
        )
    upsert_secret(v1, "admin-api-secrets", cfg.namespace, secret_data)
    log_info("admin-api-secrets created/updated", keys=len(secret_data))

    # --- ConfigMap (non-sensitive infrastructure refs) ---
    config_data: dict[str, str] = {
        k: cfg.secrets[k] for k in _CONFIG_KEYS if k in cfg.secrets and cfg.secrets[k]
    }

    if not config_data:
        raise RuntimeError(
            "admin-api-config: no infrastructure values resolved from SSM. "
            "Ensure /bedrock-dev/* parameters exist "
            f"(ssm_prefix={cfg.ssm_prefix!r})."
        )
    upsert_configmap(v1, "admin-api-config", cfg.namespace, config_data)
    log_info("admin-api-config created/updated", keys=len(config_data))


# ---------------------------------------------------------------------------
# IngressRoute
# ---------------------------------------------------------------------------

# IngressRoute is managed imperatively by this script (Step 5) to avoid
# ArgoCD race conditions during secret rotations.
#
# Routing rules:
#   /api/admin/*  →  admin-api:3002
#
# This is additive with the nextjs IngressRoute:
#   nextjs owns: /* (catch-all)
#   public-api owns: /api/* (excluding /api/admin)
#   admin-api owns:  /api/admin/*
#
# In Traefik, more-specific rules win. The `/api/admin` prefix is
# explicitly excluded from the public-api IngressRoute regex.

# ENTRYPOINT: 'web' (port 80) — not 'websecure'.
# CloudFront → EIP uses HTTP_ONLY (port 80). Traefik's 'web' entrypoint handles
# all CloudFront traffic. The 'websecure' entrypoint (port 443) is for direct
# HTTPS access and would never be reached from CloudFront.
#
# SECURITY: The X-CloudFront-Origin-Secret header is required on all routes.
# CloudFront injects this header via a custom origin header; direct requests to
# the EIP without this header are rejected by Traefik before reaching the pod.
INGRESSROUTE_TEMPLATE = """\
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: admin-api
  namespace: admin-api
  annotations:
    meta.helm.sh/release-name: admin-api
    meta.helm.sh/release-namespace: admin-api
    kubernetes.io/description: "Traefik IngressRoute for admin-api BFF (managed by deploy.py)"
spec:
  entryPoints:
    - web
  routes:
    - match: >-
        Host(`{host}`) &&
        PathPrefix(`/api/admin`) &&
        HeaderRegexp(`X-CloudFront-Origin-Secret`, `{origin_secret}`)
      kind: Rule
      priority: 200
      services:
        - name: admin-api
          namespace: admin-api
          port: 3002
"""


def _resolve_origin_secret(ssm_client: object, environment: str, client_error_cls: type) -> str | None:
    """Fetch the CloudFront origin secret from SSM.

    Mirrors the nextjs/start-admin deploy.py pattern — the secret is stored at
    /k8s/{environment}/cloudfront-origin-secret and rotated periodically.
    During rotation both old and new values are accepted (regex alternation).

    Returns None (with a warning) when the parameter doesn't exist yet —
    Day-0 deployments run before _deploy-ssm-automation.yml seeds the secret.
    In that case upsert_admin_api_ingressroute() will skip IngressRoute creation.

    Args:
        ssm_client: boto3 SSM client.
        environment: Environment name (e.g. 'development').
        client_error_cls: botocore ClientError class.

    Returns:
        Regex pattern string for HeaderRegexp matcher (one or two values),
        or None if the parameter doesn't exist.
    """
    import re
    path = f"/k8s/{environment}/cloudfront-origin-secret"
    log_info("Fetching CloudFront origin secret", ssm_path=path)
    try:
        history = ssm_client.get_parameter_history(Name=path, WithDecryption=True)
        versions = sorted(history["Parameters"], key=lambda p: p["Version"], reverse=True)
        if not versions:
            log_warn("No versions found for CloudFront origin secret — IngressRoute skipped (Day-0?)", ssm_path=path)
            return None
        latest = re.escape(versions[0]["Value"])
        if len(versions) >= 2:
            previous = re.escape(versions[1]["Value"])
            return f"{previous}|{latest}"
        return latest
    except client_error_cls:
        log_warn("CloudFront origin secret not found — IngressRoute skipped (Day-0?)", ssm_path=path)
        return None


def upsert_admin_api_ingressroute(cfg: AdminApiConfig, ssm_client: object, client_error_cls: type) -> None:
    """Create or replace the admin-api Traefik IngressRoute.

    This function is the sole owner of the admin-api IngressRoute.
    It must be called after create_public_api_k8s_resources() so the
    namespace already exists.

    Skips gracefully when /k8s/{env}/cloudfront-origin-secret has not been
    seeded yet (Day-0 bootstrap order).  Re-run after _deploy-ssm-automation.yml
    to apply the IngressRoute.

    Args:
        cfg: admin-api deployment configuration.
        ssm_client: boto3 SSM client (for origin secret resolution).
        client_error_cls: botocore ClientError class.
    """
    import subprocess
    import tempfile

    # admin-api is routed via the main domain at /api/admin/* for all environments.
    # The subpath exclusion on the public-api IngressRoute ensures Traefik correctly
    # routes /api/admin/* to admin-api and /api/* (excluding admin) to public-api.
    host = "nelsonlamounier.com"
    origin_secret = _resolve_origin_secret(ssm_client, cfg.environment_name, client_error_cls)
    if origin_secret is None:
        log_warn("Skipping IngressRoute creation — origin secret not available yet")
        return

    manifest = INGRESSROUTE_TEMPLATE.format(host=host, origin_secret=origin_secret)

    log_info("Upserting admin-api IngressRoute", host=host, namespace=cfg.namespace)

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".yaml", delete=False
    ) as tmp:
        tmp.write(manifest)
        tmp_path = tmp.name

    try:
        subprocess.run(
            ["kubectl", "apply", "-f", tmp_path, f"--kubeconfig={cfg.kubeconfig}"],
            check=True,
            capture_output=True,
            text=True,
        )
        log_info("IngressRoute applied successfully")
    finally:
        os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    """Main entrypoint for admin-api deploy script.

    Steps:
      1. Optionally sync manifests from S3.
      2. Resolve SSM parameters.
      3. Create/update K8s Secret (Cognito) and ConfigMap (infra).
      4. Apply Traefik IngressRoute.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Deploy admin-api K8s resources from SSM")
    parser.add_argument("--dry-run", action="store_true", help="Print resolved config and exit")
    args = parser.parse_args()

    cfg = AdminApiConfig()

    # Step 1: Optional S3 sync
    if cfg.s3_bucket:
        log_info("Syncing manifests from S3", bucket=cfg.s3_bucket)
        sync_from_s3(cfg.s3_bucket, cfg.s3_key_prefix, cfg.manifests_dir, cfg.aws_region)

    boto3, ClientError = _load_boto3()
    ssm_client = boto3.client("ssm", region_name=cfg.aws_region)

    # Step 2: Resolve SSM
    cfg.secrets = resolve_public_api_config(cfg, ssm_client, ClientError)

    if args.dry_run:
        log_info("=== DRY RUN — no K8s resources created ===")
        secret_preview = {k: v for k, v in cfg.secrets.items() if k in _SECRET_KEYS}
        config_preview = {k: v for k, v in cfg.secrets.items() if k in _CONFIG_KEYS}
        log_info("Secrets (admin-api-secrets)", **secret_preview)
        log_info("Config  (admin-api-config)", **config_preview)
        return

    # Step 3: Create/update K8s resources
    v1 = load_k8s(cfg.kubeconfig)
    create_public_api_k8s_resources(v1, cfg)

    # Step 4: Apply IngressRoute
    upsert_admin_api_ingressroute(cfg, ssm_client, ClientError)

    log_info("=== admin-api deploy complete ===")


if __name__ == "__main__":
    main()
