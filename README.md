# Aether

A self-hosted AI workspace and application runtime, built on [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) and [workerd](https://github.com/cloudflare/workerd), targeting Kubernetes.

**Status: standalone workspace evaluation.** Router, Workshop, Context, Scheduler, and the frontend now run directly in workerd with persistent local KV, R2, and Durable Object state. Password accounts, workspace management, and administrator settings are tested. User-provided S3 blob storage, tenant-specific runtime artifacts, and Cilium Gateway API manifests are available. PostgreSQL can back native KV namespaces with dedicated tenant roles and row-level security. Scoped access to a user-provided model gateway is available. Generic OIDC sign-in is available, with Keycloak integration tests and a [local setup guide](docs/oidc.md). Browser rendering remains unavailable. The original diagnostic runtime and Cloudflare-hosted deployment remain available.

## Run the standalone workspace

Requires Git, Node.js **24.19+**, pnpm **11.28.5**, and npm. Build dependencies are installed once; the running server uses only workerd and local disk.

```sh
git clone --recurse-submodules https://github.com/Exonical/aether.git
cd aether
npm install --global pnpm@11.28.5
npm ci --prefix runtime
pnpm --dir cloudflare-os install --frozen-lockfile --pm-on-fail=ignore
npm run workspace:build --prefix runtime
npm run workspace:test --prefix runtime
npm run workspace:start --prefix runtime
```

Open **http://localhost:8080** and create the `admin` account while access is limited to your machine. Local administrator usernames default to `["admin"]`; set `AETHER_ADMINS` to a JSON array to choose your own. Local data defaults to `runtime/.workspace-state`, separate from the diagnostic runtime and Wrangler development data.

The build invokes the compilers directly and uses Wrangler only for offline dry-run bundling, with telemetry disabled. Miniflare's pinned KV/R2 Workers are included at build time; no Miniflare server or Wrangler process runs at startup. **Inference is disabled in default builds**; tenant builds can enable a [scoped on-prem model gateway](docs/model-gateway.md). Browser export remains unavailable. [Standalone workspace guide](docs/standalone-workspace.md) explains the artifact, storage, and limits.

## Upstream development mode

Requires Git, Node.js **24.19+**, and pnpm **11.28.5**. No Cloudflare account is required for default local mode.

```sh
git clone --recurse-submodules https://github.com/Exonical/aether.git
cd aether
pnpm run-local
```

For an existing checkout, run `git submodule update --init` first. The launcher installs upstream dependencies, builds the frontend, and starts the local server at **http://localhost:8787**. The first build takes several minutes. Create an account named `admin` to access upstream administrator features; configure your models there. External providers require their credentials. Cloudflare-only features are not reproduced by this launcher.

This development server is for local evaluation. See [self-hosting](docs/self-hosting.md) for state, dependencies, and the production port.

## Run the standalone runtime

This path is independent of the large upstream workspace and needs only Node.js and npm:

```sh
npm ci --prefix runtime
npm test --prefix runtime
npm start --prefix runtime
```

In another terminal:

```sh
curl http://localhost:8080/api/runtime
curl -X POST http://localhost:8080/internal/probes/worker
curl -X POST http://localhost:8080/internal/probes/state
```

The fixed Worker probe reports successful loading and denied ambient network access. The state probe increments a SQLite-backed Durable Object counter that survives process restarts. Local state defaults to `runtime/.state`; use `AETHER_STATE_DIR` to change it and `AETHER_PORT` to change the port.

The runtime exposes diagnostic endpoints without authentication. Keep it private. It accepts only the bundled diagnostic module, not arbitrary user code.

## Deploy multiple tenants with Helm

The [Helm chart](charts/aether/README.md) manages a tenant fleet with one release. Each tenant gets its own namespace, runtime pod, PVC, credentials, Cilium policies and optional Gateway API route. PostgreSQL, S3, OIDC and model services are user-provided. Customize the example before installing:

```sh
helm upgrade --install aether charts/aether --namespace aether-system --create-namespace -f my-fleet.yaml --wait
```

## Deploy the runtime to Kubernetes

[Deployment instructions](deploy/kubernetes/README.md) cover building an image, selecting your registry and CSI storage, and applying the base or Kata overlay. The manifests create one StatefulSet replica, a persistent volume, HTTP probes, and a policy denying outbound network access. They expose a ClusterIP service; no public ingress is installed.

```sh
docker build -f runtime/Dockerfile -t registry.example.com/aether/runtime:0.1.0 runtime
docker push registry.example.com/aether/runtime:0.1.0
# Set your image and storage class in deploy/kubernetes/base first.
kubectl apply -k deploy/kubernetes/base
kubectl -n aether rollout status statefulset/aether
kubectl -n aether port-forward service/aether 8080:8080
```

This deploys the diagnostic runtime. For the workspace image and Kata overlay, use the [workspace deployment instructions](docs/standalone-workspace.md#kubernetes).

## Tenant storage and external routing

Use the [S3 and tenant deployment guide](docs/s3-storage.md) for an existing S3-compatible endpoint and optional COSI credentials. The [PostgreSQL KV guide](docs/postgres-storage.md) adds external metadata and avatar storage with database-enforced tenant isolation. The [Cilium Gateway API guide](docs/gateway-api.md) adds HTTPS routing through Gateway and HTTPRoute resources. Aether does not install an object store. Tenant deployments have separate runtime identities, PVCs, and credentials; The [on-prem model gateway guide](docs/model-gateway.md) adds private inference access. The [generic OIDC guide](docs/oidc.md) adds tenant-scoped sign-in. Automated tenant provisioning remains future work.

## Next implementation milestone

Add Authentik sign-in, then implement R2 metadata migration and browser rendering. Durable Object and R2 metadata state remain local SQLite; KV can use PostgreSQL, and R2 blobs can use a user-provided S3-compatible endpoint through the private adapter. [Architecture and port plan](docs/self-hosting.md) describe the binding inventory and acceptance criteria.

| Path | Purpose |
| --- | --- |
| `cloudflare-os/` | Upstream submodule pinned at `6478a1448a11524e2f7c2575ad66fab0bc47c433` |
| `runtime/` | Diagnostic runtime and native workspace build, config, images, and integration tests |
| `deploy/kubernetes/` | Diagnostic base, workspace, tenant S3, and Cilium Gateway API overlays |
| `scripts/run-local.mjs` | Launcher for the pinned upstream development workspace |
| `packages/` | Existing custom Gatekeeper and error reporter |
| `deployment.jsonc` | Existing Cloudflare-hosted configuration |

For deployment to Cloudflare's managed platform, use the preserved [hosted deployment guide](docs/hosted-deployment.md). Existing `pnpm check`, `pnpm deploy`, and customization documentation still apply to that path.

## Validation

`npm test --prefix runtime` launches real workerd processes and checks service binding routing, native WorkerLoader operation, denied Gadget-style ambient networking, 24 concurrent SQLite updates, method handling, and state after restart. CI also renders both Kubernetes overlays, builds the image, and checks startup with a read-only filesystem. `npm run workspace:test --prefix runtime` verifies real upstream password authentication over HTTP and WebSocket, account isolation, Context/Scheduler provisioning, asset serving, avatars through KV, bundled Blueprints through R2, and workspace/admin persistence after restart. Workspace CI also builds and starts the native image. A cluster rollout, scheduled callback delivery, and model-driven Gadget creation remain untested.

## License

[Apache-2.0](LICENSE). Cloudflare OS and workerd retain their upstream licenses and attribution. Aether is an independent project.
