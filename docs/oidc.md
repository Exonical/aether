# Generic OIDC sign-in

Build with `AETHER_TENANT_ID=<tenant>` and `AETHER_OIDC=true` to replace password sign-in with one deployment-owned OIDC provider. Keycloak is the first integration fixture; the runtime uses issuer discovery and standard authorization-code flow, so it has no Keycloak-specific production code. Authentik can use the same configuration.

The trusted Gatekeeper holds the existing pending-login capability. A private Node adapter on `127.0.0.1:9004` exchanges the code and verifies the signed ID token. Only a verified identity reaches Workshop. The adapter retains PKCE verifiers and nonces in memory for five minutes, discards provider tokens after use, and never provides Gadget networking or connector access. Restarting during a pending login requires retrying that login.

## Test locally on Windows

Use Node 24.19+ and Docker Desktop for the Keycloak fixture. These credentials and the development realm are synthetic test data; the fixture permits HTTP and pre-verifies its test users.

From the repository root, initialize the pinned upstream source and dependencies first:

```powershell
git submodule update --init --recursive
npm install --global pnpm@11.28.5
pnpm --dir cloudflare-os install --frozen-lockfile --pm-on-fail=ignore
npm ci --prefix runtime
npm ci --prefix runtime/oidc --ignore-scripts
```

Start Keycloak in the first terminal:

```powershell
$realm = (Resolve-Path runtime/oidc/test/keycloak-realm.json).Path
docker run --rm --name aether-keycloak -p 127.0.0.1:8180:8080 -e KC_HOSTNAME=http://127.0.0.1:8180 -e KC_BOOTSTRAP_ADMIN_USERNAME=aether-admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=fixture-admin-secret --mount "type=bind,source=$realm,target=/opt/keycloak/data/import/aether.json,readonly" quay.io/keycloak/keycloak:26.7.5 start-dev --import-realm
```

Wait until `http://127.0.0.1:8180/realms/aether/.well-known/openid-configuration` returns JSON. Start the private OIDC adapter in a second terminal:

```powershell
$env:AETHER_TENANT_ID = 'acme'
$env:AETHER_PUBLIC_URL = 'http://127.0.0.1:8080'
$env:AETHER_OIDC_ISSUER = 'http://127.0.0.1:8180/realms/aether'
$env:AETHER_OIDC_CLIENT_ID = 'aether'
$env:AETHER_OIDC_CLIENT_SECRET = 'fixture-secret'
$env:AETHER_OIDC_ALLOW_HTTP = 'true'
npm start --prefix runtime/oidc
```

Build and run Workshop in a third terminal:

```powershell
$env:AETHER_TENANT_ID = 'acme'
$env:AETHER_OIDC = 'true'
$env:AETHER_PUBLIC_URL = 'http://127.0.0.1:8080'
$env:AETHER_OIDC_ALLOW_HTTP = 'true'
$env:AETHER_ADMINS = '["admin@example.com"]'
# Docker Desktop needs to reach the callback from its network namespace.
$env:AETHER_BIND_ADDRESS = '0.0.0.0'
npm run workspace:build --prefix runtime
npm run workspace:start --prefix runtime
```

Open **http://127.0.0.1:8080** and choose **Single sign-on**. Use username `admin`, `other`, or `new`; all use password `aether-test-secret`. The `admin@example.com` account receives the admin API through the configured email allowlist. `other` receives an ordinary account. The default deployment allows first-time accounts; close signups in the admin settings to block new users while existing users can still sign in. To restrict admission before first use, configure a signed membership claim or enforce access in the IdP's client policy.

Keep `127.0.0.1` consistent: the fixture redirects are exact and do not include `localhost`. If you change the public address, update the client's redirect URI too. `workspace:build` must finish successfully before startup or tests; it generates `runtime/dist/workspace/manifest.json`.

For automated verification, stop the local Workshop first, then run:

```powershell
# Signed protocol tests plus full native workspace against an ephemeral test issuer.
$env:AETHER_TEST_OIDC_WORKSPACE = 'true'
npm test --prefix runtime/oidc

# Full native workspace against the running real Keycloak browser login form.
$env:AETHER_TEST_KEYCLOAK_ISSUER = 'http://127.0.0.1:8180/realms/aether'
node --test runtime/oidc/test/workspace.test.mjs
```

