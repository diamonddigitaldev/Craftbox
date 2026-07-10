# Craftbox API Reference

Craftbox exposes a JSON HTTP API for third-party integrations, plus a WebSocket protocol for live console output and state updates, and a small set of unauthenticated public status endpoints.

- **Base URL:** `http://<host>:6464` (or wherever your panel is served)
- **API root:** `/api/v1` — all endpoints below are relative to this root unless stated otherwise
- **Content type:** JSON request and response bodies (`Content-Type: application/json`), except the multipart upload endpoints noted below
- **Versioning:** the API is versioned by URL prefix. `v1` is the current and only version; additive changes (new endpoints, new response fields) may land within `v1` without notice, breaking changes will not.

> ⚠️ All `/api/v1` endpoints require authentication. There are no roles or scopes — any authenticated caller has full control of the panel.


## Authentication

### API keys (recommended for integrations)

Create an API key in the panel (your account menu → API Keys), then send it as a bearer token:

```bash
curl -H "Authorization: Bearer cbx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  http://localhost:6464/api/v1/servers
```

- Keys start with `cbx_` and are shown **once** at creation. Only a SHA-256 hash is stored.
- Bearer requests **do not need CSRF tokens** — calls are stateless, no cookies required.
- Keys have **no scopes and no expiry**; a key grants the same access as the account that created it. Revoke keys you no longer use.
- The key-management endpoints themselves (`/account/apikeys`) reject bearer auth — managing keys requires an interactive login session, so a leaked key cannot mint or delete keys.

Failed authentication returns `401 {"error": "unauthorized"}`.

### Session cookies (browser clients)

The panel frontend authenticates with a session cookie (`POST /login`, rate limited to 5 attempts per 15 minutes per IP). Cookie-based callers must send a CSRF token on every mutating request (POST/DELETE), either as an `X-CSRF-Token` header or a `_csrf` body field. The token is embedded in every panel page. CSRF failures return `403 {"error": "forbidden"}`.

> If you are building an external tool, use an API key. Sessions are `SameSite=Strict`, expire after one hour, and require CSRF handling.


## Conventions

### Error responses

Errors return an appropriate HTTP status with a JSON body:

```json
{ "error": "Server not found." }
```

> **Note:** two error styles exist. Middleware and account endpoints use machine codes (`unauthorized`, `forbidden`, `not_found`, `internal_error`, `setup_required`, `session_required`, `invalid_name`), while the server/backup/plugin/template endpoints return human-readable strings (`"Server not found."`). Match on HTTP status rather than error text where possible.

Common statuses: `400` invalid input, `401` unauthenticated, `403` CSRF failure / session required, `404` not found (unknown `/api/*` paths also return `404 {"error":"not_found"}`), `409` invalid state for the operation (e.g. server running), `500` internal error.

### Asynchronous operations

Long-running operations respond immediately and finish in the background:

- `201 Created` — create, duplicate, import. The response includes the new server record in `provisioning` state.
- `202 Accepted` — backup, restore, jar update, restart-with-backup. The response is `{"success": true, "status": "started"}`.

