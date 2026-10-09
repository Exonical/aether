# Agent execution operations

The execution manager runs beside workerd on loopback port 9005. Its credentials and
operational endpoints must never be exposed to runner pods or through Gateway API.
Use namespace-scoped operator access to inspect the manager container.

## Health and diagnostics

`GET /healthz` is process liveness. `GET /readyz` additionally performs a namespace pod
list against Kubernetes with a three-second request timeout; Kubernetes/authentication
failures return 503 and `KUBERNETES_UNAVAILABLE`. Helm uses this for manager readiness.
A readiness failure removes the application from Service endpoints; repair API access
or RBAC rather than repeatedly restarting workerd. This does not check the IdP, model,
Git or backing storage providers; adapter probes and the on-prem acceptance run cover
those dependencies separately.

`GET /v1/diagnostics` requires the installation's `x-aether-tenant` header. It reports
process-local counters for created pods, successful suspensions/PVC retirements,
failures and successful Git preparation/publication calls, plus in-flight operations
and configured quota/idle/retention limits. Counters reset on restart and are not a
persistent audit ledger or current pod/PVC inventory. Inspect Kubernetes for inventory.

```sh
kubectl --context validation-cluster -n aether-validation exec validation-aether-0 -c execution-manager -- node -e "fetch('http://127.0.0.1:9005/v1/diagnostics',{headers:{'x-aether-tenant':process.env.AETHER_TENANT_ID}}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x,null,2)))"
kubectl --context validation-cluster -n aether-validation logs validation-aether-0 -c execution-manager
kubectl --context validation-cluster -n aether-validation get pods,pvc -l aether.dev/execution=acme
kubectl --context validation-cluster -n aether-validation get events --sort-by=.metadata.creationTimestamp
```

## Events and errors

The manager writes JSON events to stdout. Forward them to your existing log collector
and configure retention/access there. Events include timestamp, component, stable
installation tenant and, when applicable, the hashed workspace ID. Lifecycle events
are `workspace.started`, `workspace.suspended`, `workspace.retired` and
`workspace.operation_failed`. Reconciliation failures are retried and recorded as
`reconciliation.failed`, `reconciliation.partial_failure` or `reconciliation.scan_failed`.
No command text, Git token, pack content, identity claims, branch names, repository
paths or PR title/body is included. Native runner/application logs have separate
content and access requirements; these guarantees apply only to manager events.

Git preparation/application emits `git.prepare`/`git.apply`, with outcome `success`
or `refused_or_failed`, operation kind, workspace and immutable commit SHA when present.
A successful apply can be an idempotent reconciliation, not a new remote mutation.
A failed apply can have an ambiguous remote outcome; retry the exact approved action
through Gatekeeper, not a different pack. These transport events complement the existing
application Gatekeeper audit records (pending/approved/rejected and resolving user);
they do not independently prove owner approval and are not a replacement for those records.

Private workspace errors now contain a bounded `code` and actionable message. The
application may present its existing generic unavailable message; operators can correlate
`workspace.operation_failed` by workspace ID without exposing private provider errors.

| Code or status reason | Operator action |
| --- | --- |
| `CAPACITY_EXHAUSTED` | Count retained PVCs; safely retire disposable expired workspaces or increase `execution.maxWorkspaces`. |
| `IDENTITY_REQUIRED` | Correct the trusted IdP username/UID/GID claim mapping; root/zero IDs are refused. |
| `IDENTITY_CHANGED` | Use a new chat for a different identity/repository; do not relabel retained storage to adopt it. |
| `STORAGE_RETIRING` | Wait for CSI/PVC retirement to finish before starting again. |
| `WORKSPACE_STOPPING` | Inspect node, Kata and CSI health; never force detach an active volume. |
| `WORKSPACE_NOT_READY` | Start/resume, then inspect pod readiness and Events. |
| `CHECKOUT_FAILED` | Check linked Git account permissions, OAuth scopes, internal CA and broker/provider connectivity. |
| `EXECUTION_FAILED` | Inspect Kubernetes/API/runner health; private upstream error details are deliberately suppressed. |
| `SCHEDULING_BLOCKED` | Inspect node capacity, RuntimeClass scheduling constraints, taints and PVC binding. |
| `IMAGE_PULL_FAILED` | Check mirrored image digest, registry trust and image-pull Secret. |
| `RUNNER_CRASH_LOOP` | Inspect runner logs and RHEL UID/GID/bootstrap configuration. |

The last three are optional bounded reasons on workspace status, not raw Kubernetes
messages. The existing UI may display only the state. Alert on recurring reconciliation
failures, readiness failures, scheduling/image errors and approaching retained-PVC quota.
Use [on-prem acceptance](on-prem-acceptance.md) to verify real end-to-end behavior.
