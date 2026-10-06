# User-provided PostgreSQL KV storage

Aether can back its native KV bindings with an existing on-prem PostgreSQL database. This stores Blueprint metadata, avatar values, and Context snapshots externally. The operator supplies the server, database, dedicated tenant login roles, credentials, and TLS trust. Aether does not deploy a database.

Application Durable Objects and R2 metadata remain local SQLite. R2 blob contents can independently use the [user-provided S3 adapter](s3-storage.md). This is a KV migration milestone, not a replacement of all workerd persistence or support for multiple active replicas.

## Database installation and tenant isolation

Run `runtime/postgres/migrations/001-kv.sql` once in a dedicated application database as a schema administrator. The migration is transactional and intentionally fails if the schema/group already exists; it does not overwrite an existing installation. It creates schema version 1, a login-to-tenant mapping, the KV table, a permission group, and forced row-level security.

Create a dedicated LOGIN role per tenant through your normal database administration and secrets workflow. It must have no superuser, BYPASSRLS, CREATEDB, CREATEROLE, replication, or database/schema/table ownership privileges, including through membership in another role. Grant only application permissions and register its tenant:

```sh
psql -v ON_ERROR_STOP=1 -f runtime/postgres/migrations/001-kv.sql
psql -v tenant_id=acme -v role_name=aether_acme -f runtime/postgres/provision-tenant.sql
```

These commands use the operator's administrator connection environment; do not run them with runtime credentials. The provision script expects an existing login role and does not create passwords. Multiple login roles may map to the same tenant for credential rotation. A role maps to exactly one tenant.

The database policy derives the tenant from **session_user**, the authenticated login. It does not trust a request header, application filter, SET ROLE, or a caller-set tenant variable. Runtime roles can read only their own mapping and may not modify mappings, schema versions, or policies. KV rows are partitioned logically by tenant, namespace, and UTF-8 key bytes. Separate deployment credentials and PostgreSQL RLS enforce the boundary even when tenants share the same database.

At startup the adapter rejects administrative roles and owner memberships, requires enabled/forced RLS on both protected tables, checks schema version 1, and verifies that the login maps to the artifact's tenant ID. Keep these controls in place during upgrades; do not run the adapter with schema-owner credentials.

## Runtime configuration

| Variable | Purpose |
| --- | --- |
| `AETHER_TENANT_ID` | Required; matches the permanent artifact tenant ID and database mapping |
| `PGHOST` | Required supplied hostname or IP address |
| `PGPORT` | PostgreSQL port, default 5432 |
| `PGDATABASE` | Required application database |
| `PGUSER`, `PGPASSWORD` | Required dedicated tenant credentials |
| `AETHER_PG_CA_FILE` | Optional mounted internal CA PEM file |
| `AETHER_PG_SSL_MODE` | `verify-full` (default) or explicitly `disable` |
| `AETHER_PG_ALLOW_PLAINTEXT` | Must be `true` when using `disable`; intended for deliberate test/private transport choices |
| `AETHER_PG_ADAPTER_PORT` | Loopback adapter port, default 9002 |

Certificate and hostname validation remain enabled in the default TLS mode. URL-style database configuration and TLS modes that bypass verification are not accepted. Mount the internal CA from a user-provided Secret and set its path when needed. Environment-based credentials are read at process startup; roll the tenant pod when rotating them.

Build a tenant artifact as usual. It now includes four configs: local KV/local blobs, local KV/S3 blobs, PostgreSQL KV/local blobs, and PostgreSQL KV/S3 blobs. Select KV storage independently from blob storage:

```sh
AETHER_TENANT_ID=acme npm run workspace:build --prefix runtime
npm ci --prefix runtime/postgres --ignore-scripts
# Supply the PostgreSQL settings above through your secrets workflow.
npm start --prefix runtime/postgres
```

In another terminal:

```sh
AETHER_TENANT_ID=acme AETHER_KV_STORAGE=postgres AETHER_STATE_DIR=/path/to/fresh/acme-state npm run workspace:start --prefix runtime
```