Completion is signalled over the WebSocket as an `operation` message (see [WebSocket protocol](#websocket-protocol)). Clients that cannot hold a WebSocket open should poll `GET /servers/:id` and watch `state` (`provisioning`/`backing_up`/`restoring`/`updating_jar` → `stopped`, or `crashed` on failure).

### Validation constants

| Field | Rule |
|---|---|
| Server / template name | 1–50 chars, `^[a-zA-Z0-9 _\-]+$` |
| Group name | 1–30 chars, `^[a-zA-Z0-9 _\-]+$` (empty = ungrouped) |
| Port | integer 1024–65535 |
| Memory | integer 512–65536 (MB, any whole value) |
| Version | `latest` or `^\d+\.\d+(\.\d+)?(-\w+)?$` (e.g. `1.21.4`) |
| Server type | `vanilla`, `paper`, `purpur`, `folia`, `fabric`, `forge`, `neoforge`, `custom` |
| `:id` route params | UUID v4 |
| Console command | max 1000 chars |

### Server states

`stopped`, `starting`, `running`, `stopping`, `crashed`, `provisioning`, `backing_up`, `restoring`, `updating_jar`.

Allowed lifecycle actions: **start** from `stopped`/`crashed`; **stop** from `running`/`starting`; **restart** from `running`; **kill** from `running`/`starting`/`stopping`.


## Servers

The server object returned by these endpoints contains the full configuration (name, type, version, port, memory, JVM args, gamemode, difficulty, seed, flags, `group`, timestamps, `state`, `exitCode`, `crashReason`, …). The on-disk `directory` field is stripped from responses.

### Read

| Method | Path | Description |
|---|---|---|
| GET | `/servers` | List all servers with live state. Returns `{"servers": [...]}` |
| GET | `/servers/:id` | One server. Returns `{"server": {...}}` |
| GET | `/server-types` | Available server types. Returns `{"types": [...]}` |
| GET | `/versions?type=<type>` | Minecraft versions for a type. Returns `{"versions": [...], "latest": ...}` |
| GET | `/versions/:type/builds/:version` | Builds for a version. Returns `{"builds": [...]}` |
| GET | `/servers/:id/stats` | Live resource stats + history. Returns `{"stats": {state, uptime, uptimeFormatted, cpuPercent, memoryBytes, memoryAllocatedMb, diskBytes, playerCount, players, ...}, "history": [...]}` |
| GET | `/servers/:id/events?limit=&types=` | Event history, newest first. `limit` max 200 (default 50); `types` is a comma-separated filter. Returns `{"events": [...]}` |

### Create / duplicate / import / delete

| Method | Path | Description |
|---|---|---|
| POST | `/servers` | Create a server. Body: `{name, serverType, version, port, memory, eula, javaArgs?, gamemode?, difficulty?, seed?, group?, customJarUrl?}`. `eula` must be truthy; `customJarUrl` required (http/https) when `serverType` is `custom`. Returns `201 {"success": true, "server": {...}}`; provisioning continues in the background |
| POST | `/servers/:id/duplicate` | Clone a server. Body: `{name, port, includeWorld?, stopFirst?, startAfter?}`. `409` if running and `stopFirst` is not set. Returns `201` |
| POST | `/servers/import` | Import a transfer archive — see [Server transfer](#server-transfer) |
| DELETE | `/servers/:id` | Delete a server and its data. `409` unless `stopped`/`crashed` |

### Lifecycle

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/start` | Start. Returns `{"success": true, "message": ...}`; `400` on invalid state transition |
| POST | `/servers/:id/stop` | Graceful stop |
| POST | `/servers/:id/restart` | Restart. Body: `{backup?: true}` to back up first (returns `202`; `409` if a backup is already in progress) |
| POST | `/servers/:id/kill` | Force-kill the process |
| POST | `/servers/:id/command` | Send a console line. Body: `{command}`. `409` if not running |

### Settings

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/edit` | Edit config. Body: `{name, port, memory, javaArgs?, gamemode?, difficulty?, seed?, group?, version?, customJarUrl?}`. Version changes must be upgrades and require the server stopped (`409` otherwise); may download a new jar. Returns `{"success": true, "server": {...}, "versionChanged": bool, "jarChanged": bool}` |
| POST | `/servers/:id/group` | Assign the dashboard group. Body: `{group}` (empty/null to ungroup). Returns `{"group": ...}` |
| POST | `/servers/:id/autorestart` | Body: `{enabled: bool}`. Returns `{"autoRestart": bool}` |
| POST | `/servers/:id/autostart` | Body: `{enabled: bool}`. Returns `{"autoStart": bool}` |
| POST | `/servers/:id/statuspublic` | Toggle the public status page. Body: `{enabled: bool}` |
| POST | `/servers/:id/advertisedip` | Set the address shown on the status page. Body: `{value}` |
| POST | `/servers/:id/motd` | Set the MOTD. Body: `{motd}` |
| POST | `/servers/:id/properties` | Update `server.properties`. Body: an object keyed by property name |
| POST | `/servers/:id/edit-file` | Save a text file inside the server directory. Body: `{filePath, content}`. `403` on path traversal, `400` for non-text extensions |

### Icon

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/icon` | Returns the icon as `image/png`; `404` if none |
| POST | `/servers/:id/icon` | Upload. Multipart field `icon`, PNG only, max 20 MB |
| POST | `/servers/:id/icon/reset` | Reset to the default icon |
| DELETE | `/servers/:id/icon` | Remove the icon |

### Jar updates

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/check-update` | Returns `{"updateAvailable": bool, "currentBuild", "latestBuild", ...}` |
| POST | `/servers/:id/update-jar` | Download the newer build. Returns `202`; `409` if running. Completes via WS `operation: "jar-update"` |


## Backups

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/backups` | List backups. Returns `{"backups": [{id, serverId, name, filename, size, sizeFormatted, createdAt, type}]}` |
| POST | `/servers/:id/backups` | Create a backup. Body: `{name?, stopFirst?, startAfter?}`. Returns `202`; `409` if running without `stopFirst`, or if a backup is already in progress |
| POST | `/servers/:id/backups/:backupId/restore` | Restore. Body: `{startAfter?}`. Returns `202` |
| DELETE | `/servers/:id/backups/:backupId` | Delete a backup |
| POST | `/servers/:id/backup-schedule` | Body: `{enabled, intervalHours (1–168), countdownMinutes (1–30)}`. Returns `{"backupSchedule": {...}, "nextBackupAt": ...}` |
| POST | `/servers/:id/backup-retention` | Body: `{retentionCount (0–100), retentionDays (0–365)}` (0 = unlimited) |

> Backup archive downloads are served by the browser-facing panel route `GET /servers/:id/backups/:backupId/download` (session auth, outside `/api/v1`).


## Server transfer

Move a server — files, Craftbox settings, and optionally backups and event history — to another Craftbox instance.

### Export

`GET /servers/:id/export?backups=1&events=1` (browser-facing panel route, session auth, outside `/api/v1`) streams a zip download. The server must be `stopped` or `crashed`. Query flags `backups` and `events` (`1` to include) select the optional payloads.

Archive layout (`formatVersion` 1):

```
craftbox-manifest.json   manifest + full server config (always)
modenv.json              mod enable/disable environment map (always)
server/                  full server directory (always)
backups.json             backup metadata records (optional)
backups/<file>.zip       backup archives (optional)
events.json              event history (optional)
```

### Import

`POST /servers/import` — multipart upload, field `archive`, `.zip` only, **max 4 GB**.

Returns `201 {"success": true, "server": {...}, "warnings": [...]}`; extraction continues in the background and completes via WS `operation: "import"`. Validation failures return `400` (not a zip, not a Craftbox export, corrupt manifest, newer `formatVersion`, unsafe paths).

Import behavior:

- The source server UUID is kept when free on the target instance, otherwise a new UUID is generated. Backup and event records always get fresh IDs.
- Runtime state is reset (`exitCode`, `crashReason`, timestamps); `advertisedIp` is cleared and **auto-start is always disabled** — a warning in `warnings` reminds you to re-enable it.
- A port collision with an existing server does not block the import; a warning is returned instead.


## Events

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/events/clear` | Clear the event log. Also emits the WS `events_cleared` message |

Event types include: `started`, `stopped`, `crashed`, `restarted`, `player_join`, `player_leave`, `action`, `jar_update`, `jar_update_fail`, `backup_create`, `backup_create_fail`, `backup_restore`, `backup_restore_fail`, `backup_delete`.


## Plugins & mods

The server must be `stopped` or `crashed` for all of these.

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/plugins/upload` | Upload jar(s). Multipart, any field names, `.jar` only, max 500 MB each; files are verified to be real zip archives. Returns `{"success": true, "count", "uploaded": [...], "rejected": [{name, reason}]}` |
| POST | `/servers/:id/plugins/delete` | Body: `{filename}` |
| POST | `/servers/:id/plugins/delete-all` | Delete all plugins/mods |
| POST | `/servers/:id/plugins/environment` | Mod-loader servers only. Body: `{filename, environment}` where environment is `client`, `server`, or `both`. Client-only mods are disabled on the server but still offered on the status page mods download |


## Templates

| Method | Path | Description |
|---|---|---|
| GET | `/templates` | List templates |
| GET | `/templates/:id` | One template |
| POST | `/templates` | Create from an existing server. Body: `{serverId, name, stopFirst?, startAfter?}`. Returns `201` |
| DELETE | `/templates/:id` | Delete a template |

Templates capture reusable configuration (type, version, memory, JVM args, gamemode, difficulty, port, behavior flags) — not world data, files, or dashboard groups.


## API keys

Session auth **only** — bearer tokens are rejected with `403 {"error": "session_required"}`.

| Method | Path | Description |
|---|---|---|
| GET | `/account/apikeys` | List your keys: `{"keys": [{id, name, prefix, createdAt, lastUsedAt}]}` |
| POST | `/account/apikeys` | Create. Body: `{name}` (1–50 chars). Returns `201 {id, name, key, prefix, createdAt}` — `key` is shown only here |
| DELETE | `/account/apikeys/:id` | Revoke. Returns `204` |


## Public status endpoints

Unauthenticated, mounted at the site root (not `/api/v1`). Only servers with the public status page enabled are exposed.

| Method | Path | Description |
|---|---|---|
| GET | `/status` | HTML index of public servers |
| GET | `/status/:id` | HTML status page for one server |
| GET | `/status/:id/api` | JSON: `{"server": {id, name, state, port, version, serverType, playerCount, players, uptime, uptimeFormatted, statusPagePublic, advertisedIp}}` |
| GET | `/status/:id/mods` | Zip of client-facing mods; `404` if none |

Public responses are sanitized: internal states (`provisioning`, `backing_up`, `restoring`, `updating_jar`) are reported as `stopped`, and crash details, file paths, and JVM configuration are never exposed.


## WebSocket protocol

The WebSocket shares the panel's HTTP port (`ws://<host>:6464/` or `wss://` behind TLS).

- **Authenticated socket** — connect to the root path with a valid **session cookie**. Bearer API keys are **not** accepted on the WebSocket; the upgrade is rejected with `401` when no session exists.
- **Public socket** — connect to `/ws/status` (no auth). Receives the sanitized subset only: no console history/output, public state mapping, crash messages reduced to "Server crashed".

The server pings every 30 seconds and drops sockets that miss a pong.

### Client → server messages

```json
{ "type": "subscribe",   "serverId": "<uuid>" }
{ "type": "unsubscribe", "serverId": "<uuid>" }
{ "type": "command",     "serverId": "<uuid>", "line": "say hello" }
{ "type": "ping" }
```

`command` is rejected on public sockets and requires the server to be `running`.

### Server → client messages

| Type | Payload | Notes |
|---|---|---|
| `subscribed` | `{serverId, state, lastStarted, history, players, playerCount, exitCode, crashReason}` | Initial snapshot; `history` is up to the last 200 console lines. Public sockets receive a reduced form |
| `console` | `{serverId, line, timestamp}` | Live log line. Authenticated sockets only |
| `state` | `{serverId, state, lastStarted, exitCode, crashReason}` | Lifecycle change |
| `players` | `{serverId, players, count}` | Join/leave updates |
| `event` | `{serverId, eventType, message, createdAt}` | Public sockets only receive started/stopped/crashed/restarted |
| `operation` | `{serverId, operation, status, payload?, error?}` | Completion of async REST calls. `operation` ∈ `backup`, `restore`, `jar-update`, `create`, `duplicate`, `import`; `status` ∈ `complete`, `failed` |
| `events_cleared` | `{serverId}` | Event log was cleared |
| `pong` / `error` | — | Heartbeat reply / protocol errors |


## Rate limiting

Only `POST /login` is rate limited (5 attempts per 15 minutes per IP; set `TRUST_PROXY=true` behind a reverse proxy so the client IP is detected correctly). There is currently **no rate limiting on `/api/v1`, `/status`, or the WebSocket** — be a considerate client, and treat API keys like passwords.
