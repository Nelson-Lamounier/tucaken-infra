#!/usr/bin/env bash
set -euo pipefail

echo "━━━ NODES ━━━"
kubectl get nodes -o wide

echo "" && echo "━━━ NODE RESOURCES ━━━"
kubectl top nodes

echo "" && echo "━━━ NAMESPACES ━━━"
kubectl get namespaces

echo "" && echo "━━━ POD SUMMARY BY NAMESPACE ━━━"
for ns in $(kubectl get namespaces --no-headers -o custom-columns=":metadata.name"); do
    running=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null | grep -c "Running" || true)
    total=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    pending=$(kubectl get pods -n "$ns" --no-headers 2>/dev/null | grep -vc "Running\|Completed" || true)
    icon="✅"
    [ "$pending" -gt 0 ] && icon="⚠️ "
    [ "$total" -eq 0 ] && continue
    echo "$icon $ns: $running/$total Running, $pending unhealthy"
done

echo "" && echo "━━━ UNHEALTHY PODS ━━━"
UNHEALTHY=$(kubectl get pods -A --no-headers | grep -v "Running\|Completed" || true)
[ -z "$UNHEALTHY" ] && echo "✅ All pods healthy" || echo "$UNHEALTHY"

echo "" && echo "━━━ POD DISTRIBUTION ACROSS NODES ━━━"
kubectl get pods -A -o wide --no-headers | grep Running | \
  awk '{print $8}' | sort | uniq -c | sort -rn

echo "" && echo "━━━ ARGOCD APPS ━━━"
kubectl get applications -n argocd

echo "" && echo "━━━ INGRESSROUTES ━━━"
kubectl get ingressroute -A

echo "" && echo "━━━ PDBS ━━━"
kubectl get pdb -A

echo "" && echo "━━━ RESOURCE QUOTAS ━━━"
kubectl get resourcequota -A

echo "" && echo "━━━ PERSISTENT VOLUMES ━━━"
kubectl get pv,pvc -A 2>/dev/null

echo "" && echo "━━━ SITE HEALTH ━━━"
curl -sI https://nelsonlamounier.com | head -1
curl -sI https://nelsonlamounier.com/admin/login | head -1

echo "" && echo "━━━ STEP FUNCTIONS (last 3) ━━━"
aws stepfunctions list-executions \
  --state-machine-arn "$(aws stepfunctions list-state-machines \
    --region eu-west-1 --profile dev-account \
    --query "stateMachines[?contains(name,'k8s-dev-bootstrap')].stateMachineArn" \
    --output text)" \
  --region eu-west-1 --profile dev-account \
  --query "executions[:3].{Name:name,Status:status}" \
  --output table
