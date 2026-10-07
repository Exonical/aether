# Kubernetes runtime foundation

These manifests deploy the standalone diagnostic runtime. For the native workspace use the [workspace guide](../../docs/standalone-workspace.md); tenant storage and external routing are described in [S3 storage](../../docs/s3-storage.md) and [Cilium Gateway API](../../docs/gateway-api.md).

## Build and configure

```sh
docker build -f runtime/Dockerfile -t registry.example.com/aether/runtime:0.1.0 runtime
docker push registry.example.com/aether/runtime:0.1.0
```

Podman can use the same Dockerfile. Builds need access to the pinned npm packages and Debian repositories. Startup needs no external network. The image contains the native workerd binary and bundled modules, without a Node.js server or package installation at boot.

Set `images.newName` and `newTag` in `base/kustomization.yaml` to your actual registry and tag (for example, your internal zot registry). For a production pilot use an image digest and mirrored, digest-pinned base images. Add `imagePullSecrets` if the registry requires authentication.

Set `spec.volumeClaimTemplates[0].spec.storageClassName` in `base/statefulset.yaml` if the cluster has no suitable default. The CSI driver must support `ReadWriteOncePod` and volume ownership through `fsGroup: 10001`. This access mode prevents multiple pods mounting the claim as writers. On storage that supports only `ReadWriteOnce`, review fencing and ensure no two workerd processes can access the directory; RWO alone allows multiple pods on one node. Do not change the access mode of an existing bound PVC blindly.

## Apply and verify

```sh
kubectl kustomize deploy/kubernetes/base
kubectl apply -k deploy/kubernetes/base
kubectl -n aether rollout status statefulset/aether
kubectl -n aether port-forward service/aether 8080:8080
```

Then, in another terminal:

```sh
curl --fail http://localhost:8080/readyz
curl --fail -X POST http://localhost:8080/internal/probes/worker
curl --fail -X POST http://localhost:8080/internal/probes/state
```

Record the counter value, restart the pod, wait for readiness and read it again:

```sh
kubectl -n aether delete pod aether-0
kubectl -n aether rollout status statefulset/aether
# Restart port-forward after the pod is replaced.
kubectl -n aether port-forward service/aether 8080:8080
```

```sh
curl --fail http://localhost:8080/internal/probes/state
```

The counter should be unchanged. This verifies rescheduling persistence, not backup/restore or high availability. Keep `replicas: 1`; standalone workerd does not distribute Durable Objects among replicas.

The base policy permits port 8080 from pods in the Aether namespace and denies all pod egress. Kubernetes NetworkPolicy requires enforcement by the cluster CNI, such as Cilium. Kubelet probes and port-forward behavior depend on the cluster implementation. No DNS or external service access is needed for the bundled probes. If adding a gateway in another namespace, extend ingress deliberately and protect the unauthenticated diagnostic routes; do not publish them to the internet.

## Kata runtime

With a working `RuntimeClass` named `kata`:

```sh
kubectl get runtimeclass kata
kubectl kustomize deploy/kubernetes/overlays/kata
kubectl apply -k deploy/kubernetes/overlays/kata
```

The overlay changes only `runtimeClassName`. Configure Kata's runtime handler, compatible nodes and scheduling separately. Use a VM-backed runtime before admitting generated user code. The base is useful for the trusted diagnostic module; its V8 isolates are not a hardened security boundary.

## Upgrades and recovery

Preserve `state-aether-0`, the namespace identity in `runtime/aether.capnp`, and the pinned configuration. Do not run a second active workerd process against the volume. Stop the StatefulSet before copying the entire SQLite directory for a consistent initial backup, then restore with the same image and namespace key. Test recovery before changing the workerd version because local-disk storage is experimental.

The image has a read-only root filesystem, non-root UID/GID 10001, no Linux capabilities, a seccomp profile, and writable mounts only for SQLite state and temporary files. Resource limits are starter values; set them from workload measurements when the Workshop is integrated.

The [`workspace-oidc` overlay](overlays/workspace-oidc) adds generic OIDC to the PostgreSQL, S3, model, and Cilium Gateway API example. Build with `AETHER_OIDC=true` and follow the [provider and local Keycloak guide](../../docs/oidc.md). Configure a client and issuer policy per tenant.
