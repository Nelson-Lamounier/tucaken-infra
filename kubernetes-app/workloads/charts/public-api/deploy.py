#!/usr/bin/env python3
"""Create public-api Kubernetes resources (ConfigMap only) from SSM parameters.

Called by the SSM Automation pipeline on the control plane instance.
Resolves parameters from SSM Parameter Store and creates/updates:
  - ``public-api-config``  K8s ConfigMap — DynamoDB names, region (NO Secrets)

The public-api has zero K8s Secrets. All AWS credentials are resolved
automatically from the EC2 Instance Profile (IMDS) by the AWS SDK v3
default credential chain running inside the pod.

Helm chart deployment is handled by ArgoCD (sync-wave 5).
The Traefik IngressRoute is created/updated by Step 3 of this script
(sole owner — ArgoCD never touches it).

Usage:
    KUBECONFIG=/etc/kubernetes/admin.conf python3 deploy.py
    python3 deploy.py --dry-run   # Print config and exit

Environment overrides:
    MANIFESTS_DIR     — path to public-api manifests dir  (default: /data/workloads/charts/public-api)
    SSM_PREFIX        — SSM parameter path                 (default: /k8s/development)
    AWS_REGION        — AWS region                         (default: eu-west-1)
    KUBECONFIG        — kubeconfig path                    (default: /etc/kubernetes/admin.conf)
    S3_BUCKET         — re-sync from S3                    (optional)
    S3_KEY_PREFIX     — S3 key prefix                      (default: k8s)
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Ensure deploy_helpers is importable from the k8s-bootstrap directory.
# On EC2: /data/k8s-bootstrap/deploy_helpers/
# Locally: relative to this file's grandparent (kubernetes-app/k8s-bootstrap/)
_BOOTSTRAP_DIR = os.environ.get(
    "DEPLOY_HELPERS_PATH",
    str(Path(__file__).resolve().parents[2] / "k8s-bootstrap"),
)
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)

from deploy_helpers.config import DeployConfig
from deploy_helpers.k8s import ensure_namespace, load_k8s, upsert_configmap
from deploy_helpers.logging import log_info, log_warn
from deploy_helpers.s3 import sync_from_s3

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# CDK flatName() uses shortEnv() abbreviations for resource prefixes.
# This map mirrors infra/lib/config/environments.ts → shortEnv().
SHORT_ENV_MAP: dict[str, str] = {
    "development": "dev",
    "staging": "stg",
    "production": "prd",
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass
class PublicApiConfig(DeployConfig):
    """public-api-specific deployment configuration.

    Extends ``DeployConfig`` with the ``MANIFESTS_DIR`` field used for
    public-api resource resolution. The namespace is fixed to ``public-api``.
    """

    manifests_dir: str = field(
        default_factory=lambda: os.getenv(
            "MANIFESTS_DIR", "/data/app-deploy/public-api"
        ),
    )
    namespace: str = "public-api"

    @property
    def environment_name(self) -> str:
        """Extract environment name from ssm_prefix (e.g. 'development')."""
        return self.ssm_prefix.rsplit("/", 1)[-1]

    @property
    def short_env(self) -> str:
        """Short environment abbreviation for CDK resource names."""
        return SHORT_ENV_MAP.get(self.environment_name, self.environment_name)


# ---------------------------------------------------------------------------
# SSM resolution
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
    cfg: PublicApiConfig, ssm_client: object, client_error_cls: type
) -> dict[str, str]:
    """Resolve non-sensitive configuration from SSM for the public-api ConfigMap.

    All values are non-sensitive infrastructure references and are stored
    in a plain Kubernetes ConfigMap (not a Secret).

    AWS credentials are intentionally excluded — the AWS SDK v3 default
    credential chain resolves them via the EC2 Instance Profile (IMDS).

    Args:
        cfg: public-api deployment configuration.
        ssm_client: boto3 SSM client instance.
        client_error_cls: botocore ``ClientError`` class.

    Returns:
        Dict of env_var_name → value for all resolved config entries.
    """
    log_info("=== Resolving public-api config from SSM ===")

    config: dict[str, str] = {}
    bedrock_prefix = f"/bedrock-{cfg.short_env}"

    # ── DynamoDB table name ──────────────────────────────────────────────────
    # Primary path: /nextjs/<env>/dynamodb-table-name
    # Fallback:     /bedrock-<env>/content-table-name (AiContentStack)
    nextjs_prefix = f"/nextjs/{cfg.environment_name}"
    for path, env_var in [
        (f"{nextjs_prefix}/dynamodb-table-name", "DYNAMODB_TABLE_NAME"),
        (f"{bedrock_prefix}/content-table-name", "DYNAMODB_TABLE_NAME"),
    ]:
        if "DYNAMODB_TABLE_NAME" in config:
            break
        try:
            resp = ssm_client.get_parameter(Name=path, WithDecryption=False)
            config["DYNAMODB_TABLE_NAME"] = resp["Parameter"]["Value"]
            log_info("Resolved DYNAMODB_TABLE_NAME", ssm_path=path)
        except client_error_cls:
            log_warn("DynamoDB table name not found", ssm_path=path)

    # ── GSI names (constants — matching CDK ai-content-stack.ts) ────────────
    # These are compile-time CDK constants, not seeded into SSM.
    config["DYNAMODB_GSI1_NAME"] = "gsi1-status-date"
    config["DYNAMODB_GSI2_NAME"] = "gsi2-tag-date"

    # ── Strategist table name ────────────────────────────────────────────────
    # Used by public-api GET /api/resumes/active to look up the active resume.
    # This is the same table resolved by start-admin and admin-api from:
    #   /bedrock-{env}/strategist-table-name
    strategist_path = f"{bedrock_prefix}/strategist-table-name"
    try:
        resp = ssm_client.get_parameter(Name=strategist_path, WithDecryption=False)
        config["STRATEGIST_TABLE_NAME"] = resp["Parameter"]["Value"]
        log_info("Resolved STRATEGIST_TABLE_NAME", ssm_path=strategist_path)
    except client_error_cls:
        log_warn("Strategist table name not found", ssm_path=strategist_path)

    # ── Region (non-sensitive — safe in ConfigMap) ───────────────────────────
    # AWS_DEFAULT_REGION is read by the AWS SDK v3 default credential chain.
    # It is NOT a secret. Stored in ConfigMap, not Secret.
    config["AWS_DEFAULT_REGION"] = cfg.aws_region

    return config


# ---------------------------------------------------------------------------
# K8s resource creation
# ---------------------------------------------------------------------------


def create_public_api_k8s_resources(v1: object, cfg: PublicApiConfig) -> None:
    """Create or update the public-api-config Kubernetes ConfigMap.

    The public-api service has NO K8s Secrets — zero sensitive values.
    All AWS credentials are resolved automatically from the EC2 Instance
    Profile (IMDS) by the AWS SDK v3 default credential chain inside the pod.

    ConfigMap keys (all non-sensitive):
        DYNAMODB_TABLE_NAME    — Content DynamoDB table name
        DYNAMODB_GSI1_NAME     — GSI for status+date queries (constant)
        DYNAMODB_GSI2_NAME     — GSI for tag+date queries (constant)
        STRATEGIST_TABLE_NAME  — Strategist DynamoDB table (resumes domain)
        AWS_DEFAULT_REGION     — AWS region for the SDK default chain

    Args:
        v1: Kubernetes ``CoreV1Api`` instance.
        cfg: public-api deployment configuration with resolved config.
    """
    log_info("=== Creating Kubernetes resources for public-api ===")
    ensure_namespace(v1, cfg.namespace)

    config_data: dict[str, str] = {}
    for key, value in cfg.secrets.items():  # cfg.secrets holds resolved config (not secrets)
        if value:
            config_data[key] = value

    if not config_data:
        raise RuntimeError(
            "public-api-config: no values resolved from SSM. "
            "Ensure /bedrock-dev/* and /nextjs/development/* parameters exist "
            f"(ssm_prefix={cfg.ssm_prefix!r})."
        )
    upsert_configmap(v1, "public-api-config", cfg.namespace, config_data)
    log_info("public-api-config created/updated", keys=len(config_data))


# ---------------------------------------------------------------------------
# IngressRoute management (deploy.py is sole owner)
# ---------------------------------------------------------------------------


def upsert_public_api_ingressroute(
    cfg: PublicApiConfig,
    ssm_client: object,
    v1_client: object,
    client_error_cls: type,
) -> None:
    """Create or update the Traefik IngressRoute for public-api.

    Ownership model:
        deploy.py is the SOLE owner of the 'public-api' IngressRoute.
        The Helm chart sets ingress.enabled=false so ArgoCD never renders
        or manages this resource — eliminating the race condition where
        ArgoCD sync re-renders the IngressRoute with the placeholder match
        rule on every git push or 3-minute auto-sync cycle.

        On Day-0 deploy.py CREATES the IngressRoute.
        On all subsequent deploys it UPDATES the match rule in-place.
        ArgoCD is not contacted in this step.

    Route behaviour:
        The IngressRoute matches only requests to /api/* paths
        (excluding /api/admin, which belongs to admin-api).
        Host() guard uses the real domain for defence-in-depth.
        The CloudFront origin secret header filter is applied to
        prevent direct-origin bypass.

    Args:
        cfg: public-api deployment configuration.
        ssm_client: boto3 SSM client instance.
        v1_client: Kubernetes ``CoreV1Api`` instance (used for api_client).
        client_error_cls: botocore ``ClientError`` class.

    Raises:
        SystemExit: If the IngressRoute cannot be created/updated (fatal).
    """
    try:
        from kubernetes import client  # noqa: PLC0415 — deferred import (optional dep)
        from kubernetes.client.rest import ApiException
        from datetime import datetime, timezone
        import re
        from urllib.parse import urlparse
        from deploy_helpers.logging import log_error

        cf_secret_path = f"/k8s/{cfg.environment_name}/cloudfront-origin-secret"
        log_info("Fetching CloudFront origin secret history", ssm_path=cf_secret_path)

        paginator = ssm_client.get_paginator("get_parameter_history")
        history: list[dict] = []
        for page in paginator.paginate(Name=cf_secret_path, WithDecryption=True):
            history.extend(page.get("Parameters", []))

        if not history:
            log_warn(
                "No CloudFront origin secret found — IngressRoute skipped (Day-0?)",
                ssm_path=cf_secret_path,
            )
            return

        latest = history[-1]
        origin_secret: str = latest["Value"]

        latest_time = latest["LastModifiedDate"]
        now = datetime.now(timezone.utc)

        # Dual-secret regex during 20-minute rotation window (zero-downtime)
        if len(history) >= 2 and (now - latest_time).total_seconds() < 20 * 60:
            previous_secret = history[-2]["Value"]
            old_escaped = re.escape(previous_secret)
            new_escaped = re.escape(origin_secret)
            origin_secret = f"{old_escaped}|{new_escaped}"
            log_info(
                "Secret rotated recently — using dual-secret regex for zero-downtime",
                minutes_since_rotation=round((now - latest_time).total_seconds() / 60, 1),
            )
        else:
            log_info("Using single origin secret")

        # Derive hostname from /nextjs/<env>/auth/nextauth-url
        ingress_host = ""
        nextauth_url_path = f"/nextjs/{cfg.environment_name}/auth/nextauth-url"
        try:
            resp = ssm_client.get_parameter(Name=nextauth_url_path, WithDecryption=True)
            parsed = urlparse(resp["Parameter"]["Value"])
            ingress_host = parsed.hostname or ""
            log_info("Derived ingress host", host=ingress_host)
        except client_error_cls:
            log_warn("NEXTAUTH_URL not available — Host() rule will be skipped")

        custom_api = client.CustomObjectsApi(v1_client.api_client)

        # Build match rule for /api/* (excluding /api/admin)
        host_clause = f"Host(`{ingress_host}`) && " if ingress_host else ""
        match_rule = (
            f"{host_clause}PathPrefix(`/api`) && "
            f"!PathPrefix(`/api/admin`) && "
            f"HeaderRegexp(`X-CloudFront-Origin-Secret`, `{origin_secret}`)"
        )

        ingressroute_manifest: dict = {
            "apiVersion": "traefik.io/v1alpha1",
            "kind": "IngressRoute",
            "metadata": {
                "name": "public-api",
                "namespace": cfg.namespace,
                "labels": {
                    "app": "public-api",
                    "managed-by": "deploy.py",
                },
                "annotations": {
                    "kubernetes.io/description": (
                        "Traefik IngressRoute for public-api — managed by deploy.py, "
                        "not ArgoCD. See workloads/charts/public-api/deploy.py Step 3."
                    )
                },
            },
            "spec": {
                # ENTRYPOINT: 'web' (port 80) — not 'websecure'.
                # CloudFront → EIP uses HTTP_ONLY (port 80). Traefik's 'web' entrypoint
                # handles all CloudFront traffic. The 'websecure' entrypoint (port 443)
                # would never be reached from CloudFront.
                "entryPoints": ["web"],
                "routes": [
                    {
                        "match": match_rule,
                        "kind": "Rule",
                        "services": [
                            {"name": "public-api", "port": 3001},
                        ],
                    }
                ],
            },
        }

        # Attempt PATCH (update) first; CREATE on 404
        try:
            existing = custom_api.get_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace=cfg.namespace,
                plural="ingressroutes",
                name="public-api",
            )
            ingressroute_manifest["metadata"]["resourceVersion"] = existing["metadata"][
                "resourceVersion"
            ]
            custom_api.replace_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace=cfg.namespace,
                plural="ingressroutes",
                name="public-api",
                body=ingressroute_manifest,
            )
            log_info("IngressRoute 'public-api' UPDATED", match_rule=match_rule)

        except ApiException as exc:
            if exc.status == 404:
                custom_api.create_namespaced_custom_object(
                    group="traefik.io",
                    version="v1alpha1",
                    namespace=cfg.namespace,
                    plural="ingressroutes",
                    body=ingressroute_manifest,
                )
                log_info("IngressRoute 'public-api' CREATED", match_rule=match_rule)
            else:
                log_error("Failed to upsert IngressRoute", status=exc.status, reason=exc.reason)
                sys.exit(1)

    except ImportError:
        log_warn("kubernetes package not available — IngressRoute step skipped (offline?)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    """Entry point for public-api resource deployment."""
    cfg = PublicApiConfig.from_env()

    # Handle --dry-run flag
    if "--dry-run" in sys.argv:
        cfg.dry_run = True
        cfg.print_banner("public-api Config Deployment — DRY RUN")
        log_info("Dry run configuration", **{
            "manifests_dir": cfg.manifests_dir,
            "namespace": cfg.namespace,
            "ssm_prefix": cfg.ssm_prefix,
            "kubeconfig": cfg.kubeconfig,
            "s3_bucket": cfg.s3_bucket or "(none)",
        })
        return

    boto3_mod, client_error_cls = _load_boto3()

    cfg.print_banner("public-api Config Deployment")

    # Step 1: S3 sync (optional — fetches latest chart/templates)
    if cfg.s3_bucket:
        sync_dir = str(Path(cfg.manifests_dir).parent.parent)
        sync_from_s3(cfg.s3_bucket, cfg.s3_key_prefix, sync_dir, cfg.aws_region)

    # Step 2: Load Kubernetes client
    v1 = load_k8s(cfg.kubeconfig)

    # Step 3: Resolve non-sensitive config from SSM
    ssm_client = boto3_mod.client("ssm", region_name=cfg.aws_region)
    cfg.secrets = resolve_public_api_config(cfg, ssm_client, client_error_cls)

    # Step 4: Create Kubernetes ConfigMap (NO Secrets)
    create_public_api_k8s_resources(v1, cfg)

    # Step 5: Create / Update the Traefik IngressRoute
    upsert_public_api_ingressroute(cfg, ssm_client, v1, client_error_cls)

    log_info("=== public-api deployment complete ===")


if __name__ == "__main__":
    main()
