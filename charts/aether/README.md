# Aether Helm chart

One Helm release manages multiple isolated tenants. Each `tenants` entry creates a dedicated namespace, single-replica StatefulSet, retained state PVC, Services, network policies, and optional Gateway/HTTPRoute and private adapters. PostgreSQL, S3, IdP, model endpoints, TLS certificates and credentials are user-provided. This chart installs no backing services or CRDs.

A single shared workerd process cannot currently host these tenants safely. Durable Objects and R2 metadata remain tenant-local SQLite, even with PostgreSQL and S3 enabled. This chart provides a single installation and upgrade operation for the tenant fleet, with one pod per tenant.

## Prepare images and services

Use Kubernetes 1.29+, Helm 3.19+ or Helm 4, Cilium with policy enforcement and Gateway API support, Gateway API v1 CRDs, a working `kata` RuntimeClass, and a CSI class supporting ReadWriteOncePod and fsGroup 10001. RuntimeClass can be overridden for a trusted evaluation environment. Registry names/tags in the example are placeholders; no prebuilt images are published by this chart.

Build the workspace artifact for **each tenant**, with OIDC/model flags matching that tenant's chart values. Follow the [workspace](../../docs/standalone-workspace.md), [PostgreSQL](../../docs/postgres-storage.md), [S3](../../docs/s3-storage.md), [models](../../docs/model-gateway.md), and [OIDC](../../docs/oidc.md) guides to prepare the external services and images. For the full example, after installing repository dependencies:

```sh
AETHER_TENANT_ID=acme AETHER_OIDC=true AETHER_MODEL_GATEWAY=true npm run workspace:build --prefix runtime
docker build -f runtime/Dockerfile.workspace -t registry.example.com/aether/workspace:0.8.0-acme runtime
# Push to your internal registry; repeat the artifact/image build for beta.
```

Build adapter images using `runtime/{s3,postgres,models,oidc}/Dockerfile` with that adapter directory as build context. They may be shared across tenants; workspace artifacts contain tenant-specific namespace identities. Chart `tenantId` does not rewrite an image, and Helm cannot verify its embedded manifest. Never change tenant identity on an existing PVC. OIDC and model enablement are build-time flags; rebuild images when changing those features.

## Configure a fleet

Copy [examples/production.yaml](examples/production.yaml) into your own values file and replace the two example tenants, registries, storage classes, hostnames, Secrets, and egress destinations. Root settings are common defaults; each tenant overrides its own image, resources, storage, adapters, Gateway, admins, and scheduling settings. Tenant IDs and dedicated namespaces must be unique. Put the Helm release itself in a separate management namespace.

Pre-create tenant namespaces if provisioning Secrets before Helm, and set `createTenantNamespaces: false`. Otherwise the chart creates and retains tenant namespaces. Create the TLS Secret, image pull Secrets, adapter configuration Secrets and optional CA Secrets **in each tenant namespace**. Never put credentials in Helm values: Helm stores release values/manifests in its management namespace.