The TLS certificate fixture requires OpenSSL and is skipped on Windows when it is unavailable; Linux CI runs it. The Keycloak test also triggers an admin logout and checks that idle connections and saved Aether tokens are revoked. It uses the synthetic `aether-admin` bootstrap account. These tests start their own adapter and workspace, use an isolated temporary state directory, and occupy port 8080. The ordinary `npm run workspace:test --prefix runtime` suite expects a build with `AETHER_OIDC=false`; it exercises password accounts instead.

## Production provider configuration

Register a **confidential** client with authorization-code flow, PKCE S256, and this exact redirect URI:

```text
https://acme.aether.example/gatekeeper/oidc/oauth
```

Enable `openid email profile` scopes and emit `email` and boolean `email_verified: true` in the **ID token** only after the provider has verified that address. UserInfo fallback, password grants, implicit grants, refresh-token retention, and provider administration are not implemented.

| Setting | Purpose |
| --- | --- |
| `AETHER_TENANT_ID` | Tenant identity; must match the built artifact |
| `AETHER_PUBLIC_URL` | Public origin, shared by adapter and runtime; no path, query, credentials, or fragment |
| `AETHER_OIDC_ISSUER` | Exact issuer identifier, including any provider-required trailing slash |
| `AETHER_OIDC_CLIENT_ID` | Dedicated client for this tenant |
| `AETHER_OIDC_CLIENT_SECRET` | Confidential client secret; adapter only |
| `AETHER_OIDC_CLIENT_AUTH` | `client_secret_basic` (default) or `client_secret_post` |
| `AETHER_OIDC_SIGNING_ALG` | `RS256` (default), `PS256`, `ES256`, or `EdDSA`; must match provider configuration |
| `AETHER_OIDC_CA_FILE` | Optional internal CA PEM path in adapter; TLS verification remains enabled |
| `AETHER_OIDC_REQUIRED_CLAIM` / `AETHER_OIDC_REQUIRED_VALUE` | Optional ID-token claim matching an exact string or array member; both required together |
| `AETHER_OIDC_PORT` | Private adapter port, default 9004; launcher override must match |
| `AETHER_OIDC_DISPLAY_NAME` | Login button name, default `Single sign-on` in launcher |
| `AETHER_ADMINS` | JSON array of exact verified admin emails; configure explicitly, including `[]` for none |
| `AETHER_OIDC_SESSION_TTL` | Workshop session lifetime at authentication, 60–86400 seconds; launcher default 28800 |
| `AETHER_OIDC_ALLOW_HTTP` | Development-only opt-in; HTTPS is required otherwise |

Issuer, authorization, token, and JWKS endpoints must share one origin. Discovery and token/JWKS requests deny redirects and arbitrary destinations. For Authentik, use its application issuer, such as `https://identity.example/application/o/aether/`, select an asymmetric signing key matching the configured algorithm, and configure a verified-email scope mapping. Do not assume an arbitrary or default `email_verified` mapping proves ownership. See [Authentik provider endpoints](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) and [email verification](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/verify-email-address/).

Register this **back-channel logout URL** on the same OIDC client:

```text
https://acme.aether.example/gatekeeper/oidc/backchannel-logout
```

In Keycloak, disable front-channel logout and configure the back-channel URL with **Backchannel logout session required** enabled. The provider must reach Aether through the Gateway and trust its certificate. IdP-initiated user or admin logout then sends a signed notification to Aether. Authentik must support and be configured to send OIDC back-channel logout notifications; it remains unvalidated here.

The endpoint accepts POST form data with one `logout_token`. It requires the configured issuer, audience, signing algorithm, valid signature, recent `iat` (at most five minutes old, five seconds clock tolerance), nonempty `jti`, and the back-channel logout event. `nonce` is prohibited. If `exp` is included, it is validated; issuers using the original standard without `exp` are supported. Invalid tokens return 400; transient verification or registry failures return 503 so the IdP can retry. Signature verification uses the same restricted JWKS endpoint and private CA settings as sign-in. Replay detection and revocation state persist in tenant-local native SQLite.

With `sid`, matching IdP-session tokens are revoked; a supplied `sub` must also match. Without `sid`, all matching subject sessions are revoked. Unknown sessions return success, and duplicate event notifications are idempotent. A logout received before a delayed login finishes prevents that login from creating a usable session. Fresh login after subject-wide logout needs a newer ID-token issue time; a logged-out session ID remains blocked for the maximum local session lifetime plus login grace.

The local Docker Desktop fixture uses `host.docker.internal:8080` for back-channel callbacks. The public workerd launcher defaults to loopback; `AETHER_BIND_ADDRESS=0.0.0.0` explicitly makes it reachable from Docker Desktop for this test. Keep it loopback for ordinary local use. Only the signed back-channel endpoint accepts an alternate callback Host; API and browser login still require the configured public Host and Origin. CI uses host networking and a loopback callback address instead.

