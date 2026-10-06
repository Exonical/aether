# Cilium Gateway API

Aether uses Kubernetes Gateway API for external routing. The example assumes an existing Cilium installation with Gateway API enabled, compatible Gateway API CRDs, Envoy support, and a configured LoadBalancer implementation. Aether does not install the cluster's networking stack.

`deploy/kubernetes/overlays/workspace-gateway` extends the tenant S3 overlay with:

- A `gateway.networking.k8s.io/v1` Gateway using `gatewayClassName: cilium`.
- An HTTPS listener for `acme.aether.example`, terminating TLS with the user-provided `aether-tls` Secret.
- An HTTPRoute forwarding the entire application to `Service/aether:8080`, including upstream WebSocket RPC.
- A Cilium policy admitting traffic from the `ingress` identity to workerd on TCP 8080.

No Kubernetes Ingress resources are created. The private workspace overlays remain available without external routing. For PostgreSQL KV plus S3 use `deploy/kubernetes/overlays/workspace-postgres-gateway`. Both overlays use the shared component in `deploy/kubernetes/components/gateway`; set the hostname there. For local blob storage, change the gateway overlay's base from `../workspace-s3` to `../workspace` and adjust its namespace.

## Configure and apply

Set the tenant hostname in both the listener and HTTPRoute. Provide DNS pointing that hostname to the Gateway's address and a TLS Secret named `aether-tls` in the tenant namespace. The listener admits only routes from its own namespace. Keep credentials, buckets, PVCs, and runtime deployments separate for each tenant.

Follow [S3 deployment](s3-storage.md) to deploy privately, create your administrator account, and close signups as appropriate before applying external routing:

```sh
kubectl kustomize deploy/kubernetes/overlays/workspace-gateway
kubectl apply -k deploy/kubernetes/overlays/workspace-gateway
kubectl -n aether-acme get gateway aether
kubectl -n aether-acme describe httproute aether
```

Confirm Gateway conditions `Accepted` and `Programmed`, and HTTPRoute conditions `Accepted` and `ResolvedRefs`. Then verify HTTPS, login, and a persistent WebSocket RPC session through the actual hostname. The route is not an authentication mechanism; the workspace currently uses upstream password accounts. Authentik OIDC remains to be integrated.

The overlay removes the base's same-namespace pod ingress allowance and grants the Cilium proxy identity access to workerd. Cilium assigns Gateway traffic the reserved `ingress` identity; selecting Envoy pods by namespace would not correctly describe this flow. Cluster-wide policies must also allow approved clients to reach the Gateway proxy. Apply source restrictions there according to your environment rather than trusting forwarded headers in Aether.

TLS terminates at the Gateway; the backend hop to workerd is HTTP within the cluster. Backend TLS, enterprise client-source rules, DNS/address allocation, and actual cluster routing are operator configuration. Kubernetes render checks do not prove Cilium dataplane or WebSocket behavior.
