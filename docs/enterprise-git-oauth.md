# Self-hosted Git OAuth

Aether supports per-user connections to **GitLab Self-Managed (Enterprise)** and
**GitHub Enterprise Server**. An administrator approves each HTTPS origin and
registers an OAuth application on that instance. No public GitHub/GitLab endpoint
is required; public service URLs are rejected. The API URL, if overridden, must
remain on the same origin. Provider configuration is deployment configuration,
not a URL supplied by the user or model.

Aether's OIDC sign-in remains independent of Git authorization. Linking Git does
not change the logged-in user, department memberships or trusted POSIX identity.
Git permissions come from the linked user's own account on the selected instance.

## Register the applications

Use the exact callback **`https://aether.internal.example/git/callback`**, replacing
the origin with your deployment's `oidc.publicUrl`. Register a separate application
and credentials on each instance. Browsers must trust both services' certificates.

| Provider | Registration | Requested scopes | Token lifecycle |
| --- | --- | --- | --- |
| GitLab Self-Managed | Confidential OAuth application; enable `read_user` and `read_repository` | `read_user read_repository` | Authorization code with S256 PKCE; refresh tokens rotate before an Agent launch when near expiry |
| GitHub Enterprise Server | OAuth App with the exact callback URL | `repo read:user` | Confidential authorization-code flow with client secret and state; standard GHES OAuth App tokens |

GitHub Enterprise Server's OAuth App flow does not support PKCE. Its `repo` scope
includes read/write access and is broader than Aether's current read-only broker.
The token stays private, and runners can only use upload-pack for the selected
repository; push and arbitrary repository URLs remain blocked. Fine-grained
GitHub App installation permissions are a future integration, not this OAuth App
flow. Organizations may require administrator approval of the OAuth application.

Provider references:
[GitLab OAuth API](https://docs.gitlab.com/api/oauth2/),
[GHES authorization flow](https://docs.github.com/en/enterprise-server@3.22/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[GHES OAuth scopes](https://docs.github.com/en/enterprise-server@3.19/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[GHES token revocation](https://docs.github.com/en/enterprise-server@3.21/rest/apps/oauth-applications).

## Configure Helm

Keep client secrets out of Helm values. Create an existing Secret containing a
JSON map keyed by provider ID, for example a protected `clients.json` file:

```json
{
  "gitlab-enterprise": {"clientId": "GITLAB_APPLICATION_ID", "clientSecret": "GITLAB_CLIENT_SECRET"},
  "github-enterprise": {"clientId": "GHES_CLIENT_ID", "clientSecret": "GHES_CLIENT_SECRET"}
}
```

```sh
kubectl -n aether-system create secret generic aether-git-oauth --from-file=clients.json
```

Merge into your existing OIDC/department values:

```yaml
oidc:
  publicUrl: https://aether.internal.example
execution:
  enabled: true
  git:
    providers:
      - id: gitlab-enterprise
        label: GitLab Enterprise
        kind: gitlab
        url: https://gitlab.internal.example
      - id: github-enterprise
        label: GitHub Enterprise Server
        kind: github
        url: https://github.internal.example
    oauth:
      existingSecret: aether-git-oauth
      key: clients.json
    ca:
      secretName: internal-git-ca
      key: ca.crt
networkPolicy:
  extraEgress:
    - toFQDNs:
        - matchName: gitlab.internal.example
        - matchName: github.internal.example
      toPorts:
        - ports: [{port: '443', protocol: TCP}]
```

Merge these egress rules with the existing OIDC/model/storage rules. GitHub
Enterprise defaults to `/api/v3/`, GitLab to `/api/v4/` on the configured origin.
The controller mounts the OAuth Secret and optional CA read-only; other containers
and runners receive neither. TLS verification stays enabled. Disconnected
installations use internal origins, mirrored images and their internal CA.

Rebuild the execution-manager and Aether application images for this change, then
upgrade the chart. Restart the manager after changing OAuth client credentials or
provider configuration: it reads them at startup. Existing Secrets are managed by
the operator; the chart does not create them or grant the controller Secret API
read permission.

Standalone manager equivalents are `AETHER_EXECUTION_GIT_PROVIDERS` (provider JSON),
`AETHER_EXECUTION_PUBLIC_URL`, `AETHER_EXECUTION_GIT_OAUTH_FILE` (the JSON file path),
and optional `NODE_EXTRA_CA_CERTS`.

## User flow and private state

Choose **Agent → Connect Git**, select an internal service and click **Connect**.
Authorize your own account in the popup; the parent chat and draft remain open.
After authorization, choose the linked account and enter `group/project` or
`owner/repository`. Repositories still use the selected service's default branch;
repository/branch discovery and explicit branch selection are separate work.

The callback requires the same signed-in Aether user and the initiating popup's
browser state. Server state is random, user-bound, one-use and expires in ten
minutes; at most eight pending links and sixteen linked accounts are allowed per
user. PKCE verifiers stay in private user storage. Browser channels convey only a
connection identifier, not an access token, refresh token or client secret. The
popup cannot navigate its parent. Codes are removed from the callback URL before
the exchange. Failed or canceled flows can be started again.

Access and refresh tokens stay in private user state. A controller restart does
not discard linked grants. Refresh occurs before launch/resume; the controller
does not keep a provider token refreshing indefinitely while a user is inactive.
Refresh and disconnect serialize per account. Disconnect revokes repository leases
and the provider token before deleting the credential copy; a provider outage
leaves the copy available for a retry. A lost response during provider token
rotation can require reconnecting. Protect user-state backups as credential
backups. Removing Aether state alone is not provider-side revocation.

For a configured service without OAuth credentials, the previous personal-token
connection remains available. Personal tokens are removed from Aether on
disconnect; revoke them at the provider separately. OAuth connections use
provider-side revocation automatically.

Protocol fixtures cover both providers, and real workerd tests cover user
isolation, replay, refresh, disconnect and native RPC. Tests do not replace a live
connection against your licensed GitLab/GHES instance and internal TLS chain.
