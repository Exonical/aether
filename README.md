# Aether

A self-hosted AI workspace and application runtime, built on [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) and [workerd](https://github.com/cloudflare/workerd), targeting Kubernetes.

**Status: bootstrap.** The full Cloudflare OS UI runs in upstream local-development mode. The standalone runtime verifies the execution and persistence foundation; it does not yet host the Cloudflare OS UI, agents, or Gatekeepers. The existing Cloudflare-hosted deployment remains available.

## Try the full workspace locally

Requires Git, Node.js **24.19+**, and pnpm **11.17+**. No Cloudflare account is required for default local mode.

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

This deploys the runtime foundation, not the full workspace.

## Next implementation milestone

Port the pinned upstream Worker graph into standalone workerd: Router, Workshop, Context, and Scheduler in one process, retaining Worker RPC and dynamic loading. Then implement storage adapters, model access, browser rendering, and Authentik sign-in. [Architecture and port plan](docs/self-hosting.md) describe the binding inventory and acceptance criteria.

| Path | Purpose |
| --- | --- |
| `cloudflare-os/` | Upstream submodule pinned at `6478a1448a11524e2f7c2575ad66fab0bc47c433` |
| `runtime/` | Standalone workerd config, Workers, launcher, image, and integration test |
| `deploy/kubernetes/` | Kustomize base and optional Kata overlay |
| `scripts/run-local.mjs` | Launcher for the pinned upstream development workspace |
| `packages/` | Existing custom Gatekeeper and error reporter |
| `deployment.jsonc` | Existing Cloudflare-hosted configuration |

For deployment to Cloudflare's managed platform, use the preserved [hosted deployment guide](docs/hosted-deployment.md). Existing `pnpm check`, `pnpm deploy`, and customization documentation still apply to that path.

## Validation

`npm test --prefix runtime` launches real workerd processes and checks service binding routing, native WorkerLoader operation, denied Gadget-style ambient networking, 24 concurrent SQLite updates, method handling, and state after restart. CI also renders both Kubernetes overlays, builds the image, and checks startup with a read-only filesystem. A cluster rollout and a complete self-hosted Cloudflare OS session remain separate acceptance tests.

## License

[Apache-2.0](LICENSE). Cloudflare OS and workerd retain their upstream licenses and attribution. Aether is an independent project.
