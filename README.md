# git-mirror

**Planned dynamic mirroring and client administration:** [Technical design (EN-US)](docs/DYNAMIC-MIRROR-ARCHITECTURE.md). This document specifies the approved organization-wide repository access policy and per-client single-token UI; those features are not yet implemented.

Read-only Git replication from a VPN-connected gateway to external application servers.

The gateway can reach the private Git host **and initiate HTTPS requests to the application servers**. The application servers do **not** need network access to the gateway or private Git host.

> **Authorization required:** Do not use this project to replicate enterprise repositories outside corporate network controls unless your organization explicitly allows it. This repository contains no VPN-bypass functionality or credentials.

## Architecture

1. A client publishes a synchronization request on MQTT, including the latest commit SHA of each locally mirrored branch.
2. The gateway fetches the configured branches from the Git upstream into a bare mirror.
3. The gateway creates a Git bundle, incremental when the client's required base commits are available.
4. The gateway uploads the bundle to that client's dedicated HTTPS endpoint.
5. The client verifies and imports the bundle into a local bare mirror.
6. Applications can fetch or pull from the local mirror when their histories permit; checkouts with local commits can use the separately validated deploy command.

MQTT carries metadata only. Git bundles travel over HTTPS. Git itself handles object integrity and history negotiation inside each bundle.

**Scope (v0.3):** multiple branches per repository, including prefix wildcard patterns such as `release/*`; no push from application servers to the enterprise upstream; no unattended modifications to application working trees; no tag synchronization; full bundle fallback after branch rewrites or when the client has no baseline.

## Requirements

- Node.js 22 or newer and Git CLI on both gateway and clients
- MQTT broker with TLS and scoped ACLs
- Private upstream Git access available on the gateway
- Gateway-initiated HTTPS connectivity to each destination
- Reverse proxy offering a valid TLS certificate for the client's upload path
- Explicit approval to distribute the repositories to the destinations

## Environment configuration

The gateway and client processes load an untracked `.env` file automatically through `dotenv/config`, from the process working directory. Copy `.env.example` to `.env`, then set `CONFIG_PATH`, `MIRROR_NODE_ID`, MQTT credentials and the applicable upload tokens. On the Windows gateway, use `CONFIG_PATH=config/gateway.json`, `MIRROR_NODE_ID=gateway`, and `STAGING_UPLOAD_TOKEN`, `PRODUCTION_UPLOAD_TOKEN`, `HUB_UPLOAD_TOKEN` as needed. On each Linux client, use `CONFIG_PATH=config/client.json`, a unique `MIRROR_NODE_ID`, and `UPLOAD_TOKEN` matching the gateway's token for that client. Never commit `.env`. Explicitly set process environment variables take precedence over values loaded by dotenv.

With PM2, start only the relevant application from `ecosystem.config.cjs`; its working directory is the project root. After changes to `.env`, restart that PM2 process. The project intentionally does not log or expose the tokens.

## Setup

### Gateway (VPN-connected)

```bash
npm install             # a lockfile has not been committed yet
cp config/gateway.example.json config/gateway.json
```

Edit the gateway config to provide the upstream repository URL, branch patterns, SSH URL, local mirror path, destination clients, and their HTTPS endpoints.

Create `.env` from `.env.example` and set the environment values below (shown as shell exports only for reference):

```bash
export CONFIG_PATH="$PWD/config/gateway.json"
export MQTT_URL="mqtts://broker.example.com:8883"
export MQTT_USERNAME="git-mirror-gateway"
export MQTT_PASSWORD="..."
export MIRROR_NODE_ID="gateway"
export SERVER_A_UPLOAD_TOKEN="a-long-random-per-client-secret"
npm run start:gateway
```

Use an upstream credential manager, SSH deploy key, or a short-lived organization-approved credential. Never embed tokens in repository URLs or example files.

### Client (application server)

```bash
npm ci
cp config/client.example.json config/client.json
```

Edit `clientId`, repository IDs, allowed branches, mirror paths, listening port and sync interval. A client may request only the intersection of its configured branches and the gateway's allowlist. Set the environment:

