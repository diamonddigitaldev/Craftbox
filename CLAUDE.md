# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Start the app (node src/server.js)
npm run dev        # Start with --watch for auto-reload on file changes
docker compose up  # Run in Docker (builds multi-JRE image)
```

No test framework or linter is configured.

## Architecture

Craftbox is a Minecraft server management panel — a Node.js/Express app with EJS templates and a Bootstrap 5 dark-theme UI.

### Boot Sequence (`src/server.js`)

Async bootstrap: DB init → session secret → Express app (EJS views) → ServerManager singleton → BackupScheduler → middleware stack → routes → error handlers → HTTP server → WebSocket → listen on port 6464 → auto-start servers → init backup schedules → graceful shutdown handlers.

### Database (`src/db.js`)

quick.db wrapping better-sqlite3, stored at `data/craftbox.sqlite`. Key-value tables:
- `users` table: keys like `user_<uuid>`, values are user objects (id, username, passwordHash, role)
- `servers` table: keys like `server_<uuid>`, values are server config objects (includes `backupSchedule` sub-object)
- `backups` table: keys like `backup_<uuid>`, values are backup metadata (id, serverId, name, filename, size, createdAt, type)
- `events` table: keys like `event_<uuid>`, values are event records (id, serverId, type, message, createdAt, playerName?)
- `config` table: `setup.complete`, `session.secret`

### Minecraft Server Process Management

**ServerProcess** (`src/mc/ServerProcess.js`) — EventEmitter wrapping `child_process.spawn`. Manages Java process I/O via readline, keeps last 200 console lines for new WebSocket subscribers, persists logs to `data/servers/<uuid>/logs/craftbox-console.log`. Detects "Done (" in stdout to mark running state. Handles crash detection (OutOfMemoryError), auto-restart on unexpected exit, graceful stop via "stop" command with force-kill fallback. `waitForState()` returns a Promise for waiting on state transitions. Forge servers: 0-byte `.jar` files cleaned up on start.

**ServerManager** (`src/mc/ServerManager.js`) — Singleton registry of ServerProcess instances. Lazy-initializes on demand. `stopAll()` for container shutdown (30s timeout per server).

**BackupManager** (`src/mc/BackupManager.js`) — Stateless utility module for backup operations: `createBackup`, `restoreBackup`, `deleteBackup`, `listBackups`, `applyRetention`, `deleteAllBackups`. Backups are full server directory ZIPs stored in `data/backups/<serverId>/`. Uses `archiver` for creation and `adm-zip` for extraction with zip-slip protection. Concurrent backup lock prevents duplicate operations.

**BackupScheduler** (`src/mc/BackupScheduler.js`) — Singleton managing per-server backup timers. Uses `setInterval` for schedule triggers and `setTimeout` chains for countdown warnings. Countdown sends `say` commands to the MC server chat before stopping for backup. Initialized at boot, stopped during graceful shutdown.

**State Machine** (`src/mc/stateMachine.js`) — `stopped → starting → running → stopping → stopped`, plus `crashed` state. Validates transitions and defines allowed actions per state.

### Server Type Provider Pattern (`src/mc/serverTypes/`)

Each server type exports: metadata (id, name, description, icon, logo), `listVersions()`, `getBuilds(version)`, and `downloadJar(version, build, destPath)`. Providers: vanilla, paper, purpur, folia, fabric, forge, neoforge, custom. Paper/Purpur/Folia share `_paperApiProvider.js`. NeoForge uses the Maven API at `maven.neoforged.net` with an installer pattern similar to Forge. `downloader.js` routes downloads to the correct provider.

### Event Logger (`src/utils/eventLogger.js`)

Stateless utility for structured event recording. `logEvent(serverId, type, message, extra)` writes to `eventsDb`. Event types: `started`, `stopped`, `crashed`, `restarted`, `player_join`, `player_leave`. `pruneEvents()` caps at 500 per server. `deleteServerEvents()` cleans up on server deletion.

### Resource Stats (`src/utils/resourceStats.js`)

Cross-platform utilities: `getProcessMemory(pid)` reads RSS (Windows: `tasklist`, Linux: `/proc/<pid>/status`), `getDirectorySize(dirPath)` recursive sync walk, `getUptime(lastStarted)` seconds from timestamp, `formatSize()`/`formatUptime()` formatters.

### Player Tracking

Built into `ServerProcess._handleLine()`. Regex patterns match `joined the game` / `left the game` log lines. Maintains `this.players` Set. Broadcasts `{ type: 'players' }` WebSocket messages on changes. Players cleared on STOPPED/CRASHED state transitions.

### Java Version Selection (`src/utils/javaVersion.js`)

Maps Minecraft versions to required Java (1.7–1.16→Java 8, 1.17–1.20.4→Java 17, 1.20.5+→Java 21, fallback→Java 25). In Docker, detects Temurin JRE paths; standalone uses system `java`.

### WebSocket (`src/websocket.js`)

Session-authenticated (reuses Express session cookie on upgrade). Protocol: `subscribe`/`unsubscribe`/`command`/`ping` messages. Broadcasts console lines and state changes to subscribers. 30s heartbeat ping, auto-cleanup on disconnect.

### Middleware Stack (order matters)

Security headers (CSP, X-Frame-Options, etc.) → body parsing → express-session (24h, httpOnly, sameSite strict) → Passport → static assets (vendor from node_modules, app from public/) → **public status routes** (no auth/CSRF) → ensureSetup check → CSRF token injection/validation → authenticated routes → 404/500 handlers.

### Security (`src/security.js`)

Hand-rolled (no helmet): CSRF synchronizer tokens (session-stored, validated on POST/PUT/DELETE via `_csrf` body field or `x-csrf-token` header), login rate limiter (5 attempts/15min/IP, in-memory Map), OWASP security headers including CSP.

### Routes (`src/routes/`)

- `auth.js` — `/setup` (one-time admin creation), `/login`, `/logout`
- `dashboard.js` — `/`, `/dashboard` (server list)
- `servers.js` — `/servers/create`, `/servers/:id/*` (view, edit, properties, files, file editor, actions)
- `backups.js` — `/servers/:id/backups` (list, create, restore, download, delete)
- `status.js` — `/status` (public server list), `/status/:id` (individual status, UUID-based), `/status/:id/mods` (mods ZIP download), `/status/:id/api` (JSON). Mounted before auth/CSRF middleware — no login required.
- `api.js` — `/api/servers`, `/api/server-types`, `/api/versions`, toggle endpoints, update checks, backup schedule/retention, `/api/servers/:id/events`, `/api/servers/:id/stats`, `/api/servers/:id/statuspublic`

### Frontend

- **Views** (`views/`): EJS templates with partials (head, foot, navbar, flash, console, serverCard, serverNav)
- **CSS** (`public/css/app.css`): Dark theme (#0e0e10), CSS variables for branding (--craftbox-green), console log-level color coding
- **JS** (`public/js/`): `console.js` handles WebSocket client with exponential backoff reconnection; `create.js`, `edit.js`, `properties.js`, `dashboard.js`, `backups.js` for their respective pages
- **Icons**: Material Icons served from node_modules; SVG server-type logos in `public/img/server-types/`

### Data Directory (`data/`)

Runtime data, Docker-volume-mounted. Contains `craftbox.sqlite`, `servers/<uuid>/` directories (server jars, world data, logs), `backups/<uuid>/` directories (backup ZIP archives). Gitignored.
