# git-mirror

Read-only Git replication from a VPN-connected gateway to external application servers.

The gateway can reach the private Git host **and initiate HTTPS requests to the application servers**. The application servers do **not** need network access to the gateway or private Git host.

> **Authorization required:** Do not use this project to replicate enterprise repositories outside corporate network controls unless your organization explicitly allows it. This repository contains no VPN-bypass functionality or credentials.

## Architecture

1. A client publishes a synchronization request on MQTT, including the latest commit SHA of each locally mirrored branch.
2. The gateway fetches the configured branches from the Git upstream into a bare mirror.
3. The gateway creates a Git bundle, incremental when the client's required base commits are available.
4. The gateway uploads the bundle to that client's dedicated HTTPS endpoint.
5. The client verifies and imports the bundle into a local bare mirror.
6. Applications run normal `git fetch` / `git pull` against the local mirror.

MQTT carries metadata only. Git bundles travel over HTTPS. Git itself handles object integrity and history negotiation inside each bundle.

**Scope (v0.2):** multiple branches per repository, including prefix wildcard patterns such as `release/*`; no push from application servers to the enterprise upstream; no automatic modifications to application working trees; no tag synchronization; full bundle fallback after branch rewrites or when the client has no baseline.

## Requirements

- Node.js 22 or newer and Git CLI on both gateway and clients
- MQTT broker with TLS and scoped ACLs
- Private upstream Git access available on the gateway
- Gateway-initiated HTTPS connectivity to each destination
- Reverse proxy offering a valid TLS certificate for the client's upload path
- Explicit approval to distribute the repositories to the destinations

## Environment configuration\n\nThe gateway and client processes load an untracked `.env` file automatically through `dotenv/config`, from the process working directory. Copy `.env.example` to `.env`, then set `CONFIG_PATH`, `MIRROR_NODE_ID`, MQTT credentials and the applicable upload tokens. On the Windows gateway, use `CONFIG_PATH=config/gateway.json`, `MIRROR_NODE_ID=gateway`, and `STAGING_UPLOAD_TOKEN`, `PRODUCTION_UPLOAD_TOKEN`, `HUB_UPLOAD_TOKEN` as needed. On each Linux client, use `CONFIG_PATH=config/client.json`, a unique `MIRROR_NODE_ID`, and `UPLOAD_TOKEN` matching the gateway's token for that client. Never commit `.env`. Explicitly set process environment variables take precedence over values loaded by dotenv.\n\nWith PM2, start only the relevant application from `ecosystem.config.cjs`; its working directory is the project root. After changes to `.env`, restart that PM2 process. The project intentionally does not log or expose the tokens.\n\n## Setup

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
git -C /srv/apps/myapp merge --ff-only mirror/main\n# For a separate checkout tracking develop, use mirror/develop instead.
```

If the desired behavior is literally `git pull`, configure the application checkout's upstream branch to use the local mirror remote:

```bash
git -C /srv/apps/myapp branch --set-upstream-to=mirror/main main
git -C /srv/apps/myapp pull --ff-only
```

Do not use a force reset during deploy; `--ff-only` prevents silently discarding local commits.

## MQTT topics

```text
git-mirror/v1/request/<clientId>
git-mirror/v1/status/<clientId>
```

Each client may publish **only** its own request topic and subscribe **only** to its own status topic. The gateway subscribes to authorized request topics and publishes statuses. Use TLS and unique broker credentials per node; disable anonymous access and MQTT retained requests.

## Operations

- Each client requests all configured branches at startup and every `syncIntervalSeconds` (default 300).\n- One bare repository stores all branches, so branches share Git objects rather than duplicating clones.
- The gateway runs Git fetch and bundle generation when a request arrives.
- Transfers use HTTP PUT with a per-client bearer token and an unguessable request ID.
- Clients accept transfers only for a currently pending request and an allowed repository.
- Clients run `git bundle verify` before importing the changes.
- A completed sync updates only the local bare mirror, not a working tree.
- Failed syncs are retried at the next interval, not in an unbounded busy loop.
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

## Windows gateway and SSH authentication\n\nOn the Windows VPN gateway, use a POSIX-style path such as `C:/git-mirror/data/myapp.git` in JSON and the existing authorized SSH remote such as `git@github.enterprise.example:team/myapp.git`. Verify access from the same Windows identity used to run PM2:\n\n```powershell\nssh -T git@github.enterprise.example\ngit ls-remote git@github.enterprise.example:team/myapp.git\n```\n\nUse the same Windows account (and its SSH agent, key and known_hosts configuration) for the gateway process. No enterprise SSH key is copied to any client. The legacy `branch` string continues to work as an alternative to the `branches` array. Do not configure both simultaneously. Wildcards support trailing `/*` prefixes, not arbitrary shell globbing.\n\n## Limitations

This is an initial implementation, not a proven production deployment. Test with a non-sensitive repository before enabling any enterprise sync. Upstream credentials, TLS termination, ACLs, external routing, reverse-proxy size limits, and permissions are deployment-specific. Large repositories currently use local temporary bundle files. No automated workspace deploy hook, tag mirroring, branch pruning, resumable upload or central UI is included.
