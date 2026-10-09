# Standalone workspace

This is the first native Cloudflare OS graph in Aether. One workerd process hosts Router, Workshop, Context, Scheduler, the static asset service, and local KV/R2 protocol Workers. The Cloudflare OS source is maintained directly in this repository under `cloudflare-os/`.

## Build and launch

With Node.js 24.19+, npm, pnpm 12.10.1 and Git installed:

```sh
npm install --global pnpm@12.10.1
npm ci --prefix runtime
pnpm --dir cloudflare-os install --frozen-lockfile --pm-on-fail=ignore
npm run workspace:build --prefix runtime
npm run workspace:test --prefix runtime
npm run workspace:start --prefix runtime
```

Open **http://localhost:8080**. Create the `admin` account before making the service accessible to anyone else. The launcher binds only to localhost. `AETHER_ADMINS` is a JSON array of upstream password usernames; the local default is `["admin"]`. A configured name does not create an account or reserve it. After your initial accounts exist, use `/admin` to close signups.

The main frontend, Context UI and Scheduler UI are built by their real compilers, without Vite+ task IPC or development watchers. Browser runtime generation and RPC validation also run directly through Node, so building does not depend on a working Windows `pnpm.cmd` shim. Wrangler runs only `deploy --dry-run` against a temporary configuration with the already-completed custom build removed, to bundle validated Worker code and text/Wasm/data modules. The original deployment configurations are preserved. All compiler subprocesses receive `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false` and `DO_NOT_TRACK=1`. No deployment, account login, managed storage provisioning, or runtime package download is performed.

Build dependencies must already be installed. The build pipeline is not an offline package installer; mirror the locked npm/pnpm inputs for a disconnected build.

## Artifact and storage

`runtime/dist/workspace/` is generated and gitignored:

| File | Purpose |
| --- | --- |
| `workspace.capnp.bin` | Binary native workerd configuration, embedded Worker modules and storage extensions |
| `assets/` | Built frontend files, read through a private disk service and exact-path manifest |
| `manifest.json` | Upstream/runtime/storage versions, namespaces, disabled integrations, and state directories |

`AETHER_BUILD_DIR` chooses another artifact directory for build and launch. `AETHER_PORT` changes the local listening port. `AETHER_STATE_DIR` chooses a state directory; the default is `runtime/.workspace-state`.

| State directory | Data |
| --- | --- |
| `do/` | Workshop, Context and Scheduler SQLite Durable Objects |
| `kv/` | KV namespace SQLite metadata and binary values, including avatars and public Context metadata |
| `r2/` | R2 bucket SQLite metadata and Blueprint blob files |

This storage is supplied by Miniflare **5.20261006.0-alpha**'s pinned protocol Workers, compiled into the config. The Miniflare Node server, Node proxy bindings, debug/control endpoints, and optional Node loopback service are not shipped. The running process is native workerd **1.20261007.1**. These local protocol Workers are evaluation infrastructure. The optional [S3 adapter](s3-storage.md) moves R2 blob contents to a user-provided endpoint while keeping metadata local; [PostgreSQL KV](postgres-storage.md) is also available; application Durable Objects and R2 metadata remain local.

The binary config embeds code, not build-host absolute paths or credentials. Disk paths are supplied at launch. Keep the artifact, permanent namespace identities and all three state directories together. Stop workerd before taking an initial file backup. This is a fresh state layout; it does not import the diagnostic counter's database or Wrangler development data.

## Verified behavior and current limits

The integration test starts real native workerd processes and exercises:

- Frontend and SPA asset serving, MIME types, HEAD requests, ETags, and missing-asset handling.
- Real password-account signup/login, rejected wrong passwords, and authenticated HTTP and WebSocket RPC.
- Administrator privileges, denied admin access for another account, and denied cross-account access to a private workspace.
- Context and Scheduler account provisioning through native Worker RPC.
- Workspace creation/title changes and administrator settings across a restart.
- Binary avatar round trips through the KV protocol before and after restart.
- Bundled format Blueprint installation through KV/R2 and presence after restart.

The test uses synthetic password hashes, without storing or printing real credentials. It does not exercise browser UI clicks or the frontend's Argon2 implementation; the production frontend code is bundled unchanged.

