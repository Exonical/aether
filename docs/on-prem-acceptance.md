# On-prem deployment acceptance

This procedure validates one application serving multiple departments against a real
Cilium Gateway API, Kata/RHEL 10, CSI storage, internal OIDC and enterprise Git deployment.
CI fixtures are useful regression coverage; they do not establish cluster acceptance.
No live cluster acceptance has been performed by adding this procedure.

Use a dedicated validation namespace, disposable enterprise Git repository and synthetic
users. Mirror the application, adapters and RHEL runner images into your private registry;
use immutable digests. Supply existing PostgreSQL, S3-compatible storage, model gateway,
internal CA trust and a confidential Keycloak or Authentik OIDC client. Follow
[Helm deployment](../charts/aether/README.md), [OIDC](oidc.md),
[Agent workspaces](agent-workspaces.md) and [Agent security](agent-security.md).
Enable departments, execution and `execution.git.allowWrites` for this run. Git OAuth
scopes must allow writes; reconnect accounts previously linked with read-only scopes.
Do not disable TLS verification to accommodate internal certificates.

## Read-only preflight

Requires Node 24.19+ and kubectl with read access to the specified namespace plus
RuntimeClasses and GatewayClasses. The script never reads Secrets or changes resources.
The name is the actual StatefulSet/HTTPRoute name, normally `<helm-release>-aether`.

```sh
node runtime/validation/on-prem.mjs --context validation-cluster --namespace aether-validation --name validation-aether > preflight.json
```

It checks the current ready application generation, required adapters, department/Agent
flags, enterprise Git configuration, Kata RuntimeClass, workspace Cilium policy and
accepted/resolved HTTPRoute parents using programmed Cilium Gateways. Exit status is 1
on failed or inaccessible prerequisites. A pass is configuration/readiness evidence,
not proof of runtime confinement, image provenance, TLS, IdP claims or Git permissions.
Review the runner image digest and RHEL subscription/image provenance separately.

## Live acceptance

Create Alice and Bob in department Engineering and Carol in department Finance. Give
Alice and Bob different trusted POSIX usernames/UIDs/GIDs in signed ID tokens; no UID/GID
may be zero. Use separate browser profiles so sessions cannot overlap. Record the chart
version, image digests, cluster/Kata/Cilium/CSI versions, IdP, Git provider and timestamp.
Keep evidence free of tokens, cookies, OAuth codes and Secret contents.

| Check | Procedure and expected result |
| --- | --- |
| Gateway/TLS | Open the configured HTTPS hostname through Gateway API. Its certificate validates using your internal CA; HTTPRoute reaches the application. |
| Default Ask | Sign in through your real IdP. A new chat defaults to Ask; normal chat/docs work without creating a runner pod. |
| User identity | Alice selects Agent, RHEL 10 and her linked enterprise Git repository. Run `id; cat /etc/os-release; sudo -n id`. Shell identity matches Alice's signed UID/GID; OS is RHEL 10; sudo reports UID 0 inside the sandbox. Repeat for Bob and verify different IDs and workspace pods/PVCs. |
| Kata and credentials | Read the generated pod manifest using kubectl. Confirm `runtimeClassName` is the intended Kata class and automount is false. In the agent shell, the Kubernetes service-account token path must be absent; the checkout must contain no enterprise Git token. Confirm the configured RuntimeClass uses the installed Kata handler. |
| Network confinement | From the agent shell, attempt HTTP/TCP access to a known reachable internal endpoint outside the allowed Git broker. It must fail, including under sudo. A permitted repository fetch must succeed through the broker. Validate enforcement with Cilium policy verdicts, rather than interpreting DNS failure as proof of TCP denial. |
| Department sharing | Alice shares a chat with Bob: permitted. Carol opens the same link or attempts collaboration: denied. Verify direct link access as well as UI visibility; test switching department membership and revocation. |
| Local Git | Ask the agent to create a branch, edit a file and commit. Local work succeeds without publishing or approval. |
| Approved publish | Ask for a push and PR/MR. Before approval, the remote branch/PR must not exist. Review the captured commit locally (the approval card does not yet show its full diff), approve, then verify exact remote SHA, task branch, target base and PR/MR title/body. |
| Denied publish | Reject a second action; remote refs/PRs remain unchanged. Attempts to write protected base branches, force-push, delete branches, target another repository or bypass the broker must fail. |
| Idempotent retry | Retry the same approved immutable operation after a transient provider failure. Reconcile its status; it must not create duplicate PRs or publish a different commit. An ambiguous publication can block sensitive reads/deletion until that exact approval is reconciled. |
| Revocation | Disconnect Git: the existing broker lease stops fetching and new actions fail. Log Alice out through IdP logout/back-channel flow: her saved Aether session and WebSocket must stop working. Test removal of department access as well. Already dispatched commands can finish; logout is not a rollback. |
| Idle/resume | Set a short idle timeout in this validation release. Create a marker under `/workspace`, wait for idle pod deletion, then resume. New pod UID, same PVC UID and marker content; repository lease refreshed. Status polling must not prevent suspension. |
| Terminal recovery | In the validation namespace, delete the runner pod normally (never force detach its volume), then start/resume. Same PVC and marker, new ready pod. Confirm CSI attach/mount and scheduling events. Terminal Failed/Succeeded pods are also replaced on the next start. |
| Retention/quota | On disposable workspaces only, enable a short `retentionSeconds` and small `maxWorkspaces`. Suspend and wait; only expired PVCs with no pod are deleted. A resumed workspace is preserved. Allocation beyond the retained-PVC quota is refused. Verify the StorageClass reclaim policy and actual backing-volume disposal. |
| Controller restart | Restart the validation application through your normal rollout procedure. Persisted idle/retention deadlines must survive, and retained files must resume. Git leases are in memory: a fresh authenticated start is required after restart. |

The idle/retention controller examines resources every minute. Retention begins when
a successfully suspended pod is first confirmed absent, so slow teardown does not consume
the recovery window. Starting/resuming clears any previous marker before pod creation. Workspaces with running
pods, including pods still terminating, are never eligible for PVC cleanup. Legacy PVCs
without a retention marker are preserved for explicit operator review. Setting retention
to zero disables deletion. Backups/snapshots and the storage provider reclaim policy are
operator responsibilities; deletion can permanently remove workspace files.

## Evidence and diagnosis

Record each live row as PASS/FAIL/NOT RUN with actual and expected outcomes; do not mark
acceptance complete from a successful preflight or CI run alone. Save preflight output
and sanitized evidence with your internal deployment record.

For scheduling/mount/boot failures, inspect runner pod conditions and namespace Events.
For reconciliation errors, inspect the execution-manager container logs; failures are
retried. Avoid publishing these logs without review because commands and paths may contain
sensitive user information. For a pod stuck terminating, repair node/runtime/CSI health
before resuming; do not force detach a volume that could still be mounted. Capacity includes
suspended PVCs; raising the quota or safely retiring disposable expired workspaces frees
allocation capacity. Node failure recovery depends on the cluster and CSI fencing behavior.
