# Ask, Agent and Git environments

Aether serves one application and frontend for all departments. New chats default
to **Ask**: general conversation, documents, slides, sheets and the original
Cloudflare OS Gadget tools, executed in workerd. Ask cannot access a Linux runner,
even if the workspace previously had an execution grant.

Choose **Agent** in the chat composer for repository work. The same bar offers an
environment and your own Git connector. **RHEL 10** is supported; **Windows** is
visible but disabled. Submitting an Agent message starts or resumes that chat's
Kata pod before prompting the model. Agent gets the shell/file `workspace` tool;
Ask retains the original workerd tools.

Each Agent chat gets its own retained PVC and pod, derived from the application's
workspace identity and chat ID. Chats, users and departments do not share runner
files. Sharing does not grant the owner's container or Git credentials to another
user. Only the owner can start Agent turns and use its workspace controls.

## Identity provider

Include these claims in the verified OIDC **ID token**:

| Claim | Example | Meaning |
| --- | --- | --- |
| `preferred_username` | `bryce` | POSIX login name |
| `uidNumber` | `12345` | Non-root UID |
| `gidNumber` | `23456` | Non-root primary GID |

Integer claims or decimal strings are accepted. IDs must be between 1 and
2147483647; usernames must match `[a-z_][a-z0-9_-]{0,31}`. Root/nobody names and
image-account conflicts are refused. No UID/GID is inferred from an editable
display name, email, browser input or hash. Missing/invalid claims leave Ask
available and disable Agent.

For different claim names, add `AETHER_OIDC_UID_CLAIM`, `AETHER_OIDC_GID_CLAIM` and
`AETHER_OIDC_USERNAME_CLAIM` to the OIDC adapter's existing Secret. Use Keycloak
user-attribute protocol mappers with **Add to ID token** enabled, or Authentik scope
mappings returning these claims. Keep POSIX IDs stable. Changing the trusted
identity requires a new chat rather than adopting the previous identity's PVC.
The Keycloak test realm includes example mappers; production attributes must come
from your trusted directory.

The runner bootstraps the verified account, configures passwordless sudo, then
drops its process to that UID/GID. Commands start as that user. Sudo can become
root **inside the Kata environment**. This requires a writable container root,
privilege escalation and the bootstrap capabilities CHOWN, DAC_OVERRIDE, SETUID,
SETGID and AUDIT_WRITE. The pod has no host mounts, privileged flag, Kubernetes
token, application secrets or model keys. Use a namespace admission policy
compatible with these in-VM permissions and a RuntimeClass that actually uses
Kata. An empty RuntimeClass is rejected.

## Build and enable

```sh
docker build -f runtime/execution/Dockerfile.runner -t registry.example.com/aether/execution-runner:0.1.0 runtime/execution
docker build -f runtime/execution/Dockerfile.manager -t registry.example.com/aether/execution-manager:0.1.0 runtime/execution
```

The default runner uses Red Hat's RHEL 10 UBI Node.js 24 image. UBI carries a subset
of RHEL packages; it does not provide a RHEL subscription or change the Kata guest
kernel. For your subscribed RHEL 10 base, add
`--build-arg RHEL_BASE=registry.internal.example/rhel10/nodejs-24:10.2`.
For disconnected builds, mirror the base image and RPM repositories. Packages are
installed at image build time. Prefer immutable image digests.

Add to your existing OIDC/department Helm values:

```yaml
execution:
  enabled: true
  managerImage:
    repository: registry.example.com/aether/execution-manager
    tag: 0.1.0
  runnerImage:
    repository: registry.example.com/aether/execution-runner
    tag: 0.1.0
  runtimeClassName: kata
  storageClassName: my-csi-class
  idleTimeoutSeconds: 1800
  git:
    providers:
      - id: internal
        label: Internal GitLab
        kind: gitlab
        url: https://git.internal.example
    ca:
      secretName: git-ca
      key: ca.crt
  egress: []
networkPolicy:
  extraEgress:
    - toFQDNs:
        - matchName: git.internal.example
      toPorts:
        - ports: [{port: '443', protocol: TCP}]
```

Merge that egress example with your other adapter rules. Git provider traffic
originates from the application/controller pod; runners reach the private broker,
DNS and destinations in `execution.egress`. Add runner rules for approved package
mirrors and development endpoints. The chart's `imagePullSecrets` also apply to
execution pods.

