#!/usr/bin/env bash
# Invoke the IpSyncFn Lambda to populate WAF IP sets from SSM.
#
# EventBridge only fires on SSM parameter changes — not on cluster start.
# Run this script after `just dev-start` or any time WAF returns 403 on
# allowlisted hosts (ops.nelsonlamounier.com, tucaken.io, etc.).
#
# Usage:
#   ./scripts/local/waf-ip-sync.sh [environment]
#
# Examples:
#   ./scripts/local/waf-ip-sync.sh             # defaults to development
#   ./scripts/local/waf-ip-sync.sh development

set -euo pipefail

ENV="${1:-development}"
REGION="eu-west-1"

case "$ENV" in
    development) PROFILE="dev-account" ;;
    *)           PROFILE="dev-account" ;;
esac

FUNCTION_NAME="eks-public-ip-sync-${ENV}"

echo "Syncing WAF IP allowlist for environment: ${ENV}"
echo "  Lambda:  ${FUNCTION_NAME}"
echo "  Profile: ${PROFILE}"
echo "  Region:  ${REGION}"
echo ""

RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_STATUS=$(aws lambda invoke \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --payload '{}' \
    --cli-binary-format raw-in-base64-out \
    --query 'StatusCode' \
    --output text \
    "$RESPONSE_FILE" 2>&1)

PAYLOAD=$(cat "$RESPONSE_FILE")

if [ "$HTTP_STATUS" != "200" ]; then
    echo "Lambda invocation failed (HTTP ${HTTP_STATUS})"
    echo "Response: ${PAYLOAD}"
    exit 1
fi

if echo "$PAYLOAD" | grep -q '"errorMessage"'; then
    echo "Lambda returned a function error:"
    echo "$PAYLOAD"
    exit 1
fi

echo "Lambda invoked successfully (HTTP ${HTTP_STATUS})"
echo ""

# Show resulting IP set contents so the caller can verify without a console visit.
IPV4_SET_NAME="eks-public-allow-ipv4-${ENV}"
IPV6_SET_NAME="eks-public-allow-ipv6-${ENV}"

echo "Current WAF IP sets:"
for SET_NAME in "$IPV4_SET_NAME" "$IPV6_SET_NAME"; do
    SET_ID=$(aws wafv2 list-ip-sets \
        --scope REGIONAL --region "$REGION" --profile "$PROFILE" \
        --query "IPSets[?Name=='${SET_NAME}'].Id | [0]" \
        --output text 2>/dev/null || true)

    if [ -z "$SET_ID" ] || [ "$SET_ID" = "None" ]; then
        echo "  ${SET_NAME}: not found"
        continue
    fi

    ADDRESSES=$(aws wafv2 get-ip-set \
        --scope REGIONAL --region "$REGION" --profile "$PROFILE" \
        --name "$SET_NAME" --id "$SET_ID" \
        --query 'IPSet.Addresses' \
        --output json 2>/dev/null || echo '[]')

    echo "  ${SET_NAME}: ${ADDRESSES}"
done