```bash
export CONFIG_PATH="$PWD/config/client.json"
export MQTT_URL="mqtts://broker.example.com:8883"
export MQTT_USERNAME="git-mirror-server-a"
export MQTT_PASSWORD="..."
export MIRROR_NODE_ID="server-a"
export UPLOAD_TOKEN="the-same-long-random-per-client-secret"
npm run start:client
```

The client listens on `127.0.0.1:8787` by default. Put a TLS reverse proxy in front of it, publishing **only** the `/git-mirror/v1/upload/` route with the prefix removed before forwarding to the local Node.js app. Restrict ingress to the gateway egress IP when possible. The gateway config's `uploadBaseUrl` must end in `/git-mirror/`, such that `PUT /git-mirror/v1/upload/<requestId>` maps to `PUT /v1/upload/<requestId>` in Node.js.

For example, an NGINX location inside an existing HTTPS server:

```nginx
location /git-mirror/ {
    client_max_body_size 2g;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_pass http://127.0.0.1:8787/;
}
```

Use server-level TLS, access logs, request-size limits and firewall restrictions. Do not publish the client HTTP port directly.

### Using the local mirror

After the first successful synchronization, each received branch is present in the local bare mirror. The client does not automatically delete a branch that disappears from upstream. This avoids unexpected branch loss. To use one of the branches:

```bash
# Existing application checkout; retain the corporate origin for reference.
git -C /srv/apps/myapp remote add mirror /var/lib/git-mirror/replicas/myapp.git
git -C /srv/apps/myapp fetch mirror
git -C /srv/apps/myapp merge --ff-only mirror/main
# For a separate checkout tracking develop, use mirror/develop instead.
```

If the desired behavior is literally `git pull`, configure the application checkout's upstream branch to use the local mirror remote:

```bash
git -C /srv/apps/myapp branch --set-upstream-to=mirror/main main
git -C /srv/apps/myapp pull --ff-only
```

Do not use a force reset during deploy; `--ff-only` prevents silently discarding local commits.


### Validated deployment for application branches with local commits

An application checkout can contain server-specific commits that are not in the corporate
mirror. In that case, `git pull --ff-only` cannot reliably apply subsequent updates.
The **optional manual deploy command** builds and tests a merge in an isolated Git
worktree, then fast-forwards the active application branch to the validated result.
The MQTT client itself still updates only the bare replica.

Create a local deploy config on the Linux application server:

```bash
cd /ibv-apps/git-mirror
cp config/deploy.example.json config/deploy.json
```

The deploy config now accepts multiple named entries in `repositories`.
Each entry has its own `id`, checkout, bare mirror path, branch and independent
prepare/test commands. The example contains the existing `portal` staging repo;
add other deployed repositories as additional objects. No gateway/client change
is required for this local checkout selection, but each bare replica must already
be configured in the regular MQTT mirroring settings.

```json
{
  "repositories": [
    {
      "id": "portal",
      "checkoutPath": "/ibv-apps/portal",
      "mirrorPath": "/ibv-apps/git-mirror/replicas/portal.git",
      "branch": "staging",
      "prepareCommands": [["npm", "ci"]],
      "testCommands": [["npm", "test"]]
    },
    {
      "id": "another-app",
      "checkoutPath": "/ibv-apps/another-app",
      "mirrorPath": "/ibv-apps/git-mirror/replicas/another-app.git",
      "branch": "staging",
      "prepareCommands": [["npm", "ci"]],
      "testCommands": [["npm", "test"]]
    }
  ]
}
```

Select one repo for validation/application, or process all configured repositories
**sequentially**. An individual failure stops that repository's deploy and does
not stop other entries from being processed; overall exit status is nonzero if
any entry fails.

```bash
npm run deploy -- --repo portal
npm run deploy -- --repo portal --apply
npm run deploy -- --all
npm run deploy -- --all --apply
```