Default builds deny ambient outbound networking. Tenant builds can enable the [scoped model adapter](model-gateway.md) for inference to one configured endpoint. Generated Gadgets retain upstream's `globalOutbound: null`. Arbitrary web fetch, OAuth resource connectors, Git-backed Artifacts, and browser/PDF/screenshot export remain unavailable. The UI may display upstream controls for these features; provider keys alone do not grant network access. Real model-driven agent creation remains unvalidated.

Scheduler provisioning is tested, but alarm delivery and scheduled callbacks after rescheduling are not. The original diagnostic runtime independently tests native WorkerLoader loading and denied ambient networking. Model-driven Gadget creation, cross-Gadget isolation, storage expiration/conditional-write contracts, and a real Kubernetes rollout remain later acceptance tests.

The generator rejects unknown top-level upstream configuration and unsupported DO migrations instead of discarding new required platform bindings. The Browser binding is explicitly omitted because the pinned upstream supports its absence; this is recorded as a disabled feature in the artifact manifest. Compatibility dates and flags come from each upstream config, and module order preserves the entry module.

## Kubernetes

Build the workspace artifact first, then package it:

```sh
docker build -f runtime/Dockerfile.workspace -t registry.example.com/aether/workspace:0.2.0 runtime
docker push registry.example.com/aether/workspace:0.2.0
```

Set your actual image in `deploy/kubernetes/overlays/workspace/kustomization.yaml`. Set the CSI storage class in the base manifest. Change `AETHER_ADMINS` to your bootstrap usernames, and confirm that the `kata` RuntimeClass works:

```sh
kubectl get runtimeclass kata
kubectl kustomize deploy/kubernetes/overlays/workspace
kubectl apply -k deploy/kubernetes/overlays/workspace
kubectl -n aether rollout status statefulset/aether
kubectl -n aether port-forward service/aether 8080:8080
```

This overlay uses a VM-backed runtime because the workspace allows code-bearing Gadgets. It retains one replica, the private service, the persistent volume, a read-only root filesystem, non-root UID/GID and default-deny egress. No public ingress is installed. Kata configuration and CSI rescheduling must be validated in your cluster.

The container includes only native workerd and the generated artifact; Node.js, Wrangler and Miniflare's Node server are absent. Use a fresh PVC if evaluating alongside the earlier diagnostic image. If intentionally upgrading the same StatefulSet, its existing diagnostic state can remain on the PVC; workspace state is in separate subdirectories. Never run both processes against the same active workspace directory.

## Next work

Scoped internal model transport is available. Generic [OIDC sign-in](oidc.md) is available with a Keycloak fixture. Preserve account/approval isolation when adding these services. R2 metadata migration, browser rendering, scheduler recovery tests, and operational recovery follow; adding replicas requires a separate distributed DO ownership design.

For tenant-specific artifacts, user-provided S3 storage, and optional COSI credentials, see [S3 storage](s3-storage.md). For external HTTPS routing using Cilium, see [Gateway API](gateway-api.md).

For external KV records and database role isolation, see [PostgreSQL storage](postgres-storage.md).

## Optional on-prem inference

Tenant builds can enable a [scoped model gateway](model-gateway.md) with `AETHER_MODEL_GATEWAY=true`. Default artifacts retain denied ambient networking. The private adapter supports user-provided OpenAI-compatible and Anthropic endpoints without enabling Gadget network access.

## Dependency toolchain

Aether and its source fork both pin pnpm 12.10.1. The `--pm-on-fail=ignore` option also allows the upgrade tests to build historical revisions with the validated toolchain. Aether's build, hosted deployment, and local launcher pass the equivalent setting to child processes. Shared catalog entries, the fork workspace, Vite 7, and Cap'n Web 0.12 remain aligned; major upgrades require separate compatibility work. CI checks root and upstream frozen installs, root test-tool peers, native storage contracts, and workspace state across an old-to-new artifact restart.

Tenant builds can enable [generic OIDC sign-in](oidc.md) with `AETHER_OIDC=true`. This disables password accounts and adds a private, tenant-scoped adapter; it does not enable OAuth resource connectors. The guide includes Windows local testing with Keycloak.
