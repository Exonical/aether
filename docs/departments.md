# One application, multiple departments

Aether serves one shared frontend and workspace runtime. Users keep their existing private workspaces, agent/Gadget sandboxes, accounts and sessions. Departments provide a persistent organizational directory and scoped membership administration inside that application. Creating a department does not start another pod or deploy another frontend.

## Enable and administer

Build an OIDC-enabled workspace image, configure a single shared IdP client, and set `AETHER_DEPARTMENTS=true` on the runtime (Helm: `departments.enabled: true`). Set `AETHER_ADMINS` to the exact verified email addresses of global administrators. Departments are disabled by default and require OIDC. Sign in at the normal workspace, then visit **`/departments`** on the same hostname.

Global admins create departments using permanent slug IDs, rename them, add members, and appoint/demote department administrators. Department admins can list and add/remove ordinary manual members only within their own department. They cannot create departments, manage another department, appoint admins, or receive the global Workshop AdminApi. Ordinary members see only their own department names, not member directories. A user may belong to multiple departments.

Changing membership takes effect on the next directory operation even on an already-signed-in session. Directory calls authenticate the same opaque Aether session against durable OIDC expiry/revocation state. IdP logout makes that session unusable for department operations too. Browser cookie and exact public Origin checks cover directory API requests. Client-provided email, groups and administrator flags never establish authority.

Membership alone does not grant workspace access. Workspace owners still grant explicit collaborator/link capabilities. With departments enabled, the owner and recipient must share at least one current department before a share link can be redeemed or a non-owner can open that workspace. Direct collaborator invitations use the same check. Global administrators have no bypass. Users with no common department are denied, including users who previously redeemed a link; the membership check runs on every subsequent open. The installation's native object namespace separately isolates links between different application installations. Deployment-wide Context public collections, model configuration and other global settings remain shared. Department model policies, quotas/usage accounting, automatic group-based workspace grants are not implemented by this directory. Department membership is not a classification label: public content and deployment-wide resources remain shared. Department admins manage memberships; they do not administer models, credentials or the application. Membership edits advance a durable application-wide access version. Authenticated WebSocket messages and outgoing subscriptions check that version before dispatch/delivery; a stale connection closes and previously acquired workspace capabilities fail. The frontend reconnects using its still-valid session token and reopens workspaces under current department policy. Idle connections close at the next message or watcher renewal (within 60 seconds). This deliberately causes an application-wide reconnect after membership edits. Already dispatched operations and background work are not rolled back. IdP logout separately revokes saved session tokens.

## Optional IdP group mapping

Add to the OIDC adapter Secret/environment:

```text
AETHER_OIDC_DEPARTMENT_CLAIM=groups
AETHER_OIDC_DEPARTMENT_MAPPING={"/Engineering":"engineering","/Finance":"finance"}
```

Create the mapped departments first using a global admin. Configure the IdP to emit that claim as an array of strings in signed ID tokens. Only exact mapped group strings create department memberships; unmapped groups are ignored. Group mapping grants **member** roles only. IdP groups cannot grant either scoped or global administrator access. Global admin authority comes exclusively from `AETHER_ADMINS`.

At each successful sign-in, mapped memberships replace that user's previous IdP-derived memberships. Removed groups disappear at their next login. Manual memberships and administrator assignments remain separately recorded, so an administrator can manage exceptions without IdP synchronization erasing them. Removing a manual membership does not remove an IdP-derived grant; change the group in the IdP. A missing/non-array configured claim rejects login, as does a mapping to a nonexistent department. Restart the adapter after changing its mapping Secret. Disabling mapping clears IdP-derived memberships on subsequent login.

This is a login-time snapshot, not continuous group synchronization. IdP logout revokes sessions but does not erase directory membership; existing mapped membership updates on the next login. It must not be treated as immediate group revocation for future resource policies without adding an appropriate refresh/revocation mechanism.

## API and state

Same-origin clients use `/api/departments` with the existing Bearer session token. GET returns the caller's directory view; POST accepts `create`, `rename`, `delete`, `setMember`, `removeMember`, or `audit`. The normal management page handles these requests and reads the same `authToken` as the Workshop. Global admins can retrieve the latest 200 audit records using `{ "action": "audit" }`. It stores at most 10,000 administrative/synchronization records in the application PVC; export externally for longer retention.

The `Departments` native SQLite Durable Object persists department definitions, memberships and audit records through restart. Limits are 256 departments, 100,000 membership records and 64 mapped departments per login. Back up its state with the whole application DO directory. Deleting a department removes directory memberships, not users or workspaces; mapped IdP groups must be changed too. This directory does not modify upstream user/Gadget object IDs or existing workspace data.

Native workspace tests cover global/scoped/member permissions, cross-department link/invitation denial, same-department redemption, access denial after membership removal, no global-admin sharing bypass, manual grants, signed-group synchronization, nonce/ticket handoff, session forgery/revocation, request Origin, and restart persistence. Adapter tests cover signed mappings and invalid claims. Live Keycloak/Authentik group emission and cluster rollout require configuration validation.