For backward compatibility, a legacy single-repository root config remains
supported as `default`. When just one repository exists, `npm run deploy`
continues to work without `--repo`. With multiple repositories, explicitly
pass `--repo` or `--all`. `prepareCommands` and `testCommands` are argv arrays (no shell), run
**inside the temporary candidate worktree**. For the portal example,
`npm ci` prepares isolated dependencies and `npm test` runs its Jest suite.
The deploy command does not start or restart PM2 applications.

```bash
npm run deploy -- --repo portal          # validate only; no live checkout changes
npm run deploy -- --repo portal --apply  # validate, then update portal
```

Safety behavior:

- Requires the expected branch checked out and a clean tracked/untracked working tree.
  Ignored files (for example runtime data or dependencies) are not touched.
- Fetches the configured branch from the **local bare mirror path** only; verifies
  that the checkout's `mirror` remote points to the same path.
- Creates a detached candidate worktree at the current application HEAD, merges the
  mirrored branch there, and runs the configured preparation and test commands.
- On conflicts or failed tests, stops without updating the live application checkout.
  Resolve the conflict intentionally on the application branch and retry.
- On success with `--apply`, records the old HEAD in
  `refs/git-mirror-backups/<branch>/<timestamp>` and fast-forwards the active
  checkout to the tested candidate. The operation creates a local merge commit when
  required, but **does not push upstream or modify the bare mirror**.
- If `mirror/staging` is already an ancestor of the application branch, reports
  `deploy.unchanged`.
- Never discards application commits, performs a force reset, or reapplies a stash.

This is **validated merge deployment**, not a guarantee of conflict-free automatic
deployment. New changes touching the same customizations can still conflict; stop and
review rather than taking one side automatically. The temporary worktree has no ignored
runtime assets or untracked secrets from the live checkout; use tests that can run in
this isolated environment. Before any production use, validate the complete application
and arrange process restarts or service switching separately. Do not run concurrently
with other checkout mutations or deployments.


## Dynamic organization-scoped mirroring (opt-in preview)

The gateway and client now support adding repositories through the client administration UI.
**Deploy from the UI is not implemented.** The existing `npm run deploy` command remains
manual. This feature has unit tests, but has not been end-to-end validated against the
enterprise VPN, broker, NGINX and deployed clients; enable it on staging first.

### Gateway setup (Windows, update gateway first)

Keep the current `clients` registry with client IDs, HTTPS upload endpoints and
`tokenEnv` references. This registry is required for message delivery; **do not**
configure per-client repository restrictions for dynamic repositories.

Extend the existing `config/gateway.json` with:

```json
{
  "github": {
    "sshHost": "github.ibm.com",
    "allowedOrganizations": ["IBV-IBM"]
  },
  "dynamicRepositories": {
    "enabled": true,
    "cacheDirectory": "C:/ibv-apps/git-mirror/source"
  }
}
```

Merge these keys into your current JSON rather than replacing its MQTT and client settings.
Keep existing `repositories` for legacy subscriptions during migration.
The gateway constructs `git@github.ibm.com:ORG/REPO.git` itself; it never accepts
arbitrary remote URLs from clients. Every registered client may request any repository
under the organizations listed above (including private repositories that the gateway
SSH identity can access). This is an intentionally broad authorization grant.
Obtain organization security approval before enabling it.

### Client setup (Linux, after gateway deployment)

Set `ADMIN_TOKEN` in the client's `.env` to a random secret of at least 16 characters.
Keep the separate existing `UPLOAD_TOKEN`. Add a trusted writable local storage root
in the client's `config/client.json`:

```json
{
  "mirrorRoot": "/ibv-apps/git-mirror/replicas"
}
```

Merge this key into the existing JSON. Existing subscriptions remain unchanged.
The UI derives paths beneath `mirrorRoot` for new subscriptions and stores a
canonical `upstream` value such as `IBV-IBM/portal`. Config is saved atomically
to `CONFIG_PATH`, and added/removed/updated subscriptions take effect in memory
without restarting the client. Do not expose the upload token to the browser.

Restart the existing PM2 processes after pulling the updated code and editing
environment/configuration:

