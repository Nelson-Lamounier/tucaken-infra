# =============================================================================
# ARC Self-Hosted Runner Image
# =============================================================================
#
# Extends the official ARC runner with deploy tooling pre-installed:
#   AWS CLI v2, python3-full (venv + pip), kubectl
#
# Built and pushed to GHCR by .github/workflows/build-ci-image.yml.
#
# Usage in arc-runners.yaml (ArgoCD Application Helm values):
#   template:
#     spec:
#       containers:
#         - name: runner
#           image: ghcr.io/nelson-lamounier/cdk-monitoring/arc-runner:latest
# =============================================================================

FROM ghcr.io/actions/actions-runner:latest

USER root

# ── System dependencies ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    python3-full \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ── AWS CLI v2 ───────────────────────────────────────────────────────────────
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && aws --version

# ── kubectl (latest stable) ──────────────────────────────────────────────────
RUN KUBECTL_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt) \
    && curl -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/kubectl \
    && kubectl version --client

# ── kubectl-argo-rollouts plugin ─────────────────────────────────────────────
RUN ARGO_VERSION=$(curl -sL https://api.github.com/repos/argoproj/argo-rollouts/releases/latest \
      | grep '"tag_name"' | head -1 | cut -d'"' -f4) \
    && curl -sLO "https://github.com/argoproj/argo-rollouts/releases/download/${ARGO_VERSION}/kubectl-argo-rollouts-linux-amd64" \
    && chmod +x kubectl-argo-rollouts-linux-amd64 \
    && mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts \
    && kubectl argo rollouts version

USER runner

ENTRYPOINT ["/home/runner/run.sh"]
