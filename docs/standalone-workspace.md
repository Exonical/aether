# Standalone workspace

This is the first native Cloudflare OS graph in Aether. One workerd process hosts Router, Workshop, Context, Scheduler, the static asset service, and local KV/R2 protocol Workers. The upstream submodule is unchanged.

## Build and launch

With Node.js 24.19+, npm, pnpm 11.17+ and Git installed:

```sh
git submodule update --init
npm ci --prefix runtime
pnpm --dir cloudflare-os install --frozen-lockfile
npm run workspace:build --prefix runtime
npm run workspace:test --prefix runtime
npm run workspace:start --prefix runtime
```

Open **http://localhost:8080**. Create the `admin` account before making the service accessible to anyone else. The launcher binds only to localhost. `AETHER_ADMINS` is a JSON array of upstream password usernames; the local default is `["admin"]`. A configured name does not create an account or reserve it. After your initial accounts exist, use `/admin` to close signups.

The main frontend, Context UI and Scheduler UI are built by their real compilers, without Vite+ task IPC or development watchers. Wrangler runs only `deploy --dry-run` to bundle validated Worker code and text/Wasm/data modules. All compiler subprocesses receive `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false` and `DO_NOT_TRACK=1`. No deployment, account login, managed storage provisioning, or runtime package download is performed.

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

This storage is supplied by Miniflare **5.20260801.1-alpha**'s pinned protocol Workers, compiled into the config. The Miniflare Node server, Node proxy bindings, debug/control endpoints, and optional Node loopback service are not shipped. The running process is native workerd **1.20261006.1**. These local protocol Workers are evaluation infrastructure. The optional [S3 adapter](s3-storage.md) moves R2 blob contents to a user-provided endpoint while keeping metadata local; [PostgreSQL KV](postgres-storage.md) is also available; application Durable Objects and R2 metadata remain local.

The binary config embeds code, not build-host absolute paths or credentials. Disk paths are supplied at launch. Keep the artifact, permanent namespace identities and all three state directori…1107 tokens truncated…torage](s3-storage.md). For external HTTPS routing using Cilium, see [Gateway API](gateway-api.md).

For external KV records and database role isolation, see [PostgreSQL storage](postgres-storage.md).

## Optional on-prem inference

Tenant builds can enable a [scoped model gateway](model-gateway.md) with `AETHER_MODEL_GATEWAY=true`. Default artifacts retain denied ambient networking. The private adapter supports user-provided OpenAI-compatible and Anthropic endpoints without enabling Gadget network access.
