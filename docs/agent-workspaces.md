# Persistent Linux agent workspaces

Aether keeps one application and frontend for all departments. An application
workspace can additionally own one isolated Linux pod and one persistent volume.
This is separate from its JavaScript Gadgets and in-memory Git worktrees: it can
clone repositories, execute project commands and store ordinary development files.

## Enable on Kubernetes

Build the workspace app as usual, plus the execution images:

```sh
docker build -f runtime/execution/Dockerfile.runner -t registry.example.com/aether/execution-runner:0.1.0 runtime/execution
docker build -f runtime/execution/Dockerfile.manager -t registry.example.com/aether/execution-manager:0.1.0 runtime/execution
```

Push them through your existing registry pipeline. For disconnected builds, mirror
the Node base image and Debian packages, or provide a prebuilt internal development
image carrying Node, Git, Python, CA certificates and `/opt/aether/runner.mjs` with
the same entrypoint. No package installation happens when a workspace starts.

Add to the existing OIDC/department Helm values:

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
  egress:
    - toFQDNs:
        - matchName: git.internal.example
      toPorts:
        - ports:
            - port: '443'
              protocol: TCP
```

Use immutable image digests in production. The chart requires OIDC, departments
and network policy when enabling execution. Workspace egress allows DNS and only
the destinations you add. Add separate rules for internal dependency mirrors and
development endpoints. No general Internet access or application/model/IdP/S3
credentials are injected into workspace pods. Set up image pull credentials for
the namespace's default ServiceAccount if the runner image is private: execution
pods do not inherit the application's imagePullSecrets.

The manager is a private loopback sidecar on port 9005. It uses a projected,
rotating Kubernetes token and cluster CA, mounted only in that sidecar. Its Role
is restricted to this release namespace: get/create/delete pods, create pod proxy
requests, and get/list/create PVCs. It cannot read Secrets or use `pods/exec`.
Workspace runners listen on port 9006; there is no public Service or Gateway route.
The controller communicates through the authenticated Kubernetes pod proxy.

Cilium must recognize the API server as `kube-apiserver` for pod-proxy traffic.
Validate that connectivity and the Kata RuntimeClass/CSI combination in your
cluster; the automated fixtures exercise the API contract, not a live cluster.
Custom API-server ports require an adjusted network policy.

## Use

As the workspace owner, expand **Linux workspace** beside the workspace chat.
Click **Start / resume**, then **Refresh status** until it is ready. Starting it
explicitly authorizes your agents to execute commands and edit files there.

Run `git clone https://git.internal.example/team/project.git .` for an empty
workspace, or clone into a named directory and include `cd project` in subsequent
commands. Each command starts a fresh shell in `/workspace`; it is not an
interactive PTY and does not retain shell environment changes. Use chat to assign
a task. Owner-initiated agent turns gain a `workspace` tool for status, commands,
file reads/writes and directory lists. Ask the agent to edit the repository and run
its tests, then use **Review diff** to inspect changes. Gadget source and Linux
repository files are separate; there is no implicit synchronization between them.

**Suspend** revokes the grant for subsequent agent operations and deletes only the
pod. Resume reuses the PVC. Files also persist across application restarts. Deleting
an enabled application workspace suspends its pod and retains its PVC. Operators
must explicitly retire retained PVCs after the desired backup/retention period.
The initial controller permits 32 retained workspace PVCs per installation, each
10 GiB, and pods request 250m CPU/256 MiB with limits of 2 CPU/2 GiB. The controller
serializes operations per workspace and provisioning across the installation.

## Authority and execution limits

Only the owner can directly invoke Linux lifecycle, terminal and file RPCs. A
shared-link build/use collaborator does not acquire that authority. The native
entry point's existing authenticated session guards and current department checks
continue to govern workspace access; forged/revoked sessions cannot reach the
controller. Agent tools check the persisted owner grant and the active turn's
kernel-recorded initiating user on every operation. Collaborator-initiated and
spawned-agent turns have no Linux tool. No gatekeeper, user-supplied URL, image,
pod specification or filesystem identity can select another workspace.

Commands execute immediately under that explicit owner grant. There is no
per-command approval queue or automatic rollback; use repositories and egress
rules suitable for the tasks you authorize. Commands receive a minimal environment
and have a 60-second deadline and 1 MiB combined-output limit. Background processes
in the shell's process group are killed when it exits. Text files are limited to
512 KiB, paths must stay inside the workspace, and symlink escapes are rejected.
Agent-facing output is further bounded to the existing tool-result character
limit. The pod's non-root user, read-only root, dropped capabilities, resource
limits, network policy and Kata boundary contain executable repository code.

Already dispatched commands can run until their deadline after suspension, agent
stop, logout or a membership edit; no transaction rolls back filesystem edits.
Existing background-agent lifetime semantics remain unchanged. Automatic idle
suspension, interactive terminals, browser automation, private Git credential
brokering, per-department quotas, merge-request publication and automatic storage
cleanup are follow-up work.

## Validation

Runner tests execute real Git and shell commands, inspect diffs, restart the runner,
test path escapes, deadlines, output limits and concurrent-operation rejection.
Controller tests check tenant identities, pod hardening, persistent claims and
resource-adoption denial against a synthetic Kubernetes API. Native app tests call
the real authenticated RPC interface through workerd into real Linux runners,
including suspend/resume and sharing/forgery denial. Agent tests drive the real
model loop with a synthetic model, exercising its Linux tool and owner grant.

```sh
node --test runtime/execution/test/*.test.mjs
AETHER_TEST_EXECUTION=true npm run workspace:test --prefix runtime
```

The latter requires a newly built `acme` workspace artifact. A live Kubernetes
rollout and a real model-driven repository task still need deployment validation.