GitHub uses `kind: github`, `url: https://github.com` and defaults to the
`https://api.github.com/` API. GitHub Enterprise defaults to the configured origin's
`/api/v3/`, GitLab to `/api/v4/`. An administrator-controlled `apiUrl` can override
the API base. Origins/APIs require HTTPS. The optional CA Secret mounts only in
the controller and uses Node's additional CA support.

The controller listens on loopback port 9005. A rotating Kubernetes token mounts
only in its sidecar. Its namespace-scoped Role cannot read Secrets or use
`pods/exec`. It calls runners through the authenticated pod proxy on port 9006.
The broker's port 9007 has an internal ClusterIP Service and no Gateway route;
Cilium permits only this release's execution pods to reach it. Validate API-server
pod-proxy connectivity, Kata and CSI storage in your cluster.

## Link Git and use Agent

Choose **Agent → Connect Git** in the composer. Link a personal access token to an
approved Git service, then choose the account and a repository path such as
`team/project`. Tokens stay in private user storage and are redacted from listings.
GitLab tokens need `read_user` and `read_repository`. GitHub tokens need access to
the chosen repositories with read-only Contents permission and permission to
identify the account.

The controller checks out `/workspace/repository`. It brokers Git smart HTTP with
a random, ten-minute lease allowing only upload-pack for that repository. The
runner's remote contains the lease, not the personal token. Push/receive-pack and
arbitrary repository paths are refused; redirects are not followed. A new owner
turn or **Start / resume** renews the lease and remote without discarding edits.
Disconnecting the account revokes leases, including a launch racing with
disconnect. Protect private user-state backups as you protect existing user model
credentials.

Ask the Agent to edit the repository and run checks. **Workspace** on the chat bar
opens status, commands, files and diff review. Each command starts a fresh shell
in `/workspace`; use `cd repository` for project commands. **Suspend** deletes the
pod and revokes execution access while retaining files. Changing to Ask on the
next message also suspends it. A provisioned chat's repository or identity cannot
change; create a new chat for a different checkout.

Runner pods automatically suspend after **30 minutes** without a start/resume or
shell/file operation. Status polling does not extend the deadline. An in-flight
controller operation is protected, and its completion starts a fresh idle window.
The controller checks every minute and once on startup. Activity is persisted as
a pod annotation, so restarting the application does not reset the deadline;
older pods without the annotation use their creation time. Idle suspension deletes
only the owned pod and revokes its Git lease, retaining the PVC. The next Agent
message or **Start / resume** recreates the pod with the same workspace files.
Installed packages and files outside `/workspace` are ephemeral across suspension.
Long model-only thinking periods and background services do not count as workspace
activity. Set `execution.idleTimeoutSeconds` to `0` to disable automatic suspension,
or to an integer up to 604800 (seven days). The standalone controller uses
`AETHER_EXECUTION_IDLE_TIMEOUT_SECONDS` with the same default and range.

The controller permits 32 retained 10 GiB PVCs per installation. Pods request
250m CPU/256 MiB and have limits of 2 CPU/2 GiB. Deleting an Agent chat or application
workspace suspends its pods and retains PVCs for operator-controlled retirement.
Before upgrading from workspace-wide Linux sessions, suspend/delete their old
runner pods. Their retained PVCs are not adopted by the per-chat identity scheme.

Commands have a 60-second deadline and 1 MiB output limit. Background processes in
the shell's process group are killed at exit. Text operations are limited to
512 KiB and confined to `/workspace`; sudo shell commands can edit the rest of
that isolated container. Dispatched commands can finish after stop/logout or
membership changes; existing background-agent lifetime rules still apply. There
is no per-command approval or filesystem rollback. Interactive terminals, Windows,
Git OAuth, push/MR publication and automatic PVC cleanup remain future work.

## Validation

```sh
node --test runtime/execution/test/*.test.mjs
AETHER_TEST_EXECUTION=true npm run workspace:test --prefix runtime
AETHER_TEST_OIDC_WORKSPACE=true npm test --prefix runtime/oidc
```

OIDC tests require an artifact built with `AETHER_TENANT_ID=acme AETHER_OIDC=true`.
They check trusted identities, account ownership, Ask denial, persistence and mode
switching through real workerd RPC. Broker tests perform a private Git clone. CI
builds the RHEL 10 image and checks actual UID/GID, username and sudo behavior. The
synthetic controller fixtures do not validate a live Kata cluster.