| Adapter | Existing Secret contents | Private CA setting |
| --- | --- | --- |
| `s3` | `AWS_ENDPOINT_URL`, `BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; optional `AWS_S3_ADDRESSING_STYLE` | `s3.ca.secretName` / `key` |
| `postgres` | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `AETHER_PG_SSL_MODE` | `postgres.ca.secretName` / `key` |
| `models` | `AETHER_MODEL_ENDPOINT`, `AETHER_MODEL_PROTOCOL`, `AETHER_MODEL_ALLOWLIST` (JSON array), optional `AETHER_MODEL_TOKEN` | `models.ca.secretName` / `key` |
| `oidc` | `AETHER_OIDC_ISSUER`, `AETHER_OIDC_CLIENT_ID`, `AETHER_OIDC_CLIENT_SECRET`; optional client/signing/membership settings | `oidc.ca.secretName` / `key` |

COSI-generated S3 Secrets can be referenced through `s3.existingSecret`; Aether does not provision buckets or install COSI. Any compatible user-provided S3 endpoint can be used. CA Secrets default to key `ca.crt`, mounted read-only in the corresponding adapter. Explicit chart-owned environment variables override Secret values for tenant identity, loopback ports, public origin and mounted CA paths. Adapter ports remain unexposed; Services publish only 8080.

Enabled adapters require an egress rule or explicit `networkPolicy.extraEgress`. Each adapter's `egress` accepts Cilium egress objects: exact `toFQDNs` plus TCP ports for external services, or `toEndpoints` namespace/pod selectors for in-cluster services. DNS is allowed to kube-dns with Cilium DNS proxy rules. Customize DNS selectors for clusters with another resolver. These policies apply to the whole tenant pod, while adapter code further restricts destinations. No adapter's egress is added when it is disabled. Ingress defaults to the Cilium ingress identity when Gateway routing is enabled; same-namespace ingress requires explicit opt-in.

Use `gateway.create: false` with `gateway.parentRefs` to attach tenant HTTPRoutes to an existing shared Gateway. The shared Gateway must allow routes from tenant namespaces and provide HTTPS for their hostnames. OIDC `publicUrl` must exactly match `https://<gateway.hostname>`. Register both `/gatekeeper/oidc/oauth` and `/gatekeeper/oidc/backchannel-logout` with the tenant IdP client. Set `admins` to verified email addresses. No Ingress resource is created.

## Install and upgrade

```sh
helm lint charts/aether --strict -f my-fleet.yaml
helm template aether charts/aether -n aether-system -f my-fleet.yaml > rendered.yaml
helm upgrade --install aether charts/aether --namespace aether-system --create-namespace -f my-fleet.yaml --wait --timeout 10m
kubectl -n aether-acme rollout status statefulset/aether-acme-aether
kubectl -n aether-beta rollout status statefulset/aether-beta-aether
```

A minimal local-storage fleet values file is:

```yaml
tenants:
  - tenantId: acme
    namespace: aether-acme
    image:
      repository: your-registry/aether/workspace
      tag: acme
  - tenantId: beta
    namespace: aether-beta
    image:
      repository: your-registry/aether/workspace
      tag: beta
```

The tenant-specific images must be built without OIDC/models for this minimal configuration. Gateway is disabled; use `kubectl -n aether-acme port-forward service/aether-acme-aether 8080:8080` for local evaluation. Default `admins: []` grants no administrator access; configure initial administrators explicitly. Prefer image digests in production (`image.digest` takes precedence over `tag`). Set `imagePullSecrets` for your private registry.

`persistence.storageClassName: null` omits the field and uses the cluster default; `""` explicitly disables dynamic provisioning. ReadWriteOnce is an explicit fallback requiring separate fencing; it does not prevent multiple writers on one node. Scaling above one replica is deliberately unsupported.

## State and lifecycle

Keep release name, tenant ID, namespace and resource name stable. Back up the entire tenant PVC while its StatefulSet is stopped, including OIDC session/identity state. Coordinate backups with PostgreSQL and S3 independently. Removing a tenant from values or uninstalling deletes its workload/routing/policies but **retains its namespace and PVC**; data deletion is a separate operator action. Removing a tenant does not revoke its external service credentials. Secret changes need a pod rollout (for example, change that tenant's `podAnnotations` or run `kubectl rollout restart`).

Helm does not automatically adopt existing Kustomize objects. Migrate with explicit ownership and PVC planning, ensuring only one runtime writes each state directory. Fleet upgrades can update several independent tenant pods; this is not distributed Durable Object HA or an automated tenant provisioning API.

## Validation

```sh
python3 -m pip install PyYAML
python3 charts/aether/tests/render.py
helm package charts/aether
```

CI lints/packages the chart and checks all 16 adapter combinations, multi-tenant isolation, shared Gateway routing, Secrets/CA mounts, storage variants, digest selection and rejected configuration. Rendering checks do not validate a live cluster, storage driver, external credentials, or IdP configuration.
