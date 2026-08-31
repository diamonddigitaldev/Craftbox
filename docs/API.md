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
- `202 Accepted` — backup, restore, jar upgrade, restart-with-backup, and edit/properties with `backup: true` (see [Restore-point backups](#restore-point-backups)). The response is `{"success": true, "status": "started"}`.

Completion is signalled over the WebSocket as an `operation` message (see [WebSocket protocol](#websocket-protocol)); modpack installs additionally stream `status: "progress"` messages while running. Clients that cannot hold a WebSocket open should poll `GET /servers/:id` and watch `state` (`provisioning`/`backing_up`/`restoring`/`upgrading_jar` → `stopped`, or `crashed` on some failures — see below).

> **Failed provisioning is not left behind.** When a *create* / *from-modpack* / *from-mrpack* provision fails, the half-built server is removed automatically rather than parked in `crashed` — so a polling client sees the server return `404` shortly after the failure (the `operation` message carries the reason). Failed *import* and *duplicate* operations instead leave the server in `crashed` for inspection; failed *backup*, *restore*, and *jar-upgrade* operations return it to `stopped` (the failure reason arrives on the `operation` message and in the event log).

### Validation constants

| Field | Rule |
|---|---|
| Server / template name | 1–50 chars, `^[a-zA-Z0-9 _\-]+$` |
| Group name | 1–50 chars, `^[a-zA-Z0-9 _\-]+$` (empty = ungrouped) |
| Group color | hex, `^#[0-9a-fA-F]{6}$` |
| Port | integer 1024–65535 |
| Memory | integer 512–65536 (MB, any whole value) |
| Version | `latest` or `^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,63}$` (e.g. `1.21.4`, `25w03a`, `1.21.5-pre1`) |
| Server type | `vanilla`, `paper`, `purpur`, `folia`, `fabric`, `forge`, `neoforge`, `custom` |
| `:id` route params | UUID v4 |
| Console command | max 1000 chars |
| Modrinth project / version id | 1–64 chars — a Modrinth slug (e.g. `fabric-api`) or base62 id |

### Server states

`stopped`, `starting`, `running`, `stopping`, `crashed`, `provisioning`, `backing_up`, `restoring`, `upgrading_jar`.

> `upgrading_jar` was named `updating_jar` before 1.1.0 — clients matching on the old value should update.

Allowed lifecycle actions: **start** from `stopped`/`crashed`; **stop** from `running`/`starting`; **restart** from `running`; **kill** from `running`/`starting`/`stopping`.

> **Provisioning is exclusive.** A server created, imported, duplicated or built from a modpack stays `provisioning` until its directory is fully assembled, and can only leave that state for `stopped` or `crashed`. Backups, restores, jar upgrades, restarts, and the settings/properties restore-point saves all reject with `409 {"error": "Wait for the server to finish provisioning."}` until it clears — `stopFirst` does not override this. Poll `GET /servers/:id` or watch the WebSocket `state` message to know when it is ready.


## Servers

The server object returned by these endpoints contains the full configuration (name, type, version, port, memory, JVM args, gamemode, difficulty, seed, flags, `group`, timestamps, `state`, `exitCode`, `crashReason`, `javaMajor` — the Java runtime requirement recorded from Mojang metadata at jar download time, null when unknown, …). The on-disk `directory` field is stripped from responses.

### Read

| Method | Path | Description |
|---|---|---|
| GET | `/servers` | List all servers with live state. Returns `{"servers": [...]}` |
| GET | `/servers/:id` | One server. Returns `{"server": {...}}` |
| GET | `/server-types` | Available server types. Returns `{"types": [...]}` |
| GET | `/versions?type=<type>&channel=<stable\|all>` | Minecraft versions for a type, newest first. `channel` defaults to `stable`; `all` additionally includes snapshot/pre-release versions where the type has them. Returns `{"versions": [{"id", "channel", "channelLabel"?, "releaseDate"?}], "latest"}` — `channel` is one of `stable`, `snapshot`, `pre-release`, `rc`, `beta`, `experimental`; `channelLabel` is the upstream-native channel name where it differs from the normalized one (Forge: `recommended`/`latest`); `releaseDate` (ISO) is present where upstream publishes one (vanilla); `latest` is always the newest **stable** version |
| GET | `/versions/:type/builds/:version` | Builds for a version, newest first, including non-stable channels. Returns `{"builds": [{"build", "channel"}]}` |
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

### Console

The [WebSocket](#websocket-protocol) is the live feed, but it does not accept bearer keys — this is how an API-key client reads console output. It pairs with `POST /servers/:id/command`, which sends a line but returns nothing of the reply.

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/console?limit=&source=` | Recent console output, oldest first. Returns `{"source": "file"\|"memory", "truncated": bool, "lines": [{timestamp, line}]}`. `limit` 1–1000 (default 200); `truncated` means older output exists beyond what was returned |

`source` selects where the output comes from, and the two differ:

- **`file`** — `logs/craftbox-console.log` in the server directory. Durable, timestamped, survives a panel restart, and is what you want for automation. Append-only and never rotated, so reads are tailed from the end.
- **`memory`** — the live process buffer. A few hundred lines at most, `timestamp` is always `null`, and it is discarded whenever the process object is rebuilt (which includes every start of a stopped server). It does hold the handful of `[Craftbox] ...` lines emitted after the log stream closes on exit, which never reach disk.
- **`auto`** (default) — `file`, falling back to `memory` for a server that has never been started on this install.

### Settings

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/edit` | Edit config. Body: `{name, port, memory, javaArgs?, gamemode?, difficulty?, seed?, group?, version?, customJarUrl?, backup?}`. Version changes must be upgrades (release versions compare numerically; snapshot/pre-release versions compare by the provider's chronological ordering) and require the server stopped (`409` otherwise); may download a new jar. Returns `{"success": true, "server": {...}, "versionChanged": bool, "jarChanged": bool}`. With `backup: true` see [Restore-point backups](#restore-point-backups) — returns `202` instead |
| POST | `/servers/:id/group` | Assign the dashboard group. Body: `{group}` (empty/null to ungroup). Returns `{"group": ..., "color": ...}` — `color` is the group's folder color (null when ungrouped) |
| POST | `/servers/:id/autorestart` | Body: `{enabled: bool}`. Returns `{"autoRestart": bool}` |
| POST | `/servers/:id/autostart` | Body: `{enabled: bool}`. Returns `{"autoStart": bool}` |
| POST | `/servers/:id/statuspublic` | Toggle listing on the `/status` index. Body: `{enabled: bool}`. Does **not** gate direct access — see [Public status endpoints](#public-status-endpoints) |
| POST | `/servers/:id/advertisedip` | Set the address shown on the status page. Body: `{value}` |
| POST | `/servers/:id/motd` | Set the MOTD. Body: `{motd}` |
| POST | `/servers/:id/properties` | Update `server.properties`. Body: an object keyed by property name, plus an optional `backup` flag (reserved — never written as a property). With `backup: true` see [Restore-point backups](#restore-point-backups) — returns `202` instead of `{"success": true}` |
| POST | `/servers/:id/edit-file` | Save a text file inside the server directory. Body: `{filePath, content}`. `403` on path traversal, `400` if the target is not text (see [Text vs binary](#files)) |

### Files

Paths are relative to the server directory and are resolved against it with symlinks fully resolved — anything landing outside returns `403 {"error": "Access denied."}`.

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/files?path=` | List a directory (`path` omitted = server root). Returns `{"path", "files": [{name, isDirectory, size, sizeFormatted, modified, modifiedISO, editable}]}`, directories first then by name. `editable` marks files the editor will open in one piece — text **and** within the 5 MB limit; a larger text file lists as `editable: false` but is still readable in windows via `/file` |
| GET | `/servers/:id/file?path=` | Read a text file. **Works while the server is running** — unlike `/download` — which makes it the way to read a log or a feed a plugin is still appending to. Returns `{"file": {name, path, size, modifiedISO, offset, length, truncated, content}}`, where `size` is the whole file and `offset`/`length` describe the bytes returned. `400` if the file is not text (use `/download`), `413` if it is over 5 MB and no window was requested |
| GET | `/servers/:id/download?path=` | Stream any single file as `application/octet-stream`, with an exact `Content-Length`. Requires the server `stopped`/`crashed` (`409` otherwise), since a running server holds handles on world data and jars; a read that fails mid-stream with `EBUSY` also returns `409` |
| POST | `/servers/:id/files/upload` | Upload file(s) into a directory. Multipart, any field names, plus a `path` text field naming the destination directory (omitted = server root) — on the multipart path it must precede the files in the stream. Any file type, no size cap (bounded by disk space). An existing file of the same name is **overwritten**; a name already taken by a folder is rejected, as is one that would replace a file a running server holds open (`reason: "file is in use by the server"`). Returns `{"success": true, "count", "uploaded": [...], "replaced": <n>, "rejected": [{name, reason}]}`. `404` if the destination is not a directory. Also accepts [chunked uploads](#chunked-uploads-dgup) (one file per session) at `/servers/:id/files/upload/*` |
| POST | `/servers/:id/files/mkdir` | Create a directory. Body: `{path, name}` — `path` is the parent (omitted = server root). `409` if the name is taken |
| POST | `/servers/:id/files/mkfile` | Create an empty file. Body: `{path, name}` — `path` is the parent directory (omitted = server root). Any extension; an existing file is never truncated — `409` if the name is taken |
| POST | `/servers/:id/files/rename` | Rename a file or directory in place. Body: `{path, newName}`. Requires the server `stopped`/`crashed` (`409` otherwise). `409` if the new name is taken, or if the entry is held open by the server; changing only the letter case is allowed |
| POST | `/servers/:id/files/delete` | Delete a file, or a directory and everything inside it. Body: `{path}`. Requires the server `stopped`/`crashed` (`409` otherwise); `409` if the entry is held open by the server. `400` for the server directory itself |

> **Text vs binary is decided by content, not by extension.** There is no list of readable extensions to keep up with: a file is text if its first 8 KB decode as UTF-8, contain no NUL byte, and are not mostly control characters. So `.jsonl`, `.json5`, a mod's own invented config extension and a name with no extension at all all open, without anyone having to add them anywhere. Two shortcuts sit either side of that check — always-binary extensions (`.jar .zip .png .dat .nbt .mca .mrpack .exe .db`, and the rest of the usual archive/image/media/compiled set) are refused without a read, so listing a `mods/` folder stays cheap; and when there is nothing to read at all — the path does not exist yet, or the running server holds it locked — a list of known text extensions stands in.
>
> The content check also catches the reverse case: a UTF-16 or latin-1 file wearing a `.txt` is refused, because the panel reads and writes UTF-8 throughout and would show it as mojibake and mangle it on save. `.nbt` and `.dat` are refused for the same reason — they are gzipped binary, and earlier versions wrongly offered them for editing.

> **Reading a file larger than 5 MB.** `/file` returns the whole file up to 5 MB and `413` past it. Beyond that, ask for a byte window with **`?tail=`** (last N bytes) or **`?offset=`&`limit=`** (explicit window) — the two forms are mutually exclusive, and both are byte counts, not lines or characters. A window is clamped to 5 MB and to the file's actual length, so an over-large ask returns short rather than failing, and `truncated` in the response says whether anything was left out. A window landing mid-character is trimmed back to a whole one, so `content` never contains a replacement character from the cut; `offset` reports where the returned bytes actually start after that trim.
>
> ```
> GET /servers/:id/file?path=exchange/telemetry.jsonl&tail=65536
> → {"file": {"size": 41203847, "offset": 41138311, "length": 65530, "truncated": true, "content": "..."}}
> ```
>
> The editor UI never takes a window: it posts the whole textarea back, so opening a partial file would truncate the rest away on save. It refuses oversized files outright and points at the download instead.

> **Creating is ungated, destroying is not.** Upload, mkdir and mkfile work in any server state, matching `/edit-file`, which already writes into a running server's directory. Rename and delete require the server stopped: they are the destructive pair, and a running server holds open handles. Uploading, creating or deleting `server.properties` or `eula.txt` in the server root re-syncs the mirrored database fields, exactly as `/edit-file` does.
>
> **Replacing what a running server holds open is the one upload that is gated.** While a server is not `stopped`/`crashed`, an upload that would overwrite its jar, or any existing file under its world folders, `logs/`, or `mods/`/`plugins/`, is rejected per-file with `reason: "file is in use by the server"` — the rest of the batch still lands. Windows fails that write with `EBUSY` anyway; Linux does not, and would silently corrupt a live server. New files in those folders are unaffected: nothing can hold a handle on a name that isn't there yet.
>
> New names supplied to `rename`, `mkdir` and `mkfile` must be a single path segment. A name is rejected (`400`) if it contains a slash or backslash, contains `< > : " | ? *` or a control character, ends in a dot, is `.` or `..`, is longer than 255 characters, or is a reserved device name (`CON`, `NUL`, `COM1`…) — the last few would fail confusingly at the filesystem layer, on Windows now or after an export/import later. Leading and trailing whitespace is trimmed rather than rejected, so `"notes.txt "` creates `notes.txt`.
>
> The slash rule is a rejection, not a rewrite: `sub/notes.txt` returns `400` rather than quietly creating `notes.txt` in the current folder. Create the directory first, then the file inside it. This differs from **upload**, where a name is reduced to its last segment on purpose — a client can send a whole relative path as the filename, and only the basename is meaningful to an endpoint that writes into one directory.
>
> **Directory trees cannot be uploaded.** An upload flattens what it is given into the destination folder; it never recreates a hierarchy under it. The panel refuses a dropped folder before anything is sent, because a browser does not expand one — it hands over a single zero-byte entry standing for the directory itself, which fails the moment it is read. Create the folders with `mkdir` and upload into them.

### Restore-point backups

`POST /edit` and `POST /properties` accept `backup: true`. The backup is taken **before** the change is applied, so restoring it undoes the change completely — a backup taken afterwards captures the new configuration and cannot roll it back. The endpoint then:

1. stops the server if it is running (a live world cannot be zipped consistently),
2. takes the backup (state `backing_up`, named `Pre-edit backup` / `Pre-properties backup`),
3. applies the change,
4. restarts the server if it had been running.

The response is `202 {"success": true, "status": "started"}` instead of the endpoint's usual body, and the work completes over the WebSocket as `operation: "settings-save"` with payload `{versionChanged?, jarChanged?, restarted}`. `409` if a backup is already in progress. If the backup *or* the change fails, the server is returned to the state it was found in (restarted if it had been running) and the reason arrives on the same `operation` message with `status: "failed"`.

> `POST /restart` and `POST /upgrade-jar` also take a `backup` flag. On `/upgrade-jar` it is likewise a true restore point (taken before the jar is replaced). On `/restart` it is only a pre-restart snapshot — by then any settings change has already been saved.

### Icon

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/icon` | Returns the icon as `image/png`; `404` if none |
| POST | `/servers/:id/icon` | Upload. Multipart field `icon`, PNG only, max 20 MB. Also accepts [chunked uploads](#chunked-uploads-dgup) at `/servers/:id/icon/upload/*` |
| POST | `/servers/:id/icon/reset` | Reset to the default icon |
| DELETE | `/servers/:id/icon` | Remove the icon |

### Jar upgrades

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/check-upgrade` | Returns `{"upgradeAvailable": bool, "currentBuild", "latestBuild", "channel", "reason"?}` — `latestBuild` is the newest build published for that Minecraft version, whatever channel it carries — the same build a fresh install or an upgrade downloads, so the check and the download can never disagree. Forge in particular tracks the `latest` promotion, not the older `recommended` one. A server with no recorded build (`currentBuild: null`) reports `upgradeAvailable: true` with a `reason`: upgrading is what records a build. `reason` is also set, with `upgradeAvailable: false`, when the type has no build tracking (`custom`, `vanilla`) or the version has no published builds |
| POST | `/servers/:id/upgrade-jar` | Download the newer build. Body: `{version?, jarUrl?, backup?}` — `version` upgrades a tracked server to that version in the same operation (upgrade-only, same downgrade rules as `/edit`); `jarUrl` (custom servers only — required there, ignored otherwise) replaces the jar from a new http/https URL, downloading to a sidecar so a failed fetch leaves the old jar intact; `backup: true` creates a backup first (state passes through `backing_up`, then `upgrading_jar`; `409` if a backup is already in progress). Returns `202`; `409` if running. Completes via WS `operation: "jar-upgrade"` with a payload of `{build, version}` |

> **`build` is not one type.** Paper, Purpur and Folia report an integer build number; Forge, NeoForge and Fabric report a dotted version string (Fabric's is its loader version, which is what a modpack pins). Compare builds segment-wise rather than lexically — `"21.1.100"` is newer than `"21.1.95"`, and a pre-release suffix sorts below the release it precedes (`"21.9.16-beta"` is older than `"21.9.16"`). `vanilla` and `custom` servers have no build at all.


## Backups

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/backups` | List backups. Returns `{"backups": [{id, serverId, name, filename, size, sizeFormatted, createdAt, type}]}` |
| POST | `/servers/:id/backups` | Create a backup. Body: `{name?, stopFirst?, startAfter?}`. Returns `202`; `409` if running without `stopFirst`, or if a backup is already in progress |
| POST | `/servers/:id/backups/:backupId/restore` | Restore. Body: `{startAfter?}`. Returns `202` |
| DELETE | `/servers/:id/backups/:backupId` | Delete a backup |
| POST | `/servers/:id/backup-schedule` | Body: `{enabled, intervalHours (1–168), countdownMinutes (1–30)}`. Returns `{"backupSchedule": {...}, "nextBackupAt": ...}` |
| POST | `/servers/:id/backup-retention` | Body: `{retentionCount (0–100), retentionDays (0–365)}` (0 = unlimited) |
| GET | `/servers/:id/backups/:backupId/download` | Stream the backup archive as `application/zip`, with an exact `Content-Length` read off the file rather than the record. `404` if the backup does not belong to this server |


## Server transfer

Move a server — files, Craftbox settings, and optionally backups and event history — to another Craftbox instance.

### Export

`GET /servers/:id/export?backups=true&events=true&start=true` sends the download as `<server-name>.cbx` with `Content-Type: application/x-craftbox-export+zip` and an exact `Content-Length`. The server must be `stopped` or `crashed` (`409` otherwise). Query flags (`true` to enable): `backups` and `events` select the optional payloads; `start` starts the server once the archive has finished streaming (used by the panel's "Start server after export" option) — an abandoned download leaves the server stopped. Requesting `backups` holds the backup lock while the archive is packed; `409` if a backup is already running. `507` if the staging area cannot hold the archive.

> **The archive is packed before the response begins.** Nothing is sent until the whole `.cbx` exists, which is what makes the size knowable — a zip's length is not known until its last entry is written, and a browser given no `Content-Length` shows an indefinite "Resuming…" for the entire transfer with no size, percentage or ETA. Expect a pause on a large server before the first byte, proportional to the amount being packed. Packing failures therefore land **before** any header is sent and come back as ordinary JSON errors; only a fault while streaming an already-packed archive drops the connection mid-body. The same applies to `/servers/:id/download-zip`, `/servers/:id/plugins/download-all` and `/status/:id/mods`.

> **`.cbx` is Craftbox's transfer-archive extension.** The container is an ordinary zip, so any zip tool can open one for inspection — only the extension and media type are Craftbox-specific. Import requires the `.cbx` extension but never trusts it: the upload is also checked against the zip magic bytes and must carry a valid `craftbox-manifest.json`, so renaming an arbitrary zip to `.cbx` is still rejected.

Archive layout (`formatVersion` 1):

```
craftbox-manifest.json   manifest + full server config + group color (always)
modenv.json              mod enable/disable environment map (always)
server/                  full server directory (always)
backups.json             backup metadata records (optional)
backups/<file>.zip       backup archives (optional)
events.json              event history (optional)
```

### Import

`POST /servers/import` — multipart upload, field `archive`, `.cbx` only. Craftbox imposes no size cap: the archive is streamed to disk on upload and streamed out of the zip on extraction, so size is bounded by disk space rather than memory. A reverse proxy in front of the panel may cap single-request bodies, however (Cloudflare Tunnel cuts them at 100 MB) — use the [chunked upload](#chunked-uploads-dgup) at `/servers/import/upload/*` for large archives, which is what the panel UI does.

Returns `201 {"success": true, "server": {...}, "warnings": [...]}`; extraction continues in the background and completes via WS `operation: "import"`. Validation failures return `400` (not a zip container, not a Craftbox export, corrupt manifest, newer `formatVersion`, unsafe paths).

Import behavior:

- The source server UUID is kept when free on the target instance, otherwise a new UUID is generated. Backup and event records always get fresh IDs.
- All settings are preserved, `advertisedIp` included — the archive is a snapshot of the server as it was, so an address that does not apply on the new host is an edit away rather than something to remember. Only runtime state is reset (`exitCode`, `crashReason`, timestamps); the server stays stopped after import until started.
- The dashboard group comes across by name, and its color travels in the manifest alongside it. A group that already exists on the target instance keeps the color chosen there — an import never restyles servers that were already in it.
- A port collision with an existing server does not block the import; a warning is returned instead.


## Chunked uploads (DGUP)

Every upload endpoint also accepts chunked uploads using the [DGUP protocol](https://github.com/diamonddigitaldev/Dropgate/blob/master/docs/technical/DGUP.md) (Dropgate Upload Protocol, the normative reference — Craftbox implements the init/chunk/complete/cancel lifecycle without Dropgate's E2EE and bundle layers). Use this for files that would exceed a proxy's request-body cap; plain single-request multipart remains fully supported and is the simpler choice for small files.

Each upload endpoint exposes a DGUP sub-resource:

```
/servers/import/upload/{init,chunk,complete,cancel}
/servers/from-mrpack/upload/{init,chunk,complete,cancel}
/servers/:id/icon/upload/{init,chunk,complete,cancel}
/servers/:id/plugins/upload/{init,chunk,complete,cancel}   (one file per session)
/servers/:id/files/upload/{init,chunk,complete,cancel}     (one file per session)
```

All four are `POST` and require the same auth (and, for session auth, `X-CSRF-Token`) as the parent endpoint.

> `/servers/from-mrpack` takes form fields alongside the file (`name`, `port`, …). On the chunked path, send them as additional keys in the `complete` request body — the handler sees the same fields either way. `/servers/:id/files/upload` takes its destination `path` the same way — which is why `init` cannot pre-validate the destination directory for that endpoint, only that the server exists.

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

Event types (the full set — `types=` on `GET /servers/:id/events` filters on these):

| Type | Logged when |
|---|---|
| `started` / `stopped` / `crashed` | The server process reached that state |
| `restarted` | A restart completed (logged instead of a `stopped` + `started` pair) |
| `player_join` / `player_leave` | A player joined or left; the event carries `playerName` |
| `action` | A user-initiated action with no more specific type — restart requested, a restore-point backup created, a restore-point save that failed, an import completed, … |
| `jar_upgrade` / `jar_upgrade_fail` | A jar upgrade succeeded or failed, including a Minecraft version change |
| `backup_create` / `backup_create_fail` | A backup was created or failed |
| `backup_restore` / `backup_restore_fail` | A backup was restored or failed |
| `backup_delete` | A backup was deleted |

Only `started`, `stopped`, `crashed` and `restarted` are exposed on public status pages.


## Plugins & mods

Reads work in any state. The **mutating** routes require the server to be `stopped` or `crashed`. All of these `404` on server types with no plugin/mod folder (`vanilla`, `custom`).

| Method | Path | Description |
|---|---|---|
| GET | `/servers/:id/plugins` | List installed plugins/mods. Returns `{"contentType": {label, folder}, "files": [{name, size, sizeFormatted, modifiedISO, environment}]}` — `label` is `Plugins` (Paper/Purpur/Folia) or `Mods` (Fabric/Forge/NeoForge), and `environment` is always `both` for plugin loaders. Empty `files` when the folder does not exist yet |
| GET | `/servers/:id/plugins/environment` | Mod-loader servers only (`400` otherwise). Returns `{"environment": {"<file>.jar": "client"\|"server"}}`. Only non-default entries are stored, so a mod absent from the map is `both` |
| POST | `/servers/:id/plugins/upload` | Upload jar(s). Multipart, any field names, `.jar` only, no size cap (bounded by disk space); files are verified to be real zip archives. An existing copy is overwritten, including a `.jar.disabled` one (which is removed, and the mod's environment tag reset to `both` — uploading is an explicit "put this on the server"). Returns `{"success": true, "count", "uploaded": [...], "replaced": <n>, "rejected": [{name, reason}]}`. Also accepts [chunked uploads](#chunked-uploads-dgup) (one jar per session) at `/servers/:id/plugins/upload/*` |
| POST | `/servers/:id/plugins/delete` | Body: `{filename}`. Removes both on-disk forms (`<name>.jar` and `<name>.jar.disabled`), since one listed mod can stand for either |
| POST | `/servers/:id/plugins/delete-all` | Delete all plugins/mods |
| POST | `/servers/:id/plugins/environment` | Mod-loader servers only. Body: `{filename, environment}` where environment is `client`, `server`, or `both`. Client-only mods are disabled on the server but still offered on the status page mods download |

> **Downloads.** The panel's download links live outside `/api/v1` and are listed here for completeness: `GET /servers/:id/plugins/download?file=` (one jar), `GET /servers/:id/plugins/download-all` (the whole folder as a zip), and `GET /servers/:id/download-zip` (the whole server directory). All three carry an exact `Content-Length` and report their outcome over the WebSocket as `operation: "download"`; the two zips are packed before the response begins, as [Export](#export) describes.


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

The background install downloads the pack's files (SHA-512 verified; download hosts restricted to the mrpack spec whitelist), installs the loader server pinned to the pack's loader version, and applies `overrides/` then `server-overrides/`. Mods the pack marks as unsupported on the server are still installed, but land disabled on disk and tagged `client` in the mod environment map — so they show as **Client Only** on the plugins page and are included in the status page's mods download for players, without the loader ever seeing them. Progress streams over the WebSocket as `operation: "modpack-install"`, `status: "progress"` messages with payload `{phase, done?, total?}` — phases: `download`, `parse`, `loader`, `files`, `overrides`, `finalize` — ending in `complete` or `failed`. The `files` phase carries `done`/`total` counts of **mods** (every jar destined for `mods/`, from the manifest and from the overrides, client-only ones included — so the total matches what the mods page lists afterwards, not the raw file count); it keeps ticking during the `overrides` phase as any mods shipped there land. On `failed` the half-built server is removed automatically (see [Asynchronous operations](#asynchronous-operations)). The created server records a `modpack` block (`{projectId, versionId, name, versionNumber, iconUrl, source: "modrinth"|"file", installedAt}`) for future tooling; it survives export/import.

### Install a mod or plugin into an existing server

| Method | Path | Description |
|---|---|---|
| POST | `/servers/:id/modrinth-install` | Body: `{projectId, versionId?}` — omit `versionId` for the newest compatible version. Compatibility is filtered to the server's loader family and Minecraft version. The version's **required dependencies** are installed too (recursive, depth-capped, already-present files skipped). Synchronous; the server must be `stopped`/`crashed` (`400` otherwise). Returns `{"success": true, "installed": [{filename, versionNumber, projectId}]}` — the first entry is the requested project. `404` when no compatible version exists, `409` when the file is already installed |
| GET | `/servers/:id/modrinth-installed` | Which Modrinth projects are already present in the server's content folder, matched by SHA-512 file hash against Modrinth's version database (locally modified jars won't match). Disabled jars (`.jar.disabled`, e.g. a modpack's client-only mods) count as installed. Returns `{"projects": {"<projectId>": "<filename>", ...}}` |


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

Unauthenticated, mounted at the site root (not `/api/v1`). The `statusPagePublic` flag controls **listing only** — it decides whether a server appears in the `/status` index. An individual server's status page, its JSON, and its mods zip are reachable by anyone holding the server's UUID regardless of that flag.

| Method | Path | Description |
|---|---|---|
| GET | `/status` | HTML index of servers with the public status page enabled |
| GET | `/status/:id` | HTML status page for one server |
| GET | `/status/:id/api` | JSON: `{"server": {id, name, state, port, version, serverType, playerCount, players, uptime, uptimeFormatted, statusPagePublic, advertisedIp}}` |
| GET | `/status/:id/mods` | Zip of client-facing mods, packed before the response begins so it carries an exact `Content-Length`; `404` if none |

Public responses are sanitized: internal states (`provisioning`, `backing_up`, `restoring`, `upgrading_jar`) are reported as `stopped`, and crash details, file paths, and JVM configuration are never exposed.

> **Note:** unauthenticated `GET` access to these per-server endpoints is intentional, not a security gap. The server UUID *is* the capability token — that is what lets you hand a status link or a client-mods download to players who have no panel account, and keeps that link working. Guessing a v4 UUID is not a practical attack, and the payloads are sanitized as described above: server-only mods are excluded from the zip, and no file paths, JVM configuration, or crash details are ever exposed. Automated scanners sometimes flag these routes as "unauthenticated data exposure"; treat that as a false positive. If you do not want a server reachable this way at all, do not distribute its UUID — there is no per-server toggle that disables the direct link, because share links are the feature.


## WebSocket protocol

The WebSocket shares the panel's HTTP port (`ws://<host>:6464/` or `wss://` behind TLS).

- **Authenticated socket** — connect to the root path with a valid **session cookie**. Bearer API keys are **not** accepted on the WebSocket; the upgrade is rejected with `401` when no session exists. Bearer clients should poll [`GET /servers/:id/console`](#console) instead.
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
| `operation` | `{serverId, operation, status, payload?, error?}` | Progress/completion of async REST calls. `operation` ∈ `backup`, `restore`, `jar-upgrade`, `settings-save`, `create`, `duplicate`, `import`, `modpack-install`, `download`; `status` ∈ `complete`, `failed`, `progress`, `cancelled`. `progress` is emitted by `modpack-install` with `payload {phase, done?, total?}` (see [Modrinth](#modrinth)) and by `download` (see below). A restore-point save emits `backup` first, then `settings-save` |
| `events_cleared` | `{serverId}` | Event log was cleared |
| `pong` / `error` | — | Heartbeat reply / protocol errors |

> **`operation: "download"` reports how a download went.** A browser download is invisible to the page that started it, so any download endpoint under a server reports its own outcome here — including the ones that are plain links rather than API calls. Add `?dl=<token>` (any opaque string, up to 64 characters) to the download URL and the token comes back in every message about it, which is how a client matches an outcome to the request it made. Without the token nothing is emitted; API clients read the HTTP status instead.
>
> `progress` carries `{token, label, phase, done, total}` where `phase` is `packing` (bytes read so far, out of the estimated source size) or `sending` (`total` is the finished archive's size), throttled to one message a second. `complete` and `cancelled` carry `{token, label, bytes, sizeFormatted}` — `cancelled` means the client hung up before the last byte, whether during packing or mid-transfer. `failed` carries the reason in `error` and covers everything a download can be refused for, including the guard failures (`409` server running, `404` missing file, `507` no staging space) whose response body the browser never shows.


## Rate limiting

Only `POST /login` is rate limited (5 attempts per 15 minutes per IP; set `TRUST_PROXY=true` behind a reverse proxy so the client IP is detected correctly). There is currently **no rate limiting on `/api/v1`, `/status`, or the WebSocket** — be a considerate client, and treat API keys like passwords.
