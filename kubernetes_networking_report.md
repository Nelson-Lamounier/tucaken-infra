# Kubernetes Infrastructure Networking Report

This document provides a comprehensive review of the networking architecture implemented for the Kubernetes cluster. It details the AWS networking components (VPC, Security Groups), Kubernetes overlay networking (Calico CNI), ingress strategies (NLB), and cross-node traffic flows.

---

## 1. VPC and Subnet Topology

The cluster is deployed into a shared VPC (`shared-vpc-{environment}`) managed externally to the Kubernetes compute stacks. 

### Single-AZ Deployment Model
The networking strategy explicitly utilizes a **Single Availability Zone (`eu-west-1a`)** deployment. 
*   **Cost Optimization (Bandwidth)**: By confining all control-plane and worker nodes (General and Monitoring pools) to a single public subnet within the same AZ, the architecture eliminates **AWS cross-AZ data transfer costs**, which apply to traffic flowing between resources in different AZs. 
*   **Performance**: Single-AZ deployment ensures ultra-low latency for control-plane-to-worker and pod-to-pod communication.

### Public Subnet & Elastic IP
Worker nodes (`worker-asg-stack.ts`) are launched into `ec2.SubnetType.PUBLIC`. Instead of attaching Elastic IPs directly to individual instances (which requires complex lambda-based failover), a centralized **Elastic IP (EIP)** is allocated and attached to a Network Load Balancer (NLB).

---

## 2. Ingress & Load Balancing (NLB over ALB)

A **Network Load Balancer (NLB)** distributes external traffic into the cluster. This relies on Layer 4 networking rather than Layer 7 routing.

### Why NLB? 
1. **TCP Passthrough**: The NLB is configured purely for TCP passthrough on HTTP and HTTPS ports. It forwards packets untouched to the target nodes, allowing **Traefik** (running as a DaemonSet on the worker pools) to handle TLS termination, SNI routing, and Layer 7 header manipulation.
2. **Stable EIP Connection**: The EIP is bound to the NLB. This ensures CloudFront and external DNS point to a completely static address that never changes, even if instances beneath the NLB scale up, scale down, or are replaced.
3. **Health-Check Failover**: The NLB Target Groups leverage Traefik's health checks to automatically shift traffic if a node becomes unresponsive.

---

## 3. Security Groups (Defence-in-Depth)

Security is implemented using a 4-tier Security Group architecture defined in `base-stack.ts`:

1.  **Cluster Base SG (`k8s-cluster`)**: 
    Controls intra-cluster communication. It includes a self-referencing rule allowing all nodes (Control Plane + Workers) to communicate freely with each other on all necessary ports (etcd, kubelet, BGP, VXLAN).
2.  **Control Plane SG (`k8s-control-plane`)**: 
    Protects the Kubernetes API server (port 6443). Access is locked down and routed securely via AWS SSM Port Forwarding, preventing direct exposure to the open internet.
3.  **Monitoring SG (`k8s-monitoring`)**: 
    Restricts access to observability tools (Prometheus, Loki, Node Exporter) to authorized VPC traffic only.
4.  **Ingress SG (`k8s-ingress`)**: 
    Provides the edge security perimeter at the node level.
    *   **HTTP (Port 80/8000)**: Strictly locked to an AWS Managed Prefix List (`com.amazonaws.global.cloudfront.origin-facing`). Direct HTTP pings from bots/scanners are dropped at the packet layer; traffic *must* come through CloudFront and WAF.
    *   **HTTPS (Port 443/8443)**: Locked down via an administrative IP Allowlist (seeded from CDK contexts / SSM).

---

## 4. Cross-Node Pod Networking (Calico & VXLAN)

Kubernetes relies on a flat network model where every Pod get its own IP address. In an AWS environment, the VPC Fabric natively only understands EC2 Elastic Network Interfaces (ENIs) and their explicitly assigned IPs. It **drops** packets originating from or destined to unknown IPs (like Pod IPs).

### The Solution: Overlay Networking
To solve this, the cluster uses **Calico CNI** running an overlay network. 
*   **Source/Destination Check**: AWS EC2's `SourceDestCheck` attribute is explicitly disabled (`disableSourceDestCheck: true` in the Launch Templates). This is an absolute requirement; without it, the EC2 hypervisor drops packets whose source IP does not match the instance's ENI IP.
*   **Encapsulation**: Calico is configured to use **`VXLANAlways`**. 

### Why UDP and not TCP? (The VXLAN Protocol)
When Pod A on Node 1 communicates with Pod B on Node 2, the traffic must cross the AWS VPC infrastructure. 
1. The Calico `vxlan` interface intercepts the packet.
2. It encapsulates the entire original L3 packet into a **Layer 4 UDP packet directed to Port 4789** (the standard VXLAN port).
3. **Why UDP?** 
   * **TCP Meltdown**: Encapsulating TCP traffic inside another TCP stream is a known architectural anti-pattern. If packet loss occurs, both the outer and inner TCP connections attempt to retransmit, creating exponentially compounding network congestion ("TCP Meltdown").
   * **Stateless Speed**: UDP is a stateless, connectionless protocol. It acts simply as a low-overhead wrapper. The underlying Pods establish their own TCP handshakes inside the tunnel; the outer VXLAN encapsulator just acts as a fast delivery truck.

---

## 5. End-to-End Traffic Flow

### Inbound Traffic Flow (External to Pod)
1. **User** makes a request to the web application.
2. **CloudFront** (CDN) caches the request or forwards it via the AWS Backbone.
3. Traffic hits the cluster's **Elastic IP** attached to the **NLB**.
4. The NLB forwards the raw TCP packet to an EC2 instance in the **General/Monitoring Pool**.
5. The `Ingress SG` validates that the source IP belongs to CloudFront.
6. The packet traverses `iptables` and is handed to the **Traefik Ingress Controller** (DaemonSet).
7. Traefik unwraps the payload, inspects the SNI/Host headers, evaluates Kubernetes `NetworkPolicy` restrictions, and routes the traffic locally to the **Next.js Pod**.

### Cross-Node Traffic Flow (Pod to Pod)
*(E.g., Next.js Pod querying an internal microservice on a different node)*
1. **Pod 1** (`192.168.101.5`) sends a packet to **Pod 2** (`192.168.177.10`).
2. Local IP routing directs the packet to the `vxlan.calico` virtual interface.
3. Calico checks its Forwarding Database (FDB), identifies that Pod 2 lives on Node B (`10.0.0.160`), and wraps the internal packet in a **UDP Port 4789** header.
4. The packet traverses the AWS VPC from Node A (`10.0.0.169`) to Node B (`10.0.0.160`).
5. Node B receives the UDP packet, Calico decapsulates it, and delivers the original unspoofed packet to Pod 2.

---

## 6. Networking Configurations & Controls summary

| Concept | Implementation Strategy | Benefit |
| :--- | :--- | :--- |
| **IP Address Management (IPAM)** | Calico IP Pools (`192.168.0.0/16` broken into `/26` blocks per node) | Predictable, non-overlapping routing tables within the cluster. |
| **VPC Integration** | EC2 Instances bound to single subnet | Zero cross-AZ latency or billing overhead. |
| **Cluster Discovery** | Route 53 Private Hosted Zone (`k8s.internal`) + EIP | The API server is discoverable permanently on a stable DNS name routing via internal IPs. |
| **State Firewalling** | Network Policies (`nextjs-allow-traefik`) | Isolates Pods. Enforced by Calico's `Felix` agent reprogramming host `iptables`. |
