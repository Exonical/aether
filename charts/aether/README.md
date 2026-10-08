# Aether Helm chart

Deploy one shared Aether application for multiple departments: one frontend, hostname, OIDC client, workerd pod and retained state PVC. Department membership is application data, managed through `/departments`; links and collaborator invitations require a current department shared by owner and recipient. Adding a department requires no Helm upgrade or new image/pod. PostgreSQL, S3, IdP, model endpoints, TLS certificates and credentials remain user-provided. No backing services, Ingress or CRDs are installed.

Requires Kubernetes 1.29+, Helm 3.19+, Cilium policy enforcement/Gateway API support, Gateway API v1 CRDs, a `kata` RuntimeClass, and CSI storage supporting ReadWriteOncePod and fsGroup 10001. Registry names/tags in the example are placeholders. Override RuntimeClass only for trusted evaluation.

## Prepare and install

Copy [examples/production.yaml](examples/production.yaml) to your values file and replace registry, hostname, storage class, admins, Secrets and egress destinations. `tenantId` is the **stable installation/storage identity**, retained for compatibility with existing artifacts. It is not a department ID. Build one image for this application with matching OIDC/model flags:

```sh
AETHER_TENANT_ID=acme AETHER_OIDC=true AETHER_MODEL_GATEWAY=true npm run workspace:build --prefix runtime
docker build -f runtime/Dockerfile.workspace -t registry.example.com/aether/workspace:0.8.0-acme runtime
```

Build/push the adapter images using `runtime/{s3,postgres,models,oidc}/Dockerfile` and the corresponding directory as build context. Refer to the [workspace](../../docs/standalone-workspace.md), [PostgreSQL](../../docs/postgres-storage.md), [S3](../../docs/s3-storage.md), [model](../../docs/model-gateway.md), and [OIDC](../../docs/oidc.md) guides.

Create the application namespace and its existing TLS/configuration/CA/image-pull Secrets first. Configuration Secrets supply environment variables:

| Adapter | Secret settings |
| --- | --- |
| `s3` | `AWS_ENDPOINT_URL`, `BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; optional `AWS_S3_ADDRESSING_STYLE` |
| `postgres` | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `AETHER_PG_SSL_MODE` |
| `models` | `AETHER_MODEL_ENDPOINT`, `AETHER_MODEL_PROTOCOL`, `AETHER_MODEL_ALLOWLIST` JSON, optional `AETHER_MODEL_TOKEN` |
| `oidc` | `AETHER_OIDC_ISSUER`, `AETHER_OIDC_CLIENT_ID`, `AETHER_OIDC_CLIENT_SECRET`; optional signing/membership/department mapping settings |

Use `existingSecret` for each enabled adapter. COSI-provided compatible S3 Secrets can be referenced; buckets and COSI are provisioned independently. `ca.secretName`/`ca.key` mount a private CA into the corresponding adapter. Explicit chart-owned env values override Secret values for installation identity, fixed loopback ports, public origin and mounted CA paths. Services expose only 8080.

Enabled adapters require explicit Cilium `egress` objects or `networkPolicy.extraEgress`: exact `toFQDNs`/ports for external endpoints, or `toEndpoints` namespace/pod selectors for in-cluster services. Customize kube-dns selectors for other resolvers. Policies apply to the entire pod; adapter code further restricts destinations. Gateway ingress uses Cilium's ingress identity; same-namespace ingress requires opt-in.

```sh
helm lint charts/aether --strict -f my-app.yaml
helm template aether charts/aether -n aether -f my-app.yaml > rendered.yaml
helm upgrade --install aether charts/aether -n aether --create-namespace -f my-app.yaml --wait --timeout 10m
kubectl -n aether rollout status statefulset/aether-aether
```

Use `gateway.create: false` with `gateway.parentRefs` for an existing HTTPS Gateway. OIDC `publicUrl` must match the Gateway hostname origin. Register `/gatekeeper/oidc/oauth` and `/gatekeeper/oidc/backchannel-logout` with your IdP. Configure `admins` as exact verified email addresses; default `[]` grants no administrators. `departments.enabled: true` requires OIDC and enables the [department management page](../../docs/departments.md).

For local storage without adapters, supply `tenantId` and your workspace image, leaving adapters/Gateway disabled; port-forward the Service for evaluation. Prefer image digests in production. `imagePullSecrets` supports private registries. `persistence.storageClassName: null` uses the cluster default; `""` explicitly disables dynamic provisioning. ReadWriteOnce is an explicit fallback requiring fencing. Keep one active runtime; Durable Object/R2 metadata remain local even with external PostgreSQL/S3.

## Lifecycle and migration

Keep release name, namespace, installation ID and PVC stable. Back up the complete state directory while the runtime is stopped, including department directory, audit history and OIDC identity/session state. Coordinate PostgreSQL/S3 backups independently. Uninstall retains the PVC but removes workloads, routing and policies. Secret updates require a rollout; `podAnnotations` can trigger one.

This replaces the unmerged fleet chart's `tenants[]` format with one application's values. Do not upgrade an installed fleet directly: plan which workspace/PVC to retain and migrate state explicitly. Existing Kustomize workloads also require deliberate Helm ownership/PVC migration. Never run concurrent writers on a state directory.

CI lints/packages the chart and checks all 16 adapter combinations, storage, private ports/CA mounts, Gateway modes, department prerequisites and invalid settings. Live cluster, storage and external service validation remain deployment checks.

## Ask and Agent environments

See the [Ask and Agent guide](../../docs/agent-workspaces.md) for composer controls, the optional `execution.enabled` controller, trusted OIDC UID/GID claims, per-user Git links and retained per-chat runner PVCs. Ask defaults to workerd. Agent uses RHEL 10 and in-container sudo. Execution requires OIDC departments, Cilium network policies, and a configured Kata runtime. Build and publish both execution images before enabling it.
