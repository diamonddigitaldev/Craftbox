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

- `201 Created` — create, duplicate, import, create-from-modpack, create-from-mrpack. The response includes the new server record in `provisioning` state.
- `202 Accepted` — backup, restore, jar update, restart-with-backup. The response is `{"success": true, "status": "started"}`.

Completion is signalled over the WebSocket as an `operation` message (see [WebSocket protocol](#websocket-protocol)); modpack installs additionally stream `status: "progress"` messages while running. Clients that cannot hold a WebSocket open should poll `GET /servers/:id` and watch `state` (`provisioning`/`backing_up`/`restoring`/`updating_jar` → `stopped`, or `crashed` on failure).

> **Failed provisioning is not left behind.** When a *create* / *from-modpack* / *from-mrpack* provision fails, the half-built server is removed automatically rather than parked in `crashed` — so a polling client sees the server return `404` shortly after the failure (the `operation` message carries the reason). Failed *import*, *duplicate*, *backup*, *restore*, and *jar-update* operations instead leave the server in `crashed` for inspection.

### Validation constants

| Field | Rule |
|---|---|
| Server / template name | 1–50 chars, `^[a-zA-Z0-9 _\-]+$` |
| Group name | 1–50 chars, `^[a-zA-Z0-9 _\-]+$` (empty = ungrouped) |
| Group color | hex, `^#[0-9a-fA-F]{6}$` |
| Port | integer 1024–65535 |
| Memory | integer 512–65536 (MB, any whole value) |
| Version | `latest` or `^\d+\.\d+(\.\d+)?(-\w+)?$` (e.g. `1.21.4`) |
| Server type | `vanilla`, `paper`, `purpur`, `folia`, `fabric`, `forge`, `neoforge`, `custom` |
| `:id` route params | UUID v4 |
| Console command | max 1000 chars |
| Modrinth project / version id | 1–64 chars — a Modrinth slug (e.g. `fabric-api`) or base62 id |

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
| POST | `/servers/from-modpack` | Create from a Modrinth modpack — see [Modrinth](#modrinth) |
| POST | `/servers/from-mrpack` | Create from an uploaded `.mrpack` file — see [Modrinth](#modrinth) |
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
| POST | `/servers/:id/group` | Assign the dashboard group. Body: `{group}` (empty/null to ungroup). Returns `{"group": ..., "color": ...}` — `color` is the group's folder color (null when ungrouped) |
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
| POST | `/servers/:id/icon` | Upload. Multipart field `icon`, PNG only, max 20 MB. Also accepts [chunked uploads](#chunked-uploads-dgup) at `/servers/:id/icon/upload/*` |
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

`GET /servers/:id/export?backups=true&events=true&start=true` (browser-facing panel route, session auth, outside `/api/v1`) streams a zip download. The server must be `stopped` or `crashed`. Query flags (`true` to enable): `backups` and `events` select the optional payloads; `start` starts the server once the archive has finished streaming (used by the panel's "Start server after export" option).

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

`POST /servers/import` — multipart upload, field `archive`, `.zip` only. Craftbox imposes no size cap: the archive is streamed to disk on upload and streamed out of the zip on extraction, so size is bounded by disk space rather than memory. A reverse proxy in front of the panel may cap single-request bodies, however (Cloudflare Tunnel cuts them at 100 MB) — use the [chunked upload](#chunked-uploads-dgup) at `/servers/import/upload/*` for large archives, which is what the panel UI does.

Returns `201 {"success": true, "server": {...}, "warnings": [...]}`; extraction continues in the background and completes via WS `operation: "import"`. Validation failures return `400` (not a zip, not a Craftbox export, corrupt manifest, newer `formatVersion`, unsafe paths).

Import behavior:

- The source server UUID is kept when free on the target instance, otherwise a new UUID is generated. Backup and event records always get fresh IDs.
- All settings (including `autoStart` and the dashboard group) are preserved; runtime state is reset (`exitCode`, `crashReason`, timestamps) and `advertisedIp` is cleared (host-specific). The server stays stopped after import until started.
- A port collision with an existing server does not block the import; a warning is returned instead.


## Chunked uploads (DGUP)

Every upload endpoint also accepts chunked uploads using the [DGUP protocol](https://github.com/diamonddigitaldev/Dropgate/blob/master/docs/technical/DGUP.md) (Dropgate Upload Protocol, the normative reference — Craftbox implements the init/chunk/complete/cancel lifecycle without Dropgate's E2EE and bundle layers). Use this for files that would exceed a proxy's request-body cap; plain single-request multipart remains fully supported and is the simpler choice for small files.

Each upload endpoint exposes a DGUP sub-resource:

```
/servers/import/upload/{init,chunk,complete,cancel}
/servers/from-mrpack/upload/{init,chunk,complete,cancel}
/servers/:id/icon/upload/{init,chunk,complete,cancel}
/servers/:id/plugins/upload/{init,chunk,complete,cancel}   (one file per session)
```

All four are `POST` and require the same auth (and, for session auth, `X-CSRF-Token`) as the parent endpoint.

> `/servers/from-mrpack` takes form fields alongside the file (`name`, `port`, …). On the chunked path, send them as additional keys in the `complete` request body — the handler sees the same fields either way.

### Lifecycle

1. **`init`** — body `{filename, totalSize}` (bytes). Validates the destination up front (server exists and is stopped, file type allowed, size within limits) so a doomed upload fails before its first byte. Returns `{"uploadId", "chunkSize", "totalChunks"}` — chunk size is server-dictated (default 5 MiB, `UPLOAD_CHUNK_SIZE_BYTES` env var to override).
2. **`chunk`** — ×N, raw bytes with `Content-Type: application/octet-stream` and headers `X-Upload-ID`, `X-Chunk-Index` (0-based), `X-Chunk-Hash` (lowercase hex SHA-256 of the chunk). Every chunk except the last must be exactly `chunkSize` bytes. Chunks may arrive in any order; a re-sent chunk that already landed is acknowledged with `200`. Returns `{"success": true, "received": <count>}`.
3. **`complete`** — body `{uploadId}`. Assembles the file and runs the parent endpoint's normal handler: **the response is identical to the single-request multipart response** (e.g. `201 {"success": true, "server": {...}}` for import). Completion is idempotent — if the response is lost in transit, re-`POST` `complete` and the original outcome is replayed (kept for ~10 minutes) rather than processed twice.
4. **`cancel`** — body `{uploadId}`. Discards the session and its data.

### Errors

| Code | Meaning |
|---|---|
| `400` | Validation failure — bad filename/size, wrong chunk size/index, incomplete upload at `complete`. A hash mismatch is `400` with `"code": "hash_mismatch"` and is worth retrying (transit corruption) |
| `404` | Unknown upload session (also returned after a session expires or the panel restarts) — restart from `init` |
| `413` | File exceeds the endpoint's size limit (rejected at `init`) |
| `429` | Too many concurrent upload sessions (max 5 per user) |
| `507` | Insufficient disk space |

Sessions expire after 10 minutes without a chunk. Recommended client retry policy (per DGUP §7): up to 5 retries per chunk, exponential backoff from 1 s capped at 30 s, 60 s per-request timeout; treat other `4xx` as fatal.


## Groups

Server groups organize the dashboard. Groups are implicit — they exist while at least one server belongs to them (assign via `POST /servers/:id/group` or the `group` field on create/edit).

| Method | Path | Description |
|---|---|---|
| GET | `/groups` | All groups: `{"groups": [{name, color, count}]}` |
| POST | `/groups/:name` | Set a group's folder color. Body: `{color}` (hex, e.g. `#4caf50`). `404` if the group has no servers |
| POST | `/groups/:name/rename` | Rename a group (repoints every member server + its color). Body: `{name}`. `404` if the group has no servers, `409` if the new name is already taken by another group |


## Events

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/events/clear` | Clear the event log. Also emits the WS `events_cleared` message |

Event types include: `started`, `stopped`, `crashed`, `restarted`, `player_join`, `player_leave`, `action`, `jar_update`, `jar_update_fail`, `backup_create`, `backup_create_fail`, `backup_restore`, `backup_restore_fail`, `backup_delete`.


## Plugins & mods

The server must be `stopped` or `crashed` for all of these.

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/plugins/upload` | Upload jar(s). Multipart, any field names, `.jar` only, no size cap (bounded by disk space); files are verified to be real zip archives. Returns `{"success": true, "count", "uploaded": [...], "rejected": [{name, reason}]}`. Also accepts [chunked uploads](#chunked-uploads-dgup) (one jar per session) at `/servers/:id/plugins/upload/*` |
| POST | `/servers/:id/plugins/delete` | Body: `{filename}` |
| POST | `/servers/:id/plugins/delete-all` | Delete all plugins/mods |
| POST | `/servers/:id/plugins/environment` | Mod-loader servers only. Body: `{filename, environment}` where environment is `client`, `server`, or `both`. Client-only mods are disabled on the server but still offered on the status page mods download |


## Modrinth

Craftbox proxies the [Modrinth](https://modrinth.com) API server-side and installs modpacks, mods, and plugins from it. No Modrinth account or key is needed. Upstream failures surface as `429` (`Modrinth rate limit reached. Try again shortly.`) or `502` (`Modrinth is unavailable right now.`). Quilt-only projects and versions are filtered out or rejected — Craftbox has no Quilt server support. Search and lookup responses are cached server-side for 60 s / 5 min respectively.

### Search & lookups (proxied)

| Method | Path | Description |
|---|---|---|
| GET | `/modrinth/search?projectType=&query=&loader=&gameVersion=&index=&offset=&limit=` | Search projects. `projectType` ∈ `modpack` (default), `mod`. `loader` is optional for modpacks (`fabric`/`forge`/`neoforge`; omitted = all three) and **required** for mods — pass a Craftbox server type (`fabric`, `forge`, `neoforge`, `paper`, `purpur`, `folia`), which maps to the matching Modrinth loader family (`paper` also matches Spigot/Bukkit plugins). `index` ∈ `relevance` (default), `downloads`, `follows`, `newest`, `updated`. `offset` 0–10000, `limit` 1–50 (default 20). Returns `{"hits": [{projectId, slug, title, description, iconUrl, author, downloads, categories, serverSide, clientSide, dateModified}], "totalHits", "offset", "limit"}` |
| GET | `/modrinth/projects/:idOrSlug` | One project: `{"project": {projectId, slug, title, description, iconUrl, categories, serverSide, clientSide, downloads, projectType}}` |
| GET | `/modrinth/projects/:idOrSlug/versions?loader=&gameVersion=` | Version list, newest first, Quilt-only versions removed: `{"versions": [{id, name, versionNumber, gameVersions, loaders, datePublished, files: [{filename, size, primary}]}]}`. When `loader` / `gameVersion` are given, every returned version is guaranteed to match them — the filters are re-applied server-side because Modrinth ignores them for modpacks (a Forge-filtered pack would otherwise still list its NeoForge versions) |

Two quirks of Modrinth's search are worked around inside the proxy, so these endpoints return what they claim to:

- **A text search spanning several loaders is unioned server-side** — that is, modpacks searched with no `loader`, and plugins, whose family spans Paper, Spigot and Bukkit. Handed one OR'd loader facet, Modrinth decides how far to relax the query terms from whatever that facet leaves it, so the same query answers differently per loader and a loader's results can vanish from the union: searching modpacks for `optimised fps`, `loader=forge` returns 13 hits led by a 577k-download pack that the unfiltered search does not list at all — while for `all the mods` the OR'd facet finds *more* than the per-loader searches. Craftbox therefore runs the OR'd search **and** one search per loader, then merges and de-duplicates. The merge reads the top 100 of each list, so a multi-loader text search pages through a few hundred results; single-loader and query-less searches stay a single request and page as deep as Modrinth allows.
- **Plugins are searched as Modrinth's `plugin` project type.** Modrinth indexes Paper/Spigot/Bukkit projects under `project_type:plugin` even though it reports `project_type: "mod"` on the hits themselves, so Craftbox picks the facet from the loader family rather than from the `projectType` parameter. (Searching them as `mod` matches almost nothing — `essentials` returns 0 hits as a mod and 105 as a plugin.)

### Create a server from a modpack

| Method | Path | Description |
|---|---|---|
| POST | `/servers/from-modpack` | Body: `{projectId, versionId, name, port, memory, eula, javaArgs?, gamemode?, difficulty?, seed?, group?}`. Pack metadata is re-fetched server-side (client values cannot spoof it); the loader (Fabric/Forge/NeoForge) and Minecraft version come from the pack itself. Returns `201 {"success": true, "server": {...}}`; the install continues in the background (see progress below). `400` for Quilt packs, loaderless packs, or versions with no `.mrpack` file; `404`/`429`/`502` from the Modrinth lookups as above |
| POST | `/servers/from-mrpack` | Create from an uploaded `.mrpack`. Multipart, file field `mrpack`, max 2 GiB, plus the same base fields as text fields. The pack is parsed and the loader resolved **before** any server record is created, so malformed or Quilt packs fail with a clean `400`. Returns `201` + background install. Also accepts [chunked uploads](#chunked-uploads-dgup) at `/servers/from-mrpack/upload/*` |

The background install downloads the pack's files (SHA-512 verified; download hosts restricted to the mrpack spec whitelist), installs the loader server pinned to the pack's loader version, and applies `overrides/` then `server-overrides/`. Mods the pack marks as unsupported on the server are still installed, but land disabled on disk and tagged `client` in the mod environment map — so they show as **Client Only** on the plugins page and are included in the status page's mods download for players, without the loader ever seeing them. Progress streams over the WebSocket as `operation: "modpack-install"`, `status: "progress"` messages with payload `{phase, done?, total?}` — phases: `download`, `parse`, `loader`, `files` (with `done`/`total` counts), `overrides`, `finalize` — ending in `complete` or `failed`. On `failed` the half-built server is removed automatically (see [Asynchronous operations](#asynchronous-operations)). The created server records a `modpack` block (`{projectId, versionId, name, versionNumber, iconUrl, source: "modrinth"|"file", installedAt}`) for future tooling; it survives export/import.

### Install a mod or plugin into an existing server

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/modrinth-install` | Body: `{projectId, versionId?}` — omit `versionId` for the newest compatible version. Compatibility is filtered to the server's loader family and Minecraft version. The version's **required dependencies** are installed too (recursive, depth-capped, already-present files skipped). Synchronous; the server must be `stopped`/`crashed` (`400` otherwise). Returns `{"success": true, "installed": [{filename, versionNumber, projectId}]}` — the first entry is the requested project. `404` when no compatible version exists, `409` when the file is already installed |
| GET | `/servers/:id/modrinth-installed` | Which Modrinth projects are already present in the server's content folder, matched by SHA-512 file hash against Modrinth's version database (locally modified jars won't match). Returns `{"projects": {"<projectId>": "<filename>", ...}}` |


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
| `operation` | `{serverId, operation, status, payload?, error?}` | Progress/completion of async REST calls. `operation` ∈ `backup`, `restore`, `jar-update`, `create`, `duplicate`, `import`, `modpack-install`; `status` ∈ `complete`, `failed`, `progress`. `progress` is currently emitted by `modpack-install` only, with `payload {phase, done?, total?}` (see [Modrinth](#modrinth)) |
| `events_cleared` | `{serverId}` | Event log was cleared |
| `pong` / `error` | — | Heartbeat reply / protocol errors |


## Rate limiting

Only `POST /login` is rate limited (5 attempts per 15 minutes per IP; set `TRUST_PROXY=true` behind a reverse proxy so the client IP is detected correctly). There is currently **no rate limiting on `/api/v1`, `/status`, or the WebSocket** — be a considerate client, and treat API keys like passwords.
