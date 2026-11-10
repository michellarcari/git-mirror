# Dynamic Repository Mirroring and Client Administration — Technical Design

**Status:** Partially implemented; staging rollout required  
**Language:** English (US)  
**Last updated:** 2026-11-10  
**Scope:** Gateway and client configuration, repository discovery, dynamic branch mirroring, single-token client UI, and validated local deployments.

> This document records the agreed target architecture. It does not claim that proposed endpoints, MQTT message types, or configuration fields are available in the currently deployed software. See [Implementation status](#implementation-status).

## 1. Goals and decisions

- Keep **GitHub Enterprise → Windows gateway → Linux clients** as the only replication direction. No client-to-upstream push or publication API.
- Allow **every authenticated client** to request **any repository and any branch** within the gateway's configured allowed GitHub Enterprise organizations, subject to upstream access.
- **Do not maintain per-client repository or branch allowlists at the gateway.** The organization allowlist is the sole repository-scope restriction.
- Allow clients to choose, save, edit, remove, and synchronize their own requested repositories and branches through a lightweight web UI.
- Provide a **separate administration UI on each client**, rather than a central user-management platform.
- Protect that UI with **one `ADMIN_TOKEN` from the client's `.env`**. No database, user signup, accounts, roles, permissions, or user directory.
- Preserve the existing separate `UPLOAD_TOKEN` for gateway-to-client bundle delivery. Never conflate UI authentication with transfer authentication.
- Continue supporting several repositories and branches per client, including `release/*`-style patterns.
- Keep working-tree deployment opt-in and distinct from bare-mirror synchronization. Preserve local commits, validate candidate merges and tests before changing the live checkout.

### Explicit trust boundary

Under this policy, **every authenticated client is entitled to receive the content of any repository the gateway can access within every allowed organization**, including private repositories. Configuring an organization therefore grants all enrolled clients broad distribution access to its accessible repositories. This is intentional, must be approved by the repository owners/security administrators, and cannot be described as per-repository isolation.

## 2. Existing implementation (baseline)

Currently implemented components in this project:

- Gateway reads `config/gateway.json` with explicitly configured repositories and clients, fetches upstream via Git, and sends Git bundles to client HTTPS endpoints.
- Clients read `config/client.json` with explicitly configured repositories; MQTT carries synchronization requests/status, while Git bundles are uploaded by HTTPS.
- Each client maintains local bare mirrors and supports authenticated manual sync at `POST /v1/sync/:repoId`.
- An optional `src/deploy.js` supports named repositories from `config/deploy.json`, candidate worktree merging, validation, and explicit `--apply`.
- No built-in administration web UI, no dynamic enterprise repository discovery, no organization-scoped dynamic gateway repository resolution, and no runtime configuration management are implemented yet.

The gateway already maintains client IDs, upload URLs, and token environment-variable names. That **transport registry remains necessary**: eliminating per-client repository restrictions does not eliminate the need to identify and authenticate delivery destinations.

## 3. Topology and network direction

```text
Enterprise GitHub (github.ibm.com)
               ^
               | SSH (gateway-initiated; read-only fetch)
               |
Windows Gateway (inside VPN)
  - organization allowlist
  - dynamic repository resolver and shared bare cache
  - client transport registry and delivery tokens
  - MQTT request/status processing
               |
               | MQTT: control plane
               | HTTPS PUT: Git bundle data plane
               v
Linux Client A                 Linux Client B                 Linux Client N
  - MQTT                       - MQTT                        - MQTT
  - local bare mirrors         - local bare mirrors          - local bare mirrors
  - client HTTP API            - client HTTP API             - client HTTP API
  - token-protected UI         - token-protected UI          - token-protected UI
  - optional deployments       - optional deployments        - optional deployments
```

Clients cannot rely on initiating connections to the gateway or Enterprise Git host. All client-to-gateway control messages travel over their existing TLS MQTT broker. The gateway initiates bundle uploads to registered client HTTPS endpoints.

Do not accept client-provided arbitrary SSH/HTTP upstream URLs, upload destinations, filesystem paths, shell arguments, or environment-variable names.

## 4. Gateway configuration (proposed)

Illustrative shape (migration tooling must be implemented before using this schema):

```json
{
  "topicPrefix": "git-mirror/v1",
  "github": {
    "sshHost": "github.ibm.com",
    "allowedOrganizations": ["IBV-IBM"]
  },
  "dynamicRepositories": {
    "enabled": true,
    "cacheDirectory": "C:/ibv-apps/git-mirror/source",
    "maxConcurrentUpstreamOperations": 2
  },
  "clients": [
    {
      "id": "staging",
      "uploadBaseUrl": "https://gh-stg.ibv-ibm.com/git-mirror/",
      "tokenEnv": "STAGING_UPLOAD_TOKEN"
    },
    {
      "id": "production",
      "uploadBaseUrl": "https://gh-prd.ibv-ibm.com/git-mirror/",
      "tokenEnv": "PRODUCTION_UPLOAD_TOKEN"
    }
  ]
}
```

The `clients` entries are **delivery enrollment**, not repository-level access control. All enrolled clients have identical repository scope: the gateway's organization allowlist.

### Repository name and upstream construction

- Clients specify a canonical `organization/repository` identifier, such as `IBV-IBM/portal`. Normalize unambiguous forms and reject malformed input.
- Match `organization` against `allowedOrganizations` using a documented normalization rule (prefer case-insensitive matching while preserving canonical display casing).
- Permit only conservative GitHub owner/repository name characters. Reject path traversal, separators beyond the one owner/repo delimiter, `..`, `.git` suffix tricks, control characters, URL schemes, userinfo, and command flags.
- **Construct the upstream URL on the gateway**, e.g. `git@github.ibm.com:IBV-IBM/portal.git`; never accept an upstream URL supplied by a client.
- Construct the cache path from validated and separately encoded/canonicalized organization/repository segments under `cacheDirectory`. Resolve it and verify containment beneath that root before filesystem operations.
- Treat Enterprise SSH access failures, nonexistent repos, and unauthorized organizations as distinct internally, but avoid leaking sensitive details in public or unauthenticated responses.
- Prevent parallel clones or updates of the same repository using repository-scoped locks. Bound request frequency and concurrent expensive Git operations.

### Discovery semantics

A client can request a known `organization/repository` directly. Optional lookup/discovery may list repositories using an approved GitHub Enterprise API credential held **only by the gateway**; SSH `git ls-remote` alone can verify a known repository and list its refs but is not a general organization repository catalog.

If the gateway has no API credential, the UI still supports typed repository names and branch discovery for known repositories. No new credential is copied to clients.

Branch discovery lists only refs in the requested repository, using `refs/heads/*`. Branch patterns (such as `release/*`) are evaluated against discovered branch names; do not pass untrusted strings as arbitrary refspec syntax.

## 5. Client configuration (proposed)

A client persists only its own subscriptions and local settings, without gateway approval for individual repositories:

```json
{
  "clientId": "staging",
  "topicPrefix": "git-mirror/v1",
  "httpHost": "127.0.0.1",
  "httpPort": 8787,
  "syncIntervalSeconds": 300,
  "repositories": [
    {
      "id": "portal",
      "upstream": "IBV-IBM/portal",
      "branches": ["staging"],
      "mirrorPath": "/ibv-apps/git-mirror/replicas/portal.git"
    }
  ]
}
```

`id` is a stable local identifier for routes, UI selection, and logs. `upstream` is the canonical Enterprise `organization/repository` identifier. Store the requested branches and local mirror path for subsequent synchronization; do not infer enterprise URLs from arbitrary client fields.

Local mirror paths must be absolute, validated, nonoverlapping with other managed repositories, and confined to configured permitted storage roots when remotely editable. The UI may not write to arbitrary filesystem locations. Config writes must be schema-validated and atomic (write temporary file, flush/rename, preserve file permissions); secrets remain in `.env`, not in JSON.

Existing `config/client.json` fields and repository IDs require a documented migration path; do not silently reinterpret an existing repo's ID or overwrite its bare mirror.

## 6. MQTT control protocol (proposed)

Preserve the existing topic family and QoS model; version new payloads so older clients and gateways reject unsupported messages safely.

| Message | Direction | Purpose |
| --- | --- | --- |
| `repository.discover` | Client → Gateway | Validate an organization/repository and retrieve available branch names |
| `repository.discovered` / `repository.failed` | Gateway → Client | Correlated result with sanitized error |
| `sync.request` | Client → Gateway | Request a canonical repository and selected branch names/patterns; include known heads |
| `sync.status` | Gateway → Client | Requested, started, unchanged, completed, or failed |
| `client.heartbeat` (optional) | Client → Gateway | Informational operational telemetry |

These are conceptual message names, **not currently implemented wire messages**. Define precise JSON schemas and protocol versioning before development.

Required request properties: authenticated MQTT client identity/topic, correlation ID, repository ID, canonical upstream slug, branch selection, and known SHA-1/SHA-256 heads as appropriate. The gateway must verify the requested client ID matches the bound MQTT topic; broker ACLs must restrict publication to the client's own topic.

**Important:** Client-supplied slugs and branch names are inputs, not authority. For every request, re-check the organization allowlist and validate refs before running Git or sending data.

### Branch and history behavior

- A new repository is cloned or initialized in the gateway's cache on first request.
- Existing cached mirrors are updated before calculating requested branch heads.
- A missing branch returns a clear error; a wildcard matching zero branches does not silently fetch all refs.
- For incremental bundles, verify every prerequisite base SHA exists and is ancestral; otherwise produce a complete bundle.
- The receiver verifies bundle integrity, branch allowlist, and ref names before updating its local bare repository.
- Preserve existing explicit handling for upstream force-push/history rewrite: a full bundle may replace bare mirror refs, but **must not force-reset an application working tree**.
- Deleting a client subscription does not automatically delete cached Git objects or deployed files. Provide a distinct, confirmed cleanup operation if necessary.

## 7. Client administration web UI

Each client serves its own small, responsive UI via the existing Node HTTP service, behind HTTPS/NGINX.

### Authentication

- Require `ADMIN_TOKEN` in the client's `.env`; fail closed for administrative routes if absent or shorter than 16 characters.
- Use a single token, supplied by the operator; **no user accounts, password database, roles, or access-control UI**.
- Do not reuse `UPLOAD_TOKEN`; retain distinct secrets and separate HTTP routes.
- Submit the token in an HTTPS header (e.g. `Authorization: Bearer <token>`), never in URL parameters.
- Validate tokens using timing-safe comparison, reject missing/invalid tokens, and avoid logging tokens, headers, or request bodies containing secrets.
- Default to in-memory browser token storage for the active page. Do not persist the token in localStorage, query strings, or cookies without a separately specified session design. Refresh requires re-entry.
- Use same-origin requests, narrow CORS policy, security response headers, and rate limits for repeated failures.

### UI sections (single page)

1. **Status:** local client ID, MQTT connection state, gateway request state, last successful sync, next retry, and current errors.
2. **Repositories:** add by `organization/repository`, discover available branches, select exact branches or patterns, see current local mirror SHA and last synchronization.
3. **Actions:** sync one repository, validate a deployment, explicitly apply a validated deployment.
4. **Settings:** edit nonsecret client settings and per-repository configurations; show whether a process restart is required.
5. **Recent activity:** in-memory bounded structured events or a bounded local event log; no separate database.

All UI copy, errors, source code, configuration documentation, and examples should be in **English (US)**.

### Proposed HTTP routes

| Method and route | Function |
| --- | --- |
| `GET /admin/` | Serve static SPA (does not embed secrets) |
| `GET /v1/admin/status` | Return client and MQTT status |
| `GET /v1/admin/repositories` | List client subscriptions and sync state |
| `POST /v1/admin/discover` | Request branch discovery via MQTT |
| `POST /v1/admin/repositories` | Validate and add a client subscription |
| `PATCH /v1/admin/repositories/:id` | Update branches or local settings |
| `DELETE /v1/admin/repositories/:id` | Stop future synchronization; do not delete files by default |
| `POST /v1/admin/repositories/:id/sync` | Request mirror synchronization |
| `POST /v1/admin/repositories/:id/deploy/validate` | Run isolated deployment validation |
| `POST /v1/admin/repositories/:id/deploy/apply` | Explicitly apply after fresh validation |
| `GET /v1/admin/activity` | Return recent nonsecret events |

All `/v1/admin/*` routes require `ADMIN_TOKEN`; the existing `/v1/upload/*` remains protected by `UPLOAD_TOKEN`. The discovery API may return a pending request ID, with results delivered via polling or a same-origin live event stream. Never claim synchronous enterprise discovery when the gateway cannot be reached directly.

Deploy routes should call a validated and fixed command path with repository IDs, not an arbitrary command submitted from the browser. Concurrency controls must prevent overlapping deploys for the same checkout. Never execute remote-provided shell strings.

### Reverse proxy

Only explicitly needed URLs should be exposed:

```nginx
location /git-mirror/admin/ {
    proxy_pass http://127.0.0.1:8787/admin/;
}

location /git-mirror/v1/admin/ {
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:8787/v1/admin/;
}

location /git-mirror/v1/upload/ {
    client_max_body_size 2g;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_pass http://127.0.0.1:8787/v1/upload/;
}
```

Configure HTTPS, request-size/time limits, optional ingress filtering, and normal application security headers at the existing reverse proxy. **Do not expose** `POST /v1/sync/:repoId` or the Node loopback port directly to the public internet.

## 8. Validated deployment and local commit preservation

Bare mirror synchronization and application deployment are separate operations.

- Synchronization updates bare repository refs only.
- Deployment starts from the application's current local branch, merges new mirrored commits in an isolated candidate worktree, prepares dependencies, executes configured tests, and updates the live working tree only with an explicit apply action and after validation.
- Existing local application commits are never pushed to GitHub Enterprise or discarded by force reset.
- Merge conflicts or failed tests stop that deployment without changing the active checkout.
- Maintain local backup refs and logs. An application restart or service switch remains an explicit, separately validated operation.
- Each client may manage multiple named deployment configurations. Repository sync subscriptions and deployment checkouts are related but not necessarily one-to-one.

The current `src/deploy.js` supports manual per-repository and sequential `--all` execution; exposing those actions through the UI requires additional HTTP/API integration and concurrency hardening.

## 9. Required safeguards and failure cases

| Case | Required behavior |
| --- | --- |
| Organization not on allowlist | Reject; do not probe upstream |
| Repo missing or gateway lacks Enterprise access | Report sanitized failure; do not create usable subscription silently |
| Client disconnected from MQTT | Show offline state; queue/retry bounded requests |
| New client requests a permitted private repo | Allow, consistent with organization-wide policy |
| Wildcard pattern matches no branch | Return explicit no-match status |
| SSH/Git clone/update timeout | Record failure; retry with backoff; avoid partial cache publication |
| Incremental bundle prerequisites missing | Fall back to a full bundle |
| Invalid upload token or request ID | Reject upload; do not update refs |
| UI token invalid | Reject API operation; never reveal settings/secrets |
| Deployment working tree dirty or merge conflicts | Refuse to apply; preserve checkout |
| Candidate tests fail | Refuse to apply; show redacted failure details |
| Config write invalid or interrupted | Preserve last valid config; log error |
| Restart-required settings edited | Persist safely and show restart-required status rather than falsely claiming live application |

For runtime configuration edits, explicitly define which fields can be reloaded live and which require process restart. Do not restart the client process mid-upload.

## 10. Migration and rollout plan

1. Implement gateway organization-allowlist validation and canonical repository resolution while keeping legacy static repository configuration functional.
2. Add versioned MQTT repository discovery and dynamic sync request handling; retain the existing bundle delivery mechanism.
3. Extend client subscriptions with canonical upstream slugs and atomic config persistence. Migrate legacy entries without altering existing bare-mirror paths.
4. Add the token-authenticated per-client HTTP admin API and lightweight single-page UI.
5. Integrate manual sync, deployment validation, and explicit apply actions, with operation locks and traceable status.
6. Validate with a non-sensitive authorized repository and two client instances. Test allowed/disallowed organizations, known/unknown branches, legacy config migration, disconnection, interrupted upload, duplicated requests, and failed deployments.
7. Roll out to staging before production. Do not enable automatic application deployments by default.

## 11. Acceptance criteria

- An enrolled client with a valid MQTT identity can request `IBV-IBM/portal` without an explicit `portal` entry in the gateway's per-client configuration.
- Another enrolled client can request the same repo or any other repo in the same allowed organization with identical policy.
- Requests for a repository under an organization not in `allowedOrganizations` are rejected before any upstream Git operation.
- Clients can discover branches for a known repository, choose `main`, `staging`, or `release/*`, and persist the subscription.
- Gateway caches one upstream bare mirror per canonical repository, coordinating concurrent requests.
- The Web UI works through the existing HTTPS reverse proxy, requires only `ADMIN_TOKEN`, and has no users/roles database.
- The upload data plane continues using `UPLOAD_TOKEN`, not `ADMIN_TOKEN`.
- Each client manages its local subscriptions independently, including multiple repositories.
- Bare mirror sync never modifies application working trees; deploy remains explicitly initiated and test-gated.
- No API or automated job can push commits back to GitHub Enterprise.

## 12. Implementation status

| Capability | State as of 2026-11-10 |
| --- | --- |
| Explicit gateway repository mirroring | Implemented |
| MQTT-triggered Git bundle distribution | Implemented |
| Multi-repository client mirrors | Implemented |
| Manual validated multi-repository deploy command | Implemented (requires end-to-end environment validation) |
| Dynamic repository requests restricted by organization | Implemented in code; integration validation pending |
| Enterprise branch discovery via gateway | Implemented via asynchronous MQTT; integration validation pending |
| Gateway dynamic cache keyed by canonical repo | Implemented in code; integration validation pending |
| Runtime subscription configuration API | Add/edit branch selection/remove implemented |
| Client single-token admin UI | Basic UI implemented; integration validation pending |
| Admin-triggered validated deployment API | **Not implemented**; CLI remains available |
| Reverse push/publication to Enterprise | **Explicitly out of scope** |

### Implementation note (2026-11-10)

The initial code for organization-scoped dynamic upstream resolution, MQTT branch discovery, client subscription persistence, and a token-authenticated client page has been committed. The present UI is a minimal administration page, not the entire target feature set. It does not yet expose deployment operations, general settings editing, or an enterprise repository search catalog. The gateway feature is disabled unless `dynamicRepositories.enabled` is true. This implementation has not been verified end-to-end on the Windows/VPN/NGINX deployment and should be rolled out to staging before production. See the README for the currently supported routes and configuration instructions.
