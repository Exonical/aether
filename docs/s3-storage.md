# User-provided S3 storage and tenant deployments

Aether consumes an existing S3-compatible endpoint. It does not install or administer MinIO, SeaweedFS, Ceph, or another object store. COSI is an optional source of bucket credentials, not a runtime dependency.

The first integration moves **R2 blob contents** to S3. The pinned R2 Worker still provides the native R2 binding contract, including metadata, list operations, conditional writes, and multipart assembly. R2 metadata, KV metadata/values, and application Durable Objects remain SQLite on the tenant's PVC. S3 keys are opaque immutable blobs, not the application's R2 object names. Preserve the metadata volume and bucket together for recovery. [PostgreSQL KV](postgres-storage.md) can independently move KV records externally; R2 metadata and application Durable Objects remain local.

## Tenant boundary

Deploy one workspace pod and PVC in a separate namespace per tenant, with one active workerd replica. Build the artifact with a permanent tenant ID:

```sh
AETHER_TENANT_ID=acme npm run workspace:build --prefix runtime
docker build -f runtime/Dockerfile.workspace -t registry.example.com/aether/workspace:0.3.0-acme runtime
docker build -f runtime/s3/Dockerfile -t registry.example.com/aether/s3-adapter:0.1.0 runtime/s3
```

The build produces both local and S3 workerd configs using the same tenant-specific Durable Object, KV, R2, and Context sharing identities. The tenant ID permits lowercase letters, digits, and hyphens, up to 63 characters. It is embedded in the artifact and must match the adapter's ID. Use a separate output directory with `AETHER_BUILD_DIR` when keeping multiple tenant artifacts.

Existing default artifacts retain `aether-workspace-v1`. Setting a tenant ID changes the storage identities: it is a fresh tenant, not an automatic migration of previous data. Neither moving between local/S3 modes nor changing a bucket/prefix migrates blobs. Use a fresh state directory for S3 evaluation.

Each adapter admits only BlobStore paths belonging to its compiled tenant namespace. It binds to **127.0.0.1:9001**, has no Service or exposed pod port, and exposes no list or bucket-administration API. Only the trusted R2 Worker receives its binding; generated Gadgets retain denied ambient networking. The sidecar uses Node.js and the AWS SDK; workerd remains the native application server.

Prefer a bucket and credentials dedicated to each tenant. Shared buckets are supported through separate prefixes, but require corresponding S3 credential policies to enforce that boundary outside Aether. A prefix alone is not a backend authorization boundary. Tenant creation, membership management, OIDC, and automated deployment provisioning remain future control-plane work; this is deployment-level tenant isolation.

## Connection settings

Provide settings to the adapter at deployment time; credentials never enter the workerd artifact.

| Variable | Purpose |
| --- | --- |
| `AETHER_TENANT_ID` | Required; matches the artifact's tenant ID |
| `AWS_ENDPOINT_URL` | Required HTTP(S) origin, such as `https://s3.storage.example`; no path, query, or URL credentials |
| `BUCKET_NAME` | Required existing DNS-compatible bucket |
| `AWS_DEFAULT_REGION` | Required signing region supplied by the storage administrator |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Required credentials scoped to the tenant's bucket or prefix |
| `AWS_SESSION_TOKEN` | Optional temporary-credential token; restart with refreshed credentials before expiry |
| `AWS_S3_ADDRESSING_STYLE` | `path` (default) or `virtual`; virtual requires suitable bucket DNS and TLS certificates |
| `AETHER_S3_PREFIX` | Optional stable relative prefix ending in `/`; defaults to `aether/<tenant-id>/` |
| `AETHER_S3_CA_FILE` | Optional mounted internal CA PEM file; certificate validation stays enabled |
| `AETHER_S3_ALLOW_HTTP` | Set `true` only when intentionally using an unencrypted endpoint |
| `AETHER_S3_PORT` | Optional loopback adapter port; default 9001; update workerd's external address if changed |