Use a separate client and preferably a separate realm/application policy for each tenant. Claims may restrict admission; they never grant admin access. Do not let users select an issuer, client, tenant, or outbound destination through requests.

## Kubernetes with Cilium Gateway API

The example `deploy/kubernetes/overlays/workspace-oidc` extends the PostgreSQL + S3 + model + Gateway API deployment. It retains the Kata runtime, tenant PVC, non-root containers, read-only root filesystems, and default-deny networking. Replace registry image names, tenant identity, Gateway hostname/TLS secret, and the issuer egress hostname before deployment. There is no Ingress resource.

Build a tenant artifact with `AETHER_OIDC=true` and `AETHER_MODEL_GATEWAY=true`, then build the existing `runtime/Dockerfile.workspace` image. Build the OIDC adapter separately with `runtime/oidc/Dockerfile` and `runtime/oidc` as its context. The overlay selects the PostgreSQL + S3 native configuration; all four storage variants include OIDC when enabled at build time.

Provide the adapter's settings through a tenant-scoped Secret named `aether-oidc`: issuer, client ID, client secret, and optional client-auth, signing-algorithm, membership, or CA settings. For a private CA, mount its PEM read-only into the adapter and set `AETHER_OIDC_CA_FILE` to that path. The runtime receives public origin, display name, admin email list, and session TTL; it never receives the client secret. Raw workerd container startup needs these environment bindings explicitly, while the local Node launcher supplies the documented defaults.

The Gateway must preserve the public Host and WebSocket upgrades. TLS terminates at Cilium; secure browser cookies still use the configured public HTTPS origin. Permit egress only to the user's exact issuer hostname/port, or replace `toFQDNs` with namespace/pod selectors for an in-cluster provider. S3 and model backends remain user-provided and independently scoped. Do not expose port 9004 through a Kubernetes Service or HTTPRoute.

## Identity and session limits

Workshop currently keys accounts by the **exact verified email**. The first successful OIDC identity verification permanently binds that email to `(issuer, subject)` in a tenant-specific native Durable Object. A later issuer/subject mismatch is denied, including after restart. Changing an email creates a different Workshop identity; changing issuers, pairwise subject configuration, or assigning a released email to a new person requires an explicit migration. Existing email-keyed accounts are linked on their first verified OIDC login. Back up the tenant DO state, including these identity bindings, with the existing PVC.

Workshop mints its own opaque session token, not an OIDC access token. New OIDC tokens are registered by hash against issuer, subject, optional IdP session ID, and local expiry. Back-channel logout durably invalidates the matching token registrations, closes idle and active authenticated WebSocket connections, and blocks reuse of derived admin/Gadget capabilities on those RPC connections. Each incoming authenticated WebSocket message checks the registry before dispatch; a registry failure closes the connection. Session expiry also closes registered connections. A saved token cannot reconnect after revocation, including after a runtime restart.

On upgrade from the initial OIDC implementation, old tokens have no registry entry and are rejected; users sign in again. Existing account identity bindings and workspace data remain intact. Back up the new `OidcSessions` namespace with the tenant DO PVC. The registry supports at most 100,000 unexpired token records and 2,048 concurrent authenticated connection watchers per tenant pod, and removes expired state during use and alarms.

Already dispatched operations and background agents are not rolled back or automatically canceled by logout. HTTP batches validate authentication for that batch; an already authorized batch may finish. IdP user disablement only revokes Aether sessions if the provider emits a logout notification. App sign-out still uses the existing browser behavior and does not initiate IdP logout. RP-initiated logout, automatic account migration, and multi-pod ownership remain future work.

The browser login cookie is HttpOnly, SameSite=Lax, and Secure with a `__Host-` prefix on HTTPS. Pending logins are bound to the initiating browser cookie before the popup redirects to the provider. API requests require the public Origin and that cookie. Replays and browser mismatches fail without delivering a session to another pending login.

CI exercises real signed tokens and rejected identities, browser binding, password denial, signup policy, admin/user isolation, persistent identity binding, and workspace restart. A separate real Keycloak container test authenticates through its browser form and performs IdP admin logout. Revocation tests cover signature rejection, session/subject matching, idle connection closure, previously acquired admin/Gadget capabilities, replay, delayed login denial, account isolation, and restart. Authentik and a production cluster rollout still need deployment validation.