```bash
pm2 restart github-gateway
# On each Linux client:
pm2 restart github-client
```

Use the real PM2 process names installed on each machine if they differ.

### HTTPS / NGINX

Expose only these paths on each client's HTTPS virtual host:

```nginx
location /git-mirror/admin/ {
    proxy_pass http://127.0.0.1:8787/admin/;
}
location /git-mirror/v1/admin/ {
    client_max_body_size 64k;
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

The UI is then served at `https://YOUR-CLIENT-HOST/git-mirror/admin/`.
The page itself contains no credentials; administrative API requests require
`Authorization: Bearer ADMIN_TOKEN`. The token is kept only in the current browser
page's memory and must be re-entered after refresh. HTTPS is mandatory outside loopback.
Do not publish `/v1/sync/:repoId`, `/health` or the Node HTTP port publicly.

### Current UI/API functionality

- Status, MQTT connectivity, pending count and a bounded list of recent client events
- View local repositories and branch subscriptions
- Add an `organization/repository` subscription with a safe locally derived bare path
- Edit branch patterns on an existing subscription
- Remove a subscription without deleting its Git data
- Request immediate synchronization for a subscribed repository
- Request branch discovery for a known `organization/repository` and inspect the result in activity

Discovery is asynchronous over MQTT. It requires a gateway with dynamic mirroring
enabled and does not provide an organization-wide GitHub repository catalog.
Gateway SSH access must be configured for the organization and repository.

The admin API is `GET /v1/admin/status`, `GET /v1/admin/repositories`,
`GET /v1/admin/activity`, `POST /v1/admin/discover`,
`POST /v1/admin/repositories`, `PATCH /v1/admin/repositories/:id`,
`DELETE /v1/admin/repositories/:id`, and
`POST /v1/admin/repositories/:id/sync`.

**Important:** The UI does not yet support deployment initiation, editing global
client settings, or server-side enterprise repository listing by organization.
Do not switch existing staged applications to automatic deployment. Existing
manual deployment commands continue to work.


## MQTT topics

```text
git-mirror/v1/request/<clientId>
git-mirror/v1/status/<clientId>
```

Each client may publish **only** its own request topic and subscribe **only** to its own status topic. The gateway subscribes to authorized request topics and publishes statuses. Use TLS and unique broker credentials per node; disable anonymous access and MQTT retained requests.

## Resilient request lifecycle

Each client tracks outstanding requests by request ID. A watchdog runs every 10 seconds.
If a request has no terminal response after `requestTimeoutSeconds` (default 180),
it is marked `request.timed_out`, removed from the pending set, and a fresh request is published.
After a broker reconnection the client re-queues pending requests that are not actively uploading.
In manual mode, a reported upstream failure does not trigger another fetch. Interrupted requests can be recovered a bounded number of times. In opt-in interval mode, failures respect `retryDelaySeconds` (default 30) and successful requests respect `syncIntervalSeconds` (default 300).
Incoming late responses for previous request IDs are ignored and logged as `status.stale`.
Active uploads are not expired by the watchdog.

Example optional settings in `config/client.json`:

```json
{
  "requestTimeoutSeconds": 180,
  "retryDelaySeconds": 30,
  "syncMode": "manual",
  "maxRecoveryRetries": 2
}
```

Run a manual request from the client project directory without restarting PM2:

```bash
npm run sync -- portal
```

This sends an authenticated request to the client's local Node.js API. It returns
HTTP 202 when the request is queued, HTTP 409 when one is already pending and HTTP 503
when MQTT is unavailable; it does not wait for bundle delivery.
The control endpoint `POST /v1/sync/<repoId>` requires the client's UPLOAD_TOKEN;
restrict external reverse proxy paths to uploads only (e.g. `location /git-mirror/v1/upload/`)
and do not publish the manual-sync endpoint.

Gateway log events include `sync.requested`, `sync.started`, `sync.upstream`,
`sync.completed` and `sync.failed`, with a request ID for correlation.

## Operations