The adapter uses standard S3 GET/HEAD/PUT/DELETE and multipart initiation, part upload, completion, and abort. It uses SigV4 and bounded multipart buffering (two 8 MiB parts), without provider-specific APIs or automatic bucket creation. Grant object read/write/delete and multipart permissions scoped to its prefix. Bucket-list permission is not needed for native R2 list operations, which use local metadata. Configure cleanup of **incomplete multipart uploads** in your object store; do not expire live opaque blobs independently of R2 metadata.

A failed S3 write throws through the workerd bridge before R2 commits metadata. Failed reads/deletes propagate errors; background blob cleanup may leave orphaned objects after failures. Probes check local process health and KV readiness, not the availability of the remote bucket. Monitor S3 operation errors and verify the bucket with a real write/read during rollout.

For local evaluation, export the settings into the shell and run the adapter in one terminal:

```sh
npm ci --prefix runtime/s3 --ignore-scripts
npm start --prefix runtime/s3
```

In another terminal, with the same tenant artifact selected:

```sh
AETHER_TENANT_ID=acme AETHER_BLOB_STORAGE=s3 AETHER_STATE_DIR=/path/to/fresh/acme-state npm run workspace:start --prefix runtime
```

## Kubernetes and COSI

The `deploy/kubernetes/overlays/workspace-s3` example deploys tenant `acme` into `aether-acme`. Change the namespace, tenant ID, image tags, storage class, bootstrap administrators, and endpoint egress policy for your deployment. Create a Secret named `aether-s3` containing the connection settings above using your existing secrets workflow. No object store, bucket, credentials, or CA is generated by these manifests.

COSI **v1alpha2** S3 Secrets can be supplied through the existing `envFrom.secretRef` when they contain `COSI_PROTOCOL`, `AWS_ENDPOINT_URL`, `BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_S3_ADDRESSING_STYLE`, and credential keys. `COSI_CERTIFICATE_AUTHORITY` accepts a PEM CA from that Secret. Explicit `AETHER_S3_CA_FILE` takes precedence.

For older COSI **v1alpha1** drivers, mount the generated Secret's `BucketInfo` key as a file and set `AETHER_COSI_BUCKET_INFO` to that path. The adapter reads the S3 fields from `spec.bucketName` and `spec.secretS3`. Supply addressing style and internal CA separately if the driver's document omits them. Provisioning CRDs and controller/driver versions are the operator's responsibility; Aether does not assume that a particular COSI driver is installed.

The default egress example permits DNS through kube-dns and TCP 443 to the exact external FQDN `s3.storage.example`. Replace the hostname and port. For an S3 service inside Kubernetes, replace that FQDN rule with a Cilium `toEndpoints` selector matching the storage namespace and pod labels. DNS selectors may also need adjustment for NodeLocal DNS. Keep the allowance restricted to the supplied endpoint. Network policy operates at pod level; workerd separately denies global network access and reaches only its fixed loopback adapter.

Apply the private overlay first and bootstrap the administrator before exposing the workspace:

```sh
kubectl apply -k deploy/kubernetes/overlays/workspace-s3
kubectl -n aether-acme rollout status statefulset/aether
kubectl -n aether-acme port-forward service/aether 8080:8080
```

The runtime requires a working Kata RuntimeClass and CSI ReadWriteOncePod support. Storage, credentials, and TLS are supplied by the user.

## Validation

`npm test --prefix runtime/s3` checks configuration, COSI formats, path confinement, and native R2 failure behavior without a backend. Setting `AETHER_TEST_S3_ENDPOINT` also runs native workerd through the adapter against a real test endpoint, including a 20 MiB streamed S3 multipart upload, native R2 multipart assembly, range reads, metadata, list/delete, and restart persistence. Test credentials default to `aether-test`/`aether-test-secret`; override with `AETHER_TEST_S3_ACCESS_KEY` and `AETHER_TEST_S3_SECRET_KEY`. This test creates a disposable bucket and requires bucket-administration privileges; never run it with production tenant credentials.

CI runs the same contract against MinIO and SeaweedFS. Custom-CA TLS is tested against a signed HTTPS fixture. Ceph RGW and a real COSI/Kubernetes rollout still require environment-specific validation.
