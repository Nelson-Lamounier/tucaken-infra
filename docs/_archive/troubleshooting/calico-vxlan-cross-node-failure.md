---
title: Calico VXLAN Cross-Node Pod Communication Failure
type: troubleshooting
tags: [kubernetes, calico, networking, vxlan, security-groups, troubleshooting]
sources:
  - infra/lib/config/kubernetes/configurations.ts
  - infra/lib/stacks/kubernetes/base-stack.ts
  - infra/lib/constructs/compute/constructs/ssm-state-manager.ts
  - docs/concepts/security-group-configuration.md
  - docs/concepts/request-lifecycle-viewer-to-pod.md
created: 2026-04-29
updated: 2026-04-29
---

> **Archived 2026-07-06 — superseded.** This document describes the self-managed kubeadm control plane, replaced by managed Amazon EKS in the kubeadm to EKS migration ([ADR-0001](../../decisions/0001-self-managed-k8s-vs-eks.md) records the original self-managed rationale; [EKS platform architecture](../../concepts/eks-platform-architecture.md) is the current design). Kept as decision and debugging history — do not treat as current state. Some code and cross-doc links below point at kubeadm-era paths that have since moved.

## Symptom

Pods on the same node can communicate. Pods on different nodes time out — connections hang and are eventually reset. The symptom is asymmetric: `kubectl exec` works, the pod is running and passes readiness probes (which hit the same node), but HTTP calls to pods on a different node return no response.

Specific patterns that trigger this:

- `kubectl exec -it <pod-a> -- curl http://<pod-b-ip>` fails when `pod-a` and `pod-b` are on different nodes
- Prometheus scrape targets on the remote node time out
- Loki Promtail cannot push logs if the Loki pod is on a different node

Same-node pod communication works because traffic stays within the node's network namespace and never touches the Calico VXLAN tunnel.

## Root cause — UDP 4789 blocked

Calico uses VXLAN encapsulation to route cross-node pod traffic. Packets between pods on different nodes are encapsulated in UDP frames on port **4789** and sent between the EC2 instances' private IPs. If the `clusterBase` security group does not permit UDP 4789 from itself (self-referencing rule), the encapsulated packets are dropped silently at the EC2 network interface.

The CDK rule definition at `infra/lib/config/kubernetes/configurations.ts:401`:

```ts
{ port: 4789, protocol: 'udp', source: 'self', description: 'VXLAN overlay networking (intra-cluster)' },
```

`source: 'self'` means the rule allows traffic where the **source security group** is the same as the target security group — i.e. only other instances that also have `clusterBase` SG attached. If a node lacks this SG, its VXLAN packets are dropped.

## Diagnosis

**Step 1 — Confirm cross-node failure is isolated:**

```bash
# Find pod IPs and which nodes they are on
kubectl get pods -A -o wide | grep -E "NAME|<pod-name>"

# From pod-a, curl pod-b IP directly (bypass Service ClusterIP)
kubectl exec -it <pod-a> -n <ns> -- curl -v --connect-timeout 5 http://<pod-b-ip>:<port>

# From pod-a, curl pod-a IP directly (same node — should succeed)
kubectl exec -it <pod-a> -n <ns> -- curl -v --connect-timeout 5 http://<pod-a-ip>:<port>
```

If same-node succeeds and cross-node times out, the VXLAN path is broken.

**Step 2 — Check VPC Flow Logs for REJECT on UDP 4789:**

Query CloudWatch Logs Insights on the `k8s-dev-vpc-flow-logs` log group:

```
fields @timestamp, srcAddr, dstAddr, srcPort, dstPort, protocol, action
| filter dstPort = 4789 and protocol = 17 and action = "REJECT"
| sort @timestamp desc
| limit 20
```

`protocol = 17` is UDP. REJECT records for port 4789 confirm the SG is blocking VXLAN packets.

**Step 3 — Verify SG assignment on all nodes:**

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=tucaken" \
  --query 'Reservations[].Instances[].{Id:InstanceId,SGs:SecurityGroups[].GroupId}' \
  --profile <profile>
