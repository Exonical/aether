# Agent security and enterprise Git actions

Agent mode uses Gatekeeper for external Git changes and Kata for execution isolation.
Ask mode retains its workerd capability model. A selected repository is the initial
checkout: the Agent may switch local branches, edit files, test, and commit through
the workspace tool. The repository itself stays fixed for the chat and retained PVC.

## Enable approved writes

Writes are disabled by default. Configure approved self-hosted providers as in
[enterprise-git-oauth.md](enterprise-git-oauth.md), then set:

```yaml
execution:
  enabled: true
  git:
    allowWrites: true
networkPolicy:
  enabled: true
  clusterDomain: cluster.local
```

Rebuild both controller and runner images, rebuild the workspace artifact, and
roll out the chart. The controller now includes Git and a private bounded scratch
volume; credentials remain outside the runner. Grant the controller HTTPS egress
to the approved enterprise Git service using `networkPolicy.extraEgress`.

With writes enabled, new GitLab OAuth connections request `read_user`,
`read_repository`, `write_repository`, and `api`. Register those scopes on the
confidential application and reconnect existing users. `write_repository` covers
Git-over-HTTP; `api` is needed to create merge requests. These are broad provider
grants; Aether restricts their use to the selected repository and approved
operations. GitHub Enterprise OAuth already uses `repo` and `read:user`.
Read-only existing credentials remain usable for checkout but cannot perform
writes their provider does not permit. PAT fallback requires equivalent scopes.

## Approval lifecycle

The Agent gets two tools: `workspace` for local execution and `git_action` for
external changes. For example:

1. Use workspace to create a branch, implement and test a change, and commit it.
2. Request `git_action` with `action: "push"`, `branch: "fix/login"`, and
   `base: "main"`. The server chooses the destination
   `aether/<chat-derived-prefix>/fix/login` within the selected repository.
3. Review the Gatekeeper action card and approve or reject it. The Agent turn
   pauses while a decision is pending and resumes after approval.
4. Request `action: "pull-request"` with the same branch/base and exact title/body.
   Approve that separate action to create the GitHub PR or GitLab merge request.
5. Use `action: "status"` with the returned action ID to obtain the redacted result.

Each write needs owner approval in this version. A chat instruction alone is not
interpreted as a reusable permission grant. No auto-approval kinds are exposed
for Agent Git; broader task grants require a separate explicit authorization UI.
Collaborators cannot use these Git tools, approve their writes, or obtain a
Gatekeeper session that bypasses the owner-started Agent tool path. Existing
department restrictions continue to govern app sharing; this does not replace
provider repository permissions with department membership.

Push cards identify the repository, destination branch, base, exact commit and
pack size/SHA-256. Packs are captured before approval and persisted privately in
bounded chunks, so later sandbox edits cannot change the approved artifact.
Packs are marked as incomplete descriptions in the existing approval UI; it does
not render a full commit diff. Review the captured commit before approving.

The kernel bounds and validates the sandbox pack before the controller handles
it. Only a controller-confirmed existing remote commit receives remote
provenance; new commits stay local until approval. Gatekeeper's normal ancestry
check and pending-push marks are used. Pushes are refused after the workspace
has observed restricted data, both when queued and when applied. PR text stays
subject to the existing manual review model in restricted workspaces.

At apply time the facet resolves fresh credentials from the owner's User object,
checks the retained identity, and sends the captured artifact through a private
controller route. The controller verifies remote ancestry again and checks the
expected target head. It uses an explicit lease to refuse concurrent remote
changes; it first requires fast-forward ancestry, so the lease does not authorize
history rewriting. Retries recognize an already-pushed exact commit or an open
PR with exactly matching branches/title/body. A changed PR body requires a new
action. Provider branch protections still apply.

Disconnecting a connection blocks subsequent approvals. The broker checks
revocation again immediately before sending a write, including after network
reads. A write already accepted by a provider cannot be undone by disconnecting.
Rejected actions delete their private pack. Pending actions expire after 24 hours;
reject expired cards to release their slots. Each facet permits eight pending
actions. Snapshots contain new objects since the local remote base anchor, with deltas
disabled. They are limited to 2 MiB compressed, 8 MiB inflated, 1 MiB per object
and 4096 objects. The controller verifies the anchor on the actual base branch
before importing sandbox bytes; base history lookup is bounded to 256 commits.
An old base anchor may require fetching/rebasing before retrying. Larger changes
need a separately designed artifact transport.

## Enforced sandbox boundary

The runner never receives a Git OAuth/PAT token, OAuth client secret, Kubernetes
credential, or writable Git lease. Its port-9007 lease can only perform Git
upload-pack reads for one repository. Approval APIs are on the controller's
private loopback port, outside the sandbox network policy.

The chart requires network policy for Agent execution and rejects nonempty
`execution.egress`. Runner egress is only to this app's private Git broker and
cluster DNS, with DNS requests restricted to the broker's exact service name.
Set `networkPolicy.clusterDomain` if the cluster uses another DNS suffix. This
prevents arbitrary destination access and arbitrary DNS queries, including from
commands run with in-container sudo. Local hooks or scripts are untrusted; the
controller performs its own fixed Git invocations in disposable repositories
with hooks, credential helpers, redirects and file/ext transports disabled.

Unrestricted package downloads and external network tools therefore cannot run
from the sandbox. Use prebuilt images containing dependencies until a separately
controlled package proxy exists. Other administrator-installed network policies
are additive and must not grant execution pods broader access. Enforcement
requires Cilium to apply the rendered policies; Helm rendering alone does not
prove the live network boundary.

No tool can merge PRs, delete remote branches, force push, modify protected base
branches, choose another repository, or supply a provider host. These capabilities
need separately reviewed contracts and permissions. This release secures the Git
write path; it is not a general policy engine for arbitrary shell side effects or
a per-department repository entitlement catalog.

## Validation

Tests exercise real smart-HTTP Git pushes for both provider kinds, immutable
snapshots, changed-remote refusal, retries, fixed PR endpoints, revocation, the
real-workerd Gatekeeper queue/provenance flow, owner-only tool access and policy
rendering. Run the CI checks, then validate with your self-hosted Git service and
actual Cilium/Kata/CSI deployment before enabling production writes.

Restricted observations and Git publication share a workspace lock. An observation
that marks data restricted waits for an earlier captured push to finish before
returning data; once recorded, the flag refuses subsequent pushes. This also
applies to other Gatekeeper pushes, without holding the Durable Object input gate.
Agent Git capabilities use the user minting policy (`agent-git`, resource pattern
`http://agent-git.local/*`), checked again at apply time. Deleting a chat retires
all its Git facets, rejects pending audit entries, clears pending push marks and
removes private artifacts and execution identity keys.

A durable in-flight publication marker survives worker restarts. If a write has
an unknown outcome, restricted observations and chat deletion fail closed until
the owner retries that pending approval to reconcile the immutable remote write.
The action cannot be rejected while its publication outcome remains unresolved.