- Clients use on-demand synchronization by default. Scheduled updates require an explicit `syncMode: "interval"` setting.
- One bare repository stores all branches, so branches share Git objects rather than duplicating clones.
- The gateway runs Git fetch and bundle generation when a request arrives.
- Transfers use HTTP PUT with a per-client bearer token and an unguessable request ID.
- Clients accept transfers only for a currently pending request and an allowed repository.
- Clients run `git bundle verify` before importing the changes.
- A completed sync updates only the local bare mirror, not a working tree.
- Failed syncs use a bounded retry delay; pending requests are monitored for timeouts.
- PM2 process examples are in `ecosystem.config.cjs`.

### Diagnostics

```bash
pm2 logs git-mirror-gateway
pm2 logs git-mirror-client
curl -fsS http://127.0.0.1:8787/health
git -C /var/lib/git-mirror/replicas/myapp.git rev-parse refs/heads/main
```

Health checks do not imply successful upstream connectivity. Review structured JSON logs for `sync.completed`, `bundle.applied`, and errors.

## Security notes

- Replicate only repositories authorized for storage on each destination.
- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`; validate upstream and destination certificates.
- Protect the MQTT broker with per-client ACLs and TLS.
- Supply secrets via protected environment variables, not tracked config files.
- Allowlist destination HTTPS URLs on the gateway. Do not trust destination addresses from MQTT messages.
- Authenticate HTTP uploads and enforce size limits.
- Corporate policy, DLP and enterprise source-code handling requirements take precedence over technical reachability.

## Windows gateway and SSH authentication

On the Windows VPN gateway, use a POSIX-style path such as `C:/git-mirror/data/myapp.git` in JSON and the existing authorized SSH remote such as `git@github.enterprise.example:team/myapp.git`. Verify access from the same Windows identity used to run PM2:

```powershell\nssh -T git@github.enterprise.example\ngit ls-remote git@github.enterprise.example:team/myapp.git\n```

Use the same Windows account (and its SSH agent, key and known_hosts configuration) for the gateway process. No enterprise SSH key is copied to any client. The legacy `branch` string continues to work as an alternative to the `branches` array. Do not configure both simultaneously. Wildcards support trailing `/*` prefixes, not arbitrary shell globbing.

## Limitations

This is an initial implementation, not a proven production deployment. Test with a non-sensitive repository before enabling any enterprise sync. Upstream credentials, TLS termination, ACLs, external routing, reverse-proxy size limits, and permissions are deployment-specific. Large repositories currently use local temporary bundle files. No unattended workspace deploy hook, tag mirroring, branch pruning, resumable upload or central UI is included.


### Gateway restart recovery

The gateway publishes a retained MQTT presence message at
`git-mirror/v1/gateway/presence` with a per-process `bootId`, **after**
subscribing to request topics. Clients subscribe to this message and requeue
unresolved sync requests when the `bootId` changes. A reconnect to the broker
by the same gateway process retains the same identity and does not cause
unnecessary re-synchronization. Active bundle uploads are not interrupted.

Clients also expire unanswered requests using `requestTimeoutSeconds`
(default: 180 seconds; minimum: 30 seconds), checked every 10 seconds.
In manual mode, an interrupted request is retried up to `maxRecoveryRetries` times
(default: 2) without restarting the client. Subsequent attempts require a
new manual synchronization. In opt-in interval mode, scheduled retries continue. Retries use a new request ID;
late status messages for expired requests are ignored. A client MQTT reconnect
also requeues outstanding non-uploading requests.

For a quicker fallback when the gateway is unavailable, set
`requestTimeoutSeconds` in `config/client.json` to e.g. `60`. This can
produce a duplicate request when a slow gateway is still processing, so
prefer the default for large repositories. Uploads in progress are allowed
to finish rather than being canceled by restart recovery.


## On-demand upstream updates (default)

The client now defaults to `syncMode: "manual"`. Merely starting a client,
restarting the gateway, reconnecting to MQTT, or waiting for a timer does **not**
create a fresh upstream SSH fetch. The gateway runs `git remote update --prune`
only when a client has explicitly requested synchronization or branch discovery.
The gateway itself does not run an upstream polling loop.

In manual mode, upstream updates are initiated by:

- Clicking **Sync now** in Client Admin, or using the local authenticated sync API/CLI
- Adding a repository in Client Admin (initial synchronization)
- Clicking **Discover branches** (an explicit upstream lookup)
- Automatically recovering an interrupted explicit sync, bounded by `maxRecoveryRetries`

A confirmed error (for example, SSH connection refused) ends that manual
request and does **not** trigger repeated upstream retries.

To enable scheduled synchronization on a particular client, opt in with:

```json
{
  "syncMode": "interval",
  "syncIntervalSeconds": 300
}
```

Merge these properties into `config/client.json` and restart `github-client`.
Leaving out `syncMode` is equivalent to `"manual"`. Settings are
per-client. Manual mode does not prevent serving existing local Git mirrors or
updating checkouts from those mirrors.

**Deployment:** update the gateway and all clients together, then verify a
manual synchronization from Client Admin. Until the update is deployed,
older clients may continue sending scheduled requests.

## Emergency offline mirror refresh (no gateway required)

A client administrator can upload a **full Git bundle** directly to that
client's local bare mirror. This requires only the client HTTPS Admin UI and
its `ADMIN_TOKEN`; MQTT, gateway access and upstream SSH are not required.

From the development computer's **committed** Git checkout:

```powershell
git status
git switch main
git bundle create myrepo-main.bundle refs/heads/main
git bundle verify myrepo-main.bundle
```

Export the exact local branch you want to import. For other branches, replace
`main` accordingly. A bundle is one binary file containing Git objects and
refs, not a ZIP of the working directory. Uncommitted changes, ignored files
and Git LFS binaries are **not** included. Ensure the branch contains the
latest approved commits before exporting.

In the Client Admin UI, open the appropriate repository card and select
**Import offline Git bundle**. Choose the same branch, select the `.bundle`
file and click **Upload and import bundle**. The API endpoint is
`PUT /v1/admin/repositories/:id/bundle` with
`Authorization: Bearer ADMIN_TOKEN`, `Content-Type: application/octet-stream`
and `X-Mirror-Branch: main`. Request body is the raw bundle bytes
(no multipart form or base64 conversion).

The client streams the upload to a temporary file, checks the configured
`maxBundleBytes` limit, runs `git bundle verify`, requires exactly the selected
branch reference, and fetches it into the local bare mirror with an **atomic,
non-forced update**. The operation never modifies an application working tree.
An existing branch must fast-forward; a divergent branch is rejected rather
than overwritten. Inspect divergence and resolve it explicitly before retrying.

If an unanswered Gateway request exists for the repository, the offline import
supersedes it and late Gateway uploads for the old request ID are rejected.
A currently active bundle transfer cannot be interrupted by the import.
After a successful offline import, run `git fetch mirror` and
`git pull --ff-only` **from the application checkout**, if it is safe to
fast-forward. No application deployment is triggered automatically.

### Reverse-proxy upload limits

The default IIS request body limit may be much smaller than a Git bundle.
For an IIS site that **only** hosts this Client Admin and uses ARR, configure
a carefully scoped `requestFiltering` maximum, for example 512 MiB:

```xml
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="536870912" />
    </requestFiltering>
  </security>
</system.webServer>
```

Apply the setting to the correct IIS site/location rather than unrelated
applications. The proxy/edge service in front of IIS may enforce an even
smaller upload limit; the smallest limit applies. Increase limits only to
the size needed, keep HTTPS and the token requirement, and restrict access
to the Admin UI according to your organization's policies. For NGINX,
set `client_max_body_size` on the corresponding admin upload location.
The Node client also enforces `maxBundleBytes` (2 GiB by default).

For large bundles that exceed an edge-provider upload limit, prefer an
authorized direct HTTPS route or a controlled file transfer followed by
a local `git bundle verify` and `git fetch`; do not disable authentication
or corporate network controls to bypass upload limits.