```

Every worker node must have the `clusterBase` SG (`k8s-dev-k8s-cluster`). If a node is missing it (e.g. after manual launch, Spot replacement with wrong LT, or SG drift), the self-referencing UDP 4789 rule will not match packets from that node.

**Step 4 — Verify the SG rule exists in AWS:**

```bash
aws ec2 describe-security-groups \
  --group-ids <clusterbase-sg-id> \
  --query 'SecurityGroups[].IpPermissions[?FromPort==`4789`]' \
  --profile <profile>
```

Expected output: an ingress rule with `IpProtocol: udp`, `FromPort: 4789`, `ToPort: 4789`, and `UserIdGroupPairs` referencing the same SG ID (self-reference).

**Step 5 — Check Calico node status:**

```bash
kubectl get pods -n kube-system | grep calico
kubectl describe pod calico-node-<id> -n kube-system
kubectl logs calico-node-<id> -n kube-system | tail -50
```

Calico logs `BIRD socket error` or `Failed to connect to felix` when VXLAN or BGP is broken. A healthy node shows `Calico process is running`.

## Fix — restore the SG rule via CDK redeploy

The canonical fix is a `cdk deploy` to the base stack, which reconciles the SG rules to match `configurations.ts`:

```bash
npx cdk deploy K8s-Base-dev -c project=kubernetes -c environment=dev
```

CloudFormation will restore any missing SG rules without replacing the SG itself (rule changes are in-place updates).

**If a node is missing the SG entirely** (e.g. a Spot replacement launched without the correct Launch Template):

```bash
aws ec2 modify-instance-attribute \
  --instance-id <instance-id> \
  --groups <sg-clusterbase-id> <sg-ingress-id> <sg-monitoring-id> \
  --profile <profile>
```

Then verify VXLAN recovers within 30s (Calico re-establishes tunnels automatically once the SG permits the traffic).

## Related ports on clusterBase SG

The `clusterBase` SG carries all intra-cluster rules (`configurations.ts:391-416`). The VXLAN rule is one of several that could be accidentally removed:

| Port | Protocol | Purpose |
|:-----|:---------|:--------|
| 4789 | UDP | Calico VXLAN cross-node overlay |
| 179 | TCP | Calico BGP peering (fallback to BGP mode) |
| 5473 | TCP | Calico Typha (agent that reduces Felix load at scale) |
| 10250 | TCP | kubelet API (required for `kubectl logs`, `kubectl exec`) |
| 2379-2380 | TCP | etcd client and peer |

## Calico version and installation

Calico v3.29.3 is baked into the AMI and applied by the SSM State Manager document during node bootstrap (`ssm-state-manager.ts:182-195`):

```bash
kubectl apply -f /opt/calico/calico.yaml
# Fallback if file missing:
kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml"
```

The version is pinned at `configurations.ts:486` (and identically at `configurations.ts:596`, `700` for all environments).

## Related

- [Security Group Configuration](../../concepts/security-group-configuration.md) — clusterBase SG rules, two-layer perimeter, kube-proxy DNAT source preservation
- [Request Lifecycle — Viewer to Pod](../concepts/request-lifecycle-viewer-to-pod.md) — Hop 8 (kube-proxy DNAT) — cross-node path where VXLAN is required
- [K8s Bootstrap Failure Modes](k8s-bootstrap-failure-modes.md) — node bootstrap failures that can leave Calico in a broken state

<!--
Evidence trail (auto-generated):
- Source: infra/lib/config/kubernetes/configurations.ts (read on 2026-04-29) — VXLAN rule line 401, BGP line 402, Typha line 406, Calico version v3.29.3 lines 486/596/700
- Source: infra/lib/stacks/kubernetes/base-stack.ts (read on 2026-04-29) — podCidr from configs.cluster.podNetworkCidr line 185, SecurityGroupConstruct.fromK8sRules line 203, clusterBase SG identity lines 208
- Source: infra/lib/constructs/compute/constructs/ssm-state-manager.ts (read on 2026-04-29) — Calico apply lines 182-195
- Source: docs/concepts/security-group-configuration.md (read on 2026-04-29) — self-referencing SG pattern, clusterBase SG description
- Inferred: Calico log message format, kube-proxy IPVS/iptables specifics — not directly observable from this CDK repo
-->