Add `AETHER_BLOB_STORAGE=s3` and run the S3 adapter to use both external services. Credentials never enter the workerd artifact.

Changing KV backends does **not** copy existing KV data. Use a fresh state directory for evaluation. A production switch requires a coordinated export/import and backup of existing KV data; no automatic migration utility is included. Preserve the original tenant identity.

## Native protocol and operations

The build retains the pinned native KV Worker, including key/metadata/value limits, binary/text/JSON/stream reads, bulk reads, expiry validation, and list response encoding. It replaces only that Worker's KeyValueStorage implementation, guarded against unexpected changes in the pinned source. The upstream submodule is unchanged.

Values are stored as bytea with atomic per-key upserts. Keys use their UTF-8 bytes for deterministic ordering, and prefix matching treats percent signs and underscores literally. Pagination cursors are scoped to the namespace and prefix. Reads/lists exclude expired values using the database clock; the adapter removes up to 1,000 expired rows every minute. Clock synchronization remains an operator responsibility.

The private adapter listens only on 127.0.0.1:9002. It exposes no generic SQL interface and accepts namespaces only for its configured tenant. Four requests execute concurrently, with up to 32 queued requests whose bodies stay paused. KV values are bounded at 25 MiB. Oversized native streams are fully validated before a PostgreSQL write, preventing truncated values from being committed. There is no Cloudflare-style edge cache/eventual consistency; reads use PostgreSQL directly.

Native workspace readiness reads the selected KV backend and returns HTTP 503 on failure. Adapter readiness checks the database and tenant mapping; liveness checks the process. Database errors are sanitized and credentials/values are not logged.

## Kubernetes and Gateway API

`deploy/kubernetes/overlays/workspace-postgres` extends the tenant S3 deployment with a PostgreSQL adapter and a narrow Cilium egress rule. It expects an existing `aether-postgres` Secret in `aether-acme` containing the settings above. Change the database FQDN/port or use a `toEndpoints` selector for an in-cluster server. The S3 overlay supplies DNS access; adjust it for your cluster's resolver.

Build and publish the workerd artifact and adapter image to the user's registry:

```sh
docker build -f runtime/Dockerfile.workspace -t registry.example.com/aether/workspace:0.4.0-acme runtime
docker build -f runtime/postgres/Dockerfile -t registry.example.com/aether/postgres-kv:0.1.0 runtime/postgres
kubectl apply -k deploy/kubernetes/overlays/workspace-postgres
```

After private administrator bootstrap, use `deploy/kubernetes/overlays/workspace-postgres-gateway` for HTTPS through Cilium Gateway API. The existing S3-only Gateway overlay remains available; both share the [Gateway component](../deploy/kubernetes/components/gateway/gateway.yaml). Supply DNS and the TLS Secret as described in [Gateway API](gateway-api.md).

Each tenant still requires its own namespace, PVC, runtime artifact, scoped S3 credentials, PostgreSQL login, and one active workerd replica. PostgreSQL does not distribute Durable Object ownership.

## Validation and remaining work

`npm test --prefix runtime/postgres` checks TLS/configuration defaults, native error propagation, readiness, and rejection of oversized streamed writes without a database. With `AETHER_TEST_PGHOST` set, it installs schema/roles in a **fresh disposable database named aether_test** and runs native KV operations, role-level read/write isolation, denied mapping changes, expiry, prefix pagination, binary/bulk reads, concurrent writes, and restart persistence. The fixture uses synthetic credentials and requires an isolated PostgreSQL instance; never point it at an existing installation.

Workspace CI runs these tests against PostgreSQL 18 and then the complete upstream workspace regression with PostgreSQL KV, including login, avatars, Blueprint metadata, account isolation, and state after restart. Adapter image startup is checked with a read-only filesystem. Real database TLS, PostgreSQL failover, production import/restore, and Cilium/Kata rollout require environment validation. R2 metadata migration, Authentik OIDC, and automated tenant provisioning remain next work.
