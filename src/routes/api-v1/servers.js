const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const StreamZip = require('node-stream-zip');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { serversDb, backupsDb, eventsDb, SERVERS_DIR } = require('../../db');
const { ensureBackupDir, resolveBackupPath } = require('../../mc/BackupManager');
const { getProvider, listProviders } = require('../../mc/serverTypes');
const { downloadServerJar } = require('../../mc/downloader');
const { log } = require('../../utils/log');
const { logEvent } = require('../../utils/eventLogger');
const { getEvents } = require('../../utils/eventLogger');
const { getProcessMemory, getProcessCpu, getDirectorySize, getUptime, formatSize, formatUptime } = require('../../utils/resourceStats');
const { clearStatsHistory, getStatsHistory } = require('../../utils/statsHistory');
const { setServerIcon, resetServerIcon, removeServerIcon, getIconPath, copyDefaultIcon } = require('../../utils/serverIcon');
const { writeServerProperties, writeEula, parseServerProperties, updateServerProperties } = require('../../mc/serverProperties');
const { PROPERTY_META } = require('../../mc/propertyMeta');
const { getContentType } = require('../../utils/contentType');
const { copyModEnvMap, setModEnvMap } = require('../../utils/modEnvironment');
const { isZipFile } = require('../../utils/uploadSafety');
const { createDgupRouter, multerShim } = require('../../middleware/dgup');
const { syncServerConfig } = require('../../mc/syncServerConfig');
const { STATES } = require('../../mc/stateMachine');
const { isPathInside } = require('../../utils/pathSafety');
const { normalizeGroupName, getGroupColor, pruneGroupMetaIfEmpty, GROUP_NAME_ERROR } = require('../../utils/serverGroups');
const { MC_VERSION_RE, isReleaseVersion } = require('../../utils/mcVersion');
const { pickPreferredBuild } = require('../../mc/serverTypes/_channels');
const { cleanupServerData } = require('../../utils/serverCleanup');
const { installModpack, parseMrpack, resolveLoader, pickLoaderFromArray } = require('../../mc/modpackInstaller');
const { assertWhitelistedUrl } = require('../../utils/httpDownload');
const modrinth = require('../../services/modrinth');
const { sendModrinthError } = require('./modrinth');

// Shared 404 helper — returns the server record or sends 404 JSON and returns null.
// The caller must `return` after a null result.
async function loadServerOr404(req, res) {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) {
        res.status(404).json({ error: 'Server not found.' });
        return null;
    }
    return server;
}

// Downgrade guard for version changes (edit + upgrade-jar). Release ids compare
// numerically; snapshot/pre/rc ids don't, so fall back to the provider's
// newest-first version list and compare positions. Ids missing from the list
// are allowed through — the guard is a convenience net, and blocking would
// strand servers whose version has left the upstream listing.
async function isVersionDowngrade(type, currentVersion, newVersion, logLabel) {
    if (isReleaseVersion(currentVersion) && isReleaseVersion(newVersion)) {
        const curParts = currentVersion.split('.').map(Number);
        const newParts = newVersion.split('.').map(Number);
        for (let i = 0; i < Math.max(curParts.length, newParts.length); i++) {
            const diff = (newParts[i] || 0) - (curParts[i] || 0);
            if (diff < 0) return true;
            if (diff > 0) return false;
        }
        return false;
    }
    try {
        const provider = getProvider(type);
        const result = await provider.listVersions({ channel: 'all' });
        const ids = (result?.versions || []).map(v => v.id);
        const curIdx = ids.indexOf(currentVersion);
        const newIdx = ids.indexOf(newVersion);
        if (curIdx !== -1 && newIdx !== -1) return newIdx > curIdx;
        log('warn', `Downgrade check skipped for ${logLabel}: "${currentVersion}" or "${newVersion}" not in the ${type} version list.`);
    } catch (err) {
        log('warn', `Downgrade check skipped for ${logLabel}: ${err.message}`);
    }
    return false;
}

// Best-effort delete — used on failure paths, which must never throw over a
// leftover temp file while they are already handling the real error.
function removeQuietly(target) {
    try {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
        log('warn', `Failed to remove ${target}: ${err.message}`);
    }
}

// Forge/NeoForge keep versioned launcher libraries on disk; move the old tree
// aside before an upgrade so a failed install can be rolled back. Returns null
// for other types (nothing to stash).
function stashLoaderLibraries(type, id, serverName) {
    if (type !== 'forge' && type !== 'neoforge') return null;
    const libSubdir = type === 'neoforge'
        ? path.join(SERVERS_DIR, id, 'libraries', 'net', 'neoforged', 'neoforge')
        : path.join(SERVERS_DIR, id, 'libraries', 'net', 'minecraftforge', 'forge');
    if (!fs.existsSync(libSubdir)) return null;

    const backupPath = libSubdir + '.tmp';
    fs.renameSync(libSubdir, backupPath);
    log('info', `[${serverName}] Moved old ${type} libraries to .tmp before upgrade.`);
    return {
        commit() {
            removeQuietly(backupPath);
        },
        rollback() {
            if (!fs.existsSync(backupPath)) return;
            try {
                // An installer that failed partway has already written a partial
                // tree back at the original path; clear it, or the rename below
                // fails (EEXIST/ENOTEMPTY) and takes the caller's error handling
                // down with it.
                removeQuietly(libSubdir);
                fs.renameSync(backupPath, libSubdir);
                log('info', `[${serverName}] Restored old ${type} libraries after failed upgrade.`);
            } catch (err) {
                // Never throw from a rollback — the caller is mid-failure and
                // still has to reset the server state and report the error.
                log('error', `[${serverName}] Failed to restore old ${type} libraries: ${err.message}`);
            }
        }
    };
}

// An error carrying the HTTP status it should surface as. Lets the mutation
// logic below be shared between a synchronous route response and a background
// task that reports over the WebSocket instead.
function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// Run `apply` behind a restore point: stop the server (a live world can't be
// zipped consistently), back it up, apply the change, then restart if it had
// been running. Because the backup strictly predates every change, restoring it
// undoes the change completely — which a backup taken *after* the save cannot do.
//
// Responds 202 immediately; completion is broadcast as `operation` over the
// WebSocket. If the backup or the change fails, the server is put back the way
// it was found and the failure is broadcast.
async function runWithRestorePoint({ req, res, server, label, operation, apply }) {
    const id = server.id;
    const serverManager = req.app.get('serverManager');
    const initiatedBy = req.user.username;
    const { runBackupJob, tryAcquireBackupLock, releaseBackupLock, formatSize } = require('../../mc/BackupManager');

    if (!tryAcquireBackupLock(id)) {
        return res.status(409).json({ error: 'A backup is already in progress for this server.' });
    }

    let lockOwnedByRoute = true;
    try {
        const proc = serverManager?.getProcess(id);
        const wasRunning = !!proc && ['running', 'starting'].includes(proc.state);
        if (wasRunning) {
            await serverManager.stopServer(id, { initiatedBy });
            await proc.waitForState(STATES.STOPPED, 60000);
        }

        await serverManager.setOperationalState(id, STATES.BACKING_UP);
        lockOwnedByRoute = false; // handed off to the task below
        res.status(202).json({ success: true, status: 'started' });

        (async () => {
            let result;
            try {
                const backup = await runBackupJob(id, label, 'manual');
                logEvent(id, 'action', `${label} created`, { initiatedBy }).catch(() => {});
                serverManager.broadcastOperation(id, 'backup', 'complete', {
                    backup: { ...backup, sizeFormatted: formatSize(backup.size) }
                });
                await serverManager.setOperationalState(id, STATES.STOPPED);

                result = await apply();
            } catch (err) {
                // The backup or the change itself failed, so nothing landed (a failed
                // jar download rolls itself back) — put the server back as we found it.
                log('error', `${operation} with restore point failed for ${id}: ${err.message}`);
                logEvent(id, 'action', `Save failed: ${err.message}`, { initiatedBy }).catch(() => {});
                try {
                    await serverManager.setOperationalState(id, STATES.STOPPED);
                    if (wasRunning) await serverManager.startServer(id, { initiatedBy });
                } catch (restoreErr) {
                    log('error', `Failed to restore run state for ${id}: ${restoreErr.message}`);
                }
                serverManager.broadcastOperation(id, operation, 'failed', err.message);
                return;
            }

            // The change is saved. Bringing the server back up is best-effort from
            // here — a restart that fails is a warning, never a failed save.
            let warning = null;
            if (wasRunning) {
                try {
                    await clearStatsHistory(id);
                    await serverManager.startServer(id, { initiatedBy });
                } catch (err) {
                    warning = `Saved, but the server failed to start: ${err.message}`;
                    log('error', `Restart after ${operation} failed for ${id}: ${err.message}`);
                }
            }
            notifyDashboard(req);
            serverManager.broadcastOperation(id, operation, 'complete', {
                ...result,
                restarted: wasRunning && !warning,
                warning
            });
        })();
    } catch (err) {
        if (lockOwnedByRoute) releaseBackupLock(id);
        log('error', `Restore-point setup failed for ${id}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
}

// Replace an existing server's jar without risking the one it can currently
// run: download into a sidecar and swap only once the provider reports success.
// A failed download — including a checksum mismatch, which makes downloadServerJar
// delete the file it wrote — therefore destroys the sidecar, never the live jar.
// Forge/NeoForge run their installer in the server directory and only write a
// marker at this path, so the swap is correct for them too; their libraries are
// handled separately by stashLoaderLibraries().
// `source` is a version id, or the download URL for custom servers.
async function downloadJarSafely(type, source, jarPath) {
    const tmpPath = jarPath + '.tmp';
    removeQuietly(tmpPath); // stale sidecar from an interrupted run
    try {
        const result = await downloadServerJar(type, source, null, tmpPath);
        if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
        fs.renameSync(tmpPath, jarPath);
        return result;
    } catch (err) {
        removeQuietly(tmpPath);
        throw err;
    }
}

// Notify all open dashboard/group pages that the server list or grouping changed
// so they can live-refresh. `origin` lets the initiating tab skip its own event.
function notifyDashboard(req) {
    req.app.get('serverManager')?.broadcastGlobal?.({
        type: 'dashboard-changed',
        origin: req.get('x-client-id') || null
    });
}

const TEXT_EXTENSIONS = new Set([
    '.txt', '.log', '.properties', '.json', '.yml', '.yaml', '.xml',
    '.cfg', '.conf', '.ini', '.toml', '.csv', '.md', '.sh', '.bat',
    '.cmd', '.ps1', '.js', '.ts', '.py', '.java', '.html', '.css',
    '.mcmeta', '.lang', '.sk', '.nbt'
]);
function isTextFile(filename) {
    return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Transfer archives are .cbx files (a zip container with a Craftbox manifest).
const IMPORT_EXTENSIONS = ['.cbx'];
const IMPORT_EXT_ERROR = 'Only .cbx transfer archives are allowed.';

// Multer config for transfer archive import — no size cap (the archive is
// streamed to disk on upload and streamed out of the zip on extraction, so
// size is bounded by disk space, not memory).
const importUpload = multer({
    dest: os.tmpdir(),
    fileFilter: (_req, file, cb) => {
        const name = file.originalname.toLowerCase();
        if (IMPORT_EXTENSIONS.some(ext => name.endsWith(ext))) {
            cb(null, true);
        } else {
            cb(new Error(IMPORT_EXT_ERROR));
        }
    }
});

// Multer config for .mrpack modpack upload — .mrpack only, 2 GiB cap
const mrpackUpload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.mrpack')) {
            cb(null, true);
        } else {
            cb(new Error('Only .mrpack files are allowed.'));
        }
    }
});

// Multer config for server icon upload — PNG only, 20 MB limit
const iconUpload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype !== 'image/png') {
            return cb(new Error('Only PNG files are allowed.'));
        }
        cb(null, true);
    }
});

// GET /servers — JSON list of all servers
router.get('/servers', async (req, res) => {
    try {
        const all = await serversDb.all();
        const serverManager = req.app.get('serverManager');

        const servers = all.map(row => {
            const s = { ...row.value };
            delete s.directory;
            if (serverManager) {
                const proc = serverManager.getProcess(s.id);
                if (proc) s.state = proc.state;
            }
            return s;
        });

        res.json({ servers });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch servers.' });
    }
});

// GET /servers/:id — JSON single server
router.get('/servers/:id', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const s = { ...server };
        delete s.directory;

        const serverManager = req.app.get('serverManager');
        if (serverManager) {
            const proc = serverManager.getProcess(s.id);
            if (proc) s.state = proc.state;
        }

        res.json({ server: s });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch server.' });
    }
});

// GET /server-types — List available server types
router.get('/server-types', (req, res) => {
    res.json({ types: listProviders() });
});

// GET /versions — Fetch versions for a server type
// (?type=vanilla|paper|...&channel=stable|all — defaults to stable)
router.get('/versions', async (req, res) => {
    const type = req.query.type || 'vanilla';
    const channel = req.query.channel === 'all' ? 'all' : 'stable';
    const provider = getProvider(type);
    if (!provider) {
        return res.status(400).json({ error: `Unknown server type: ${type}` });
    }

    try {
        const result = await provider.listVersions({ channel });
        if (!result) {
            return res.json({ versions: [], latest: null });
        }

        // Providers return newest-first chronological order; keep it verbatim —
        // snapshot ids ("25w03a") have no numeric ordering to re-sort by.
        res.json({ versions: result.versions, latest: result.latest });
    } catch (err) {
        log('error', `Failed to fetch versions for ${type}: ${err.message}`);
        res.status(500).json({ error: `Failed to fetch versions for ${type}.` });
    }
});

// GET /versions/:type/builds/:version — Get builds for a version
router.get('/versions/:type/builds/:version', async (req, res) => {
    const provider = getProvider(req.params.type);
    if (!provider) {
        return res.status(400).json({ error: 'Unknown server type.' });
    }

    try {
        const builds = await provider.getBuilds(req.params.version);
        res.json({ builds: builds || [] });
    } catch (err) {
        log('error', `Failed to fetch builds for ${req.params.type} ${req.params.version}: ${err.message}`);
        res.status(500).json({ error: 'Failed to fetch builds.' });
    }
});

// POST /servers/:id/autorestart — Toggle auto-restart
router.post('/servers/:id/autorestart', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        server.autoRestart = !!req.body.enabled;
        await serversDb.set(`server_${server.id}`, server);

        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        if (proc) proc.config.autoRestart = server.autoRestart;

        res.json({ autoRestart: server.autoRestart });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// POST /servers/:id/autostart — Toggle auto-start
router.post('/servers/:id/autostart', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        server.autoStart = !!req.body.enabled;
        await serversDb.set(`server_${server.id}`, server);

        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        if (proc) proc.config.autoStart = server.autoStart;

        res.json({ autoStart: server.autoStart });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// POST /servers/:id/group — Assign the server to a dashboard group (null/empty to ungroup)
router.post('/servers/:id/group', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const { valid, value } = normalizeGroupName(req.body.group);
        if (!valid) {
            return res.status(400).json({ error: GROUP_NAME_ERROR });
        }

        const previousGroup = server.group || null;
        server.group = value;
        await serversDb.set(`server_${server.id}`, server);

        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        if (proc) proc.config.group = server.group;

        // Groups are implicit — drop the old group's stored color if it emptied.
        // Best-effort: the move already persisted, so a prune failure must not
        // fail the request.
        if (previousGroup && previousGroup !== server.group) {
            try {
                await pruneGroupMetaIfEmpty(previousGroup);
            } catch (err) {
                log('error', `Group cleanup failed for "${previousGroup}": ${err.message}`);
            }
        }

        const color = server.group ? await getGroupColor(server.group) : null;
        if (previousGroup !== server.group) {
            log('info', server.group
                ? `Server "${server.name}" (${server.id}) moved to group "${server.group}"${previousGroup ? ` (was "${previousGroup}")` : ''}`
                : `Server "${server.name}" (${server.id}) removed from group "${previousGroup}"`);
        }
        notifyDashboard(req);
        res.json({ group: server.group, color });
    } catch (err) {
        log('error', `Failed to update group for ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// GET /servers/:id/check-upgrade — Check if a newer build is available
router.get('/servers/:id/check-upgrade', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const type = server.serverType || 'vanilla';
        const provider = getProvider(type);
        if (!provider) return res.json({ upgradeAvailable: false });

        if (!provider.getBuilds || type === 'custom') {
            return res.json({ upgradeAvailable: false, reason: 'No build tracking for this server type.' });
        }

        const builds = await provider.getBuilds(server.version);
        if (!builds || builds.length === 0) {
            return res.json({ upgradeAvailable: false });
        }

        // getBuilds now includes non-stable channels — prefer the newest
        // stable build so stable servers aren't offered ALPHA/BETA builds.
        const preferred = pickPreferredBuild(builds);
        const latestBuild = preferred.build;
        const currentBuild = server.build;

        if (currentBuild == null) {
            return res.json({
                upgradeAvailable: false,
                latestBuild,
                currentBuild: null,
                reason: 'No build number recorded for this server.'
            });
        }

        const upgradeAvailable = latestBuild !== currentBuild && latestBuild > currentBuild;
        res.json({
            upgradeAvailable,
            currentBuild,
            latestBuild,
            channel: preferred.channel || null
        });
    } catch (err) {
        log('error', `Check-upgrade failed for ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: 'Failed to check for updates.' });
    }
});

// POST /servers/:id/upgrade-jar — Kick off a jar download. Returns 202 immediately;
// completion is reported via the per-server WebSocket as
// { type: 'operation', operation: 'jar-upgrade', status: 'complete'|'failed', ... }.
router.post('/servers/:id/upgrade-jar', async (req, res) => {
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        return res.status(409).json({ error: 'Stop the server before upgrading the jar.' });
    }

    const type = server.serverType || 'vanilla';
    const provider = getProvider(type);
    if (!provider) return res.status(400).json({ error: 'Unknown server type.' });

    // Optional version upgrade in the same operation (edit page "Accept Risk"
    // flow) — same rules as the edit endpoint: format check, upgrades only.
    // Custom servers have no tracked version; they upgrade by jar URL instead.
    const targetVersion = String(req.body?.version || '').trim();
    const targetUrl = String(req.body?.jarUrl || '').trim();
    let isVersionChange = false;

    if (type === 'custom') {
        if (!targetUrl) {
            return res.status(400).json({ error: 'Custom servers upgrade by URL — provide jarUrl.' });
        }
        try {
            const parsed = new URL(targetUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        } catch {
            return res.status(400).json({ error: 'Invalid jar download URL.' });
        }
    } else {
        isVersionChange = !!targetVersion && targetVersion !== server.version;
        if (isVersionChange) {
            if (!MC_VERSION_RE.test(targetVersion)) {
                return res.status(400).json({ error: 'Invalid version format.' });
            }
            if (await isVersionDowngrade(type, server.version, targetVersion, server.id)) {
                return res.status(400).json({ error: 'Version downgrades are not permitted.' });
            }
        }
    }

    const initiatedBy = req.user.username;

    // Optional pre-upgrade backup — mirrors the restart-with-backup flow:
    // claim the backup lock synchronously so the 409 happens before the 202.
    const backupFirst = req.body?.backup === true || req.body?.backup === 'true';
    const { runBackupJob, tryAcquireBackupLock, releaseBackupLock, formatSize } = require('../../mc/BackupManager');
    if (backupFirst && !tryAcquireBackupLock(server.id)) {
        return res.status(409).json({ error: 'A backup is already in progress for this server.' });
    }

    let lockOwnedByRoute = backupFirst;
    try {
        await serverManager.setOperationalState(server.id, backupFirst ? STATES.BACKING_UP : STATES.UPGRADING_JAR);
        lockOwnedByRoute = false;
        res.status(202).json({ success: true, status: 'started' });

        (async () => {
            let libStash = null;
            try {
                if (backupFirst) {
                    const backup = await runBackupJob(server.id, 'Pre-upgrade backup', 'manual');
                    logEvent(server.id, 'action', 'Pre-upgrade backup created', { initiatedBy }).catch(() => {});
                    serverManager.broadcastOperation(server.id, 'backup', 'complete', {
                        backup: { ...backup, sizeFormatted: formatSize(backup.size) }
                    });
                    await serverManager.setOperationalState(server.id, STATES.STOPPED);
                    await serverManager.setOperationalState(server.id, STATES.UPGRADING_JAR);
                }

                libStash = isVersionChange ? stashLoaderLibraries(type, server.id, server.name) : null;
                const jarPath = path.join(SERVERS_DIR, server.id, server.jarFile || 'server.jar');
                const source = type === 'custom'
                    ? targetUrl
                    : (isVersionChange ? targetVersion : server.version);
                const result = await downloadJarSafely(type, source, jarPath);
                libStash?.commit();

                const fresh = await serversDb.get(`server_${server.id}`);
                if (fresh) {
                    if (type === 'custom') fresh.customJarUrl = targetUrl;
                    if (isVersionChange) fresh.version = targetVersion;
                    if (result?.build) fresh.build = result.build;
                    fresh.javaMajor = result?.javaMajor || null;
                    await serversDb.set(`server_${server.id}`, fresh);
                    const freshProc = serverManager?.getProcess(server.id);
                    if (freshProc) Object.assign(freshProc.config, fresh);
                }

                await serverManager.setOperationalState(server.id, STATES.STOPPED);
                const doneMsg = type === 'custom'
                    ? 'Jar replaced from new URL'
                    : isVersionChange
                        ? `Upgraded from ${server.version} to ${targetVersion}${result?.build ? ` (build ${result.build})` : ''}`
                        : `Jar upgraded to build ${result?.build || 'latest'}`;
                logEvent(server.id, 'jar_upgrade', doneMsg, { initiatedBy }).catch(() => {});
                log('info', `Server "${server.name}": ${doneMsg}.`);
                if (isVersionChange) notifyDashboard(req);
                serverManager.broadcastOperation(server.id, 'jar-upgrade', 'complete', {
                    build: result?.build || null,
                    version: isVersionChange ? targetVersion : server.version
                });
            } catch (err) {
                libStash?.rollback();
                log('error', `Jar upgrade failed for ${server.id}: ${err.message}`);
                logEvent(server.id, 'jar_upgrade_fail', `Jar upgrade failed: ${err.message}`, { initiatedBy }).catch(() => {});
                try {
                    await serverManager.setOperationalState(server.id, STATES.STOPPED);
                } catch (_) {}
                serverManager.broadcastOperation(server.id, 'jar-upgrade', 'failed', err.message);
            }
        })();
    } catch (err) {
        if (lockOwnedByRoute) releaseBackupLock(server.id);
        log('error', `Jar upgrade setup failed for ${req.params.id}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to upgrade jar: ${err.message}` });
        }
    }
});

// POST /servers/:id/backup-schedule — Update backup schedule settings
router.post('/servers/:id/backup-schedule', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const { enabled, intervalHours, countdownMinutes } = req.body;

        if (!server.backupSchedule) {
            server.backupSchedule = {
                enabled: false,
                intervalHours: 24,
                countdownMinutes: 5,
                retentionCount: 5,
                retentionDays: 0
            };
        }

        if (typeof enabled === 'boolean') server.backupSchedule.enabled = enabled;
        if (intervalHours != null) {
            const h = parseInt(intervalHours, 10);
            if (h >= 1 && h <= 168) server.backupSchedule.intervalHours = h;
        }
        if (countdownMinutes != null) {
            const m = parseInt(countdownMinutes, 10);
            if (m >= 1 && m <= 30) server.backupSchedule.countdownMinutes = m;
        }

        delete server.backupSchedule.nextBackupAt;

        await serversDb.set(`server_${server.id}`, server);

        const backupScheduler = req.app.get('backupScheduler');
        if (backupScheduler) {
            if (server.backupSchedule.enabled) {
                await backupScheduler.restartSchedule(server.id);
            } else {
                backupScheduler.stopSchedule(server.id);
            }
        }

        const nextBackupAt = backupScheduler?.getNextBackupTime(server.id);
        res.json({
            backupSchedule: server.backupSchedule,
            nextBackupAt: nextBackupAt ? nextBackupAt.toISOString() : null
        });
    } catch (err) {
        log('error', `Failed to update backup schedule: ${err.message}`);
        res.status(500).json({ error: 'Failed to update backup schedule.' });
    }
});

// POST /servers/:id/backup-retention — Update retention policy
router.post('/servers/:id/backup-retention', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        if (!server.backupSchedule) {
            server.backupSchedule = {
                enabled: false,
                intervalHours: 24,
                countdownMinutes: 5,
                retentionCount: 5,
                retentionDays: 0
            };
        }

        const { retentionCount, retentionDays } = req.body;
        if (retentionCount != null) {
            const n = parseInt(retentionCount, 10);
            if (n >= 0 && n <= 100) server.backupSchedule.retentionCount = n;
        }
        if (retentionDays != null) {
            const d = parseInt(retentionDays, 10);
            if (d >= 0 && d <= 365) server.backupSchedule.retentionDays = d;
        }

        await serversDb.set(`server_${server.id}`, server);
        res.json({ backupSchedule: server.backupSchedule });
    } catch (err) {
        log('error', `Failed to update backup retention: ${err.message}`);
        res.status(500).json({ error: 'Failed to update retention policy.' });
    }
});

// GET /servers/:id/events — Event history for a server
router.get('/servers/:id/events', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const types = req.query.types ? req.query.types.split(',') : null;
        const events = await getEvents(server.id, { limit, types });

        res.json({ events });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch events.' });
    }
});

// GET /servers/:id/stats — Resource stats for a server
router.get('/servers/:id/stats', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const serverManager = req.app.get('serverManager');
        const statsCollector = req.app.get('statsCollector');
        const proc = serverManager?.getProcess(server.id);

        const cached = statsCollector?.getLatestStats(server.id);

        let stats;
        if (cached && proc && proc.state === 'running') {
            stats = { ...cached };
            stats.uptime = getUptime(server.lastStarted);
            stats.uptimeFormatted = formatUptime(stats.uptime);
            stats.playerCount = proc.players.size;
            stats.players = Array.from(proc.players);
        } else {
            stats = {
                state: proc?.state || server.state,
                uptime: 0,
                uptimeFormatted: 'Offline',
                cpuPercent: null,
                memoryBytes: null,
                memoryFormatted: null,
                memoryAllocatedMb: server.memory || 2048,
                diskBytes: null,
                diskFormatted: null,
                playerCount: 0,
                players: []
            };

            if (proc && proc.state === 'running') {
                stats.uptime = getUptime(server.lastStarted);
                stats.uptimeFormatted = formatUptime(stats.uptime);
                stats.playerCount = proc.players.size;
                stats.players = Array.from(proc.players);

                if (proc.child?.pid) {
                    stats.memoryBytes = getProcessMemory(proc.child.pid);
                    if (stats.memoryBytes) {
                        stats.memoryFormatted = formatSize(stats.memoryBytes);
                    }
                    stats.cpuPercent = getProcessCpu(proc.child.pid);
                    if (stats.cpuPercent !== null) {
                        stats.cpuPercent = Math.round(stats.cpuPercent * 10) / 10;
                    }
                }
            }
        }

        const serverDir = path.resolve(server.directory);
        stats.diskBytes = getDirectorySize(serverDir);
        stats.diskFormatted = formatSize(stats.diskBytes);

        const history = await getStatsHistory(server.id);
        res.json({ stats, history });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// POST /servers/:id/statuspublic — Toggle status page visibility
router.post('/servers/:id/statuspublic', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        server.statusPagePublic = !!req.body.enabled;
        await serversDb.set(`server_${server.id}`, server);

        res.json({ statusPagePublic: server.statusPagePublic });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// POST /servers/:id/advertisedip — Update advertised IP
router.post('/servers/:id/advertisedip', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        server.advertisedIp = String(req.body.value || '').trim() || null;
        await serversDb.set(`server_${server.id}`, server);

        res.json({ advertisedIp: server.advertisedIp });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// Shared by the multipart route and the DGUP complete step, which synthesizes
// an identical req.file — the response body is the same either way.
const uploadIconHandler = async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        await setServerIcon(req.params.id, req.file.path);
        fs.unlink(req.file.path, () => {});

        log('info', `Server "${server.name}" icon updated.`);
        res.json({ success: true });
    } catch (err) {
        if (req.file) fs.unlink(req.file.path, () => {});
        // sharp throws on bytes it cannot decode — that's a client problem,
        // not a server fault.
        if (/unsupported image|input buffer|input file/i.test(err.message || '')) {
            log('warn', `Icon upload rejected ("${req.file?.originalname || 'unknown'}"): not a decodable image`);
            return res.status(400).json({ error: 'Not a valid image.' });
        }
        log('error', `Failed to update server icon: ${err.message}`);
        res.status(500).json({ error: 'Failed to update server icon.' });
    }
};

// POST /servers/:id/icon — Upload server icon (single multipart request)
router.post('/servers/:id/icon', multerShim(iconUpload.single('icon')), uploadIconHandler);

// POST /servers/:id/icon/upload/{init,chunk,complete,cancel} — DGUP chunked icon upload
router.use('/servers/:id/icon/upload', createDgupRouter({
    routeKey: 'icon',
    field: 'icon',
    fileMode: 'single',
    maxBytes: 20 * 1024 * 1024,
    ext: ['.png'],
    extError: 'Only PNG files are allowed.',
    mimetype: 'image/png',
    validate: async (req) => {
        const server = await serversDb.get(`server_${req.params.id}`);
        return server ? null : { status: 404, error: 'Server not found.' };
    }
}, uploadIconHandler));

// POST /servers/:id/icon/reset — Reset server icon to Craftbox default
router.post('/servers/:id/icon/reset', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const success = resetServerIcon(req.params.id);
        if (!success) {
            return res.status(500).json({ error: 'Default icon not found.' });
        }

        log('info', `Server "${server.name}" icon reset to default.`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to reset server icon: ${err.message}`);
        res.status(500).json({ error: 'Failed to reset server icon.' });
    }
});

// GET /servers/:id/icon — Get current server icon (binary PNG)
router.get('/servers/:id/icon', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const iconPath = getIconPath(req.params.id);
        if (!fs.existsSync(iconPath)) {
            return res.status(404).json({ error: 'No icon set.' });
        }

        const serverDir = path.resolve(SERVERS_DIR, req.params.id);
        if (!isPathInside(serverDir, iconPath)) {
            return res.status(403).json({ error: 'Access denied.' });
        }

        res.type('image/png').sendFile(path.resolve(iconPath));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch icon.' });
    }
});

// DELETE /servers/:id/icon — Remove server icon entirely
router.delete('/servers/:id/icon', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        removeServerIcon(req.params.id);

        log('info', `Server "${server.name}" icon removed.`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to remove server icon: ${err.message}`);
        res.status(500).json({ error: 'Failed to remove server icon.' });
    }
});

// POST /servers/:id/motd — Update server MOTD
router.post('/servers/:id/motd', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const rawMotd = String(req.body.motd ?? 'A Minecraft Server');
        const motd = rawMotd.replace(/[^\x00-\x7F]/g, ch => {
            const hex = ch.charCodeAt(0).toString(16).padStart(4, '0');
            return '\\u' + hex;
        });
        const serverDir = path.join(SERVERS_DIR, server.id);
        updateServerProperties(serverDir, { motd });

        log('info', `Server "${server.name}" MOTD updated.`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to update MOTD: ${err.message}`);
        res.status(500).json({ error: 'Failed to update MOTD.' });
    }
});

// ═══════════════════════════════════════════
// Lifecycle mutations
// ═══════════════════════════════════════════

// Shared field validation for every server-creation route (create,
// from-modpack, from-mrpack) so the rules cannot drift apart.
// Returns { error } on failure, otherwise the normalized values.
function validateBaseServerFields(body) {
    const { name, port, memory, javaArgs, eula, gamemode, difficulty, seed, group } = body || {};

    if (!name || !port || !memory) {
        return { error: 'All required fields must be filled.' };
    }

    const trimmedName = String(name).trim();
    if (trimmedName.length < 1 || trimmedName.length > 50) {
        return { error: 'Server name must be 1-50 characters.' };
    }
    if (!/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        return { error: 'Server name can only contain letters, numbers, spaces, hyphens, and underscores.' };
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        return { error: 'Port must be between 1024 and 65535.' };
    }

    const memoryNum = parseInt(memory, 10);
    if (isNaN(memoryNum) || memoryNum < 512 || memoryNum > 65536) {
        return { error: 'Memory must be between 512 and 65536 MB.' };
    }

    // Multipart/DGUP requests carry eula as the string 'true'/'false'
    if (!eula || eula === 'false') {
        return { error: 'You must accept the Minecraft EULA.' };
    }

    const validGamemodes = ['survival', 'creative', 'adventure', 'spectator'];
    const validDifficulties = ['peaceful', 'easy', 'normal', 'hard'];

    const groupResult = normalizeGroupName(group);
    if (!groupResult.valid) {
        return { error: GROUP_NAME_ERROR };
    }

    return {
        trimmedName,
        portNum,
        memoryNum,
        safeJavaArgs: String(javaArgs || '').trim(),
        gamemodeStr: validGamemodes.includes(gamemode) ? gamemode : 'survival',
        difficultyStr: validDifficulties.includes(difficulty) ? difficulty : 'easy',
        seedStr: String(seed || '').trim(),
        group: groupResult.value
    };
}

// POST /servers — Create a new server
router.post('/servers', async (req, res) => {
    const { version, serverType, customJarUrl } = req.body;

    const base = validateBaseServerFields(req.body);
    if (base.error) {
        return res.status(400).json({ error: base.error });
    }
    const { trimmedName, portNum, memoryNum, safeJavaArgs, gamemodeStr, difficultyStr, seedStr } = base;

    const type = serverType || 'vanilla';
    const provider = getProvider(type);
    if (!provider) {
        return res.status(400).json({ error: 'Invalid server type.' });
    }

    if (type === 'custom') {
        if (!customJarUrl || typeof customJarUrl !== 'string' || customJarUrl.trim().length === 0) {
            return res.status(400).json({ error: 'A download URL is required for custom server jars.' });
        }
        try {
            const parsed = new URL(customJarUrl.trim());
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        } catch {
            return res.status(400).json({ error: 'Invalid jar download URL.' });
        }
    }

    const versionStr = String(version || '').trim();
    if (type !== 'custom') {
        if (!versionStr || (!MC_VERSION_RE.test(versionStr) && versionStr !== 'latest')) {
            return res.status(400).json({ error: 'Invalid Minecraft version format.' });
        }
    }

    const id = uuidv4();
    const serverDir = path.join(SERVERS_DIR, id);
    const initiatedBy = req.user.username;

    try {
        const logsDir = path.join(serverDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });

        const contentType = getContentType(type);
        if (contentType) {
            fs.mkdirSync(path.join(serverDir, contentType.folder), { recursive: true });
        }

        copyDefaultIcon(id);
        log('info', `Creating server "${trimmedName}" (${id}) — ${type} ${type === 'custom' ? '' : versionStr}`);

        // Record the server in DB up front in PROVISIONING state. The user will be
        // redirected to /servers/:id and can subscribe via WebSocket while the jar
        // downloads in the background.
        const server = {
            id,
            name: trimmedName,
            serverType: type,
            build: null,
            state: STATES.PROVISIONING,
            port: portNum,
            memory: memoryNum,
            javaArgs: safeJavaArgs,
            version: versionStr,
            gamemode: gamemodeStr,
            difficulty: difficultyStr,
            seed: seedStr,
            customJarUrl: type === 'custom' ? customJarUrl.trim() : null,
            jarFile: 'server.jar',
            eula: true,
            autoRestart: false,
            autoStart: false,
            statusPagePublic: false,
            group: base.group,
            createdAt: new Date().toISOString(),
            lastStarted: null,
            lastStopped: null,
            exitCode: null,
            crashReason: null,
            directory: path.join('data', 'servers', id)
        };

        await serversDb.set(`server_${id}`, server);

        notifyDashboard(req);
        res.status(201).json({ success: true, server });

        const serverManager = req.app.get('serverManager');
        (async () => {
            try {
                const jarVersion = type === 'custom' ? customJarUrl.trim() : versionStr;
                const downloadResult = await downloadServerJar(type, jarVersion, null, path.join(serverDir, 'server.jar'));

                writeServerProperties(serverDir, {
                    serverPort: portNum,
                    gamemode: gamemodeStr,
                    difficulty: difficultyStr,
                    levelSeed: seedStr
                });
                writeEula(serverDir);

                const fresh = await serversDb.get(`server_${id}`);
                if (fresh) {
                    fresh.build = downloadResult?.build || null;
                    fresh.javaMajor = downloadResult?.javaMajor || null;
                    fresh.state = STATES.STOPPED;
                    await serversDb.set(`server_${id}`, fresh);
                }

                if (serverManager) {
                    await serverManager.setOperationalState(id, STATES.STOPPED);
                    serverManager.broadcastOperation(id, 'create', 'complete', {
                        build: downloadResult?.build || null
                    });
                }
                logEvent(id, 'action', 'Server created', { initiatedBy }).catch(() => {});
                log('info', `Server "${trimmedName}" (${id}) provisioned successfully.`);
            } catch (err) {
                log('error', `Failed to provision server "${trimmedName}" (${id}): ${err.message}`);
                await markProvisionFailed(req, id, 'create', err.message, 'Provisioning failed');
            }
        })();
    } catch (err) {
        log('error', `Failed to create server: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to create server: ${err.message}` });
        }
    }
});

// A server that failed provisioning is useless half-built state. Rather than
// leave it parked in CRASHED for the user to puzzle over, flag it as a failed
// provision: the console page shows a blocking "Server Setup Failed" modal —
// rendered from this persisted state on page load AND pushed live over the
// WebSocket — and the modal deletes the server on the user's behalf.
//
// The record is deliberately KEPT here rather than deleted. Deleting now would
// race the client's page load / WebSocket subscribe: a fast failure (e.g. a
// Folia version with no stable build) throws before any subscriber exists, so
// the live broadcast reaches nobody and an immediate delete leaves the
// freshly-loaded page with a 404 and no way to explain what happened.
//
// Import/duplicate failures keep the ordinary crash banner instead — their
// on-disk state comes from user archives and may be worth inspecting.
// Grace period before a failed-provision server is auto-removed. Long enough
// not to race a normal console-page load (whose modal deletes it immediately),
// short enough to feel like automatic cleanup for a user who never opens it.
const PROVISION_FAIL_PURGE_MS = 10000;

async function markProvisionFailed(req, id, operation, errMessage, crashPrefix) {
    const serverManager = req.app.get('serverManager');
    const crashReason = `${crashPrefix}: ${errMessage}`;

    if (serverManager) {
        try {
            await serverManager.setOperationalState(id, STATES.CRASHED, { crashReason });
        } catch (_) { /* ignore */ }
    }
    // Flag it so the console page shows the failure MODAL (auto-delete flow)
    // rather than the ordinary crash banner. Written after setOperationalState
    // so it survives that call's own state write.
    const fresh = await serversDb.get(`server_${id}`);
    if (fresh) {
        fresh.provisionFailed = true;
        await serversDb.set(`server_${id}`, fresh);
    }
    logEvent(id, 'action', crashReason, { initiatedBy: req.user.username }).catch(() => {});
    if (serverManager) serverManager.broadcastOperation(id, operation, 'failed', errMessage);
    notifyDashboard(req);
    log('info', `Server ${id} flagged as failed provisioning: ${errMessage}`);

    // Safety net: if nobody opens the console page (its modal deletes the
    // server on the user's behalf), auto-purge after the grace period. A
    // present user's delete usually wins, making this a no-op.
    const timer = setTimeout(async () => {
        try {
            const current = await serversDb.get(`server_${id}`);
            if (!current || !current.provisionFailed) return; // already removed
            serverManager?.removeProcess(id);
            req.app.get('backupScheduler')?.stopSchedule(id);
            await serversDb.delete(`server_${id}`);
            notifyDashboard(req);
            await cleanupServerData(id, current.group);
            log('info', `Auto-removed failed-provision server ${id} after grace period.`);
        } catch (err) {
            log('error', `Auto-removal of failed server ${id} failed: ${err.message}`);
        }
    }, PROVISION_FAIL_PURGE_MS);
    timer.unref?.(); // don't keep the process alive for this
}

// ── Modpack server creation (Modrinth) ──

// Builds the DB record both modpack creation routes share. Same shape as the
// plain create route plus the modpack metadata block (kept for a future
// "update modpack" feature).
function buildModpackServerRecord({ id, base, serverType, version, modpackMeta }) {
    return {
        id,
        name: base.trimmedName,
        serverType,
        build: null,
        state: STATES.PROVISIONING,
        port: base.portNum,
        memory: base.memoryNum,
        javaArgs: base.safeJavaArgs,
        version,
        gamemode: base.gamemodeStr,
        difficulty: base.difficultyStr,
        seed: base.seedStr,
        customJarUrl: null,
        jarFile: 'server.jar',
        eula: true,
        autoRestart: false,
        autoStart: false,
        statusPagePublic: false,
        group: base.group,
        createdAt: new Date().toISOString(),
        lastStarted: null,
        lastStopped: null,
        exitCode: null,
        crashReason: null,
        directory: path.join('data', 'servers', id),
        modpack: modpackMeta
    };
}

// Background provisioning shared by both modpack creation routes. Runs after
// the 201 response; streams per-phase progress over the 'modpack-install'
// operation and finishes with STOPPED + complete or CRASHED + failed, exactly
// like the plain create flow.
async function provisionModpackServer({ req, id, serverDir, name, base, mrpack, iconUrl, cleanup }) {
    const serverManager = req.app.get('serverManager');
    const initiatedBy = req.user.username;
    try {
        const result = await installModpack({
            serverId: id,
            serverDir,
            mrpack,
            baseConfig: {
                port: base.portNum,
                gamemode: base.gamemodeStr,
                difficulty: base.difficultyStr,
                seed: base.seedStr
            },
            iconUrl,
            onProgress: (phase, done, total) => {
                serverManager?.broadcastOperation(id, 'modpack-install', 'progress', { phase, done, total });
            }
        });

        // Client-only mods were installed pre-disabled — tag them so the
        // /plugins page shows them as Client Only and the status page offers
        // them in its mods download. The server dir is new, so no merge needed.
        if (result.clientOnlyMods.length > 0) {
            await setModEnvMap(id, Object.fromEntries(
                result.clientOnlyMods.map(name => [name, 'client'])
            ));
        }

        // The manifest is authoritative for loader + MC version; the record's
        // provisional values (from Modrinth version metadata) are replaced.
        const fresh = await serversDb.get(`server_${id}`);
        if (fresh) {
            fresh.serverType = result.serverType;
            fresh.version = result.mcVersion;
            fresh.build = result.build;
            fresh.javaMajor = result.javaMajor || null;
            fresh.state = STATES.STOPPED;
            if (fresh.modpack) {
                fresh.modpack.installedAt = new Date().toISOString();
                if (!fresh.modpack.name) fresh.modpack.name = result.manifestName;
                if (!fresh.modpack.versionNumber) fresh.modpack.versionNumber = result.manifestVersionId;
            }
            await serversDb.set(`server_${id}`, fresh);
        }

        if (serverManager) {
            await serverManager.setOperationalState(id, STATES.STOPPED);
            serverManager.broadcastOperation(id, 'modpack-install', 'complete', {
                build: result.build,
                warnings: result.warnings
            });
        }
        const packLabel = result.manifestName || 'modpack';
        const clientNote = result.clientOnlyMods.length > 0
            ? `, ${result.clientOnlyMods.length} client-only`
            : '';
        const summary = `${result.filesInstalled} files, ${result.modsInstalled} mods${clientNote}`;
        logEvent(id, 'action', `Installed modpack "${packLabel}"${result.manifestVersionId ? ` ${result.manifestVersionId}` : ''} (${summary})`, { initiatedBy }).catch(() => {});
        log('info', `Server "${name}" (${id}) provisioned from modpack "${packLabel}" (${summary}).`);
    } catch (err) {
        log('error', `Modpack install failed for "${name}" (${id}): ${err.message}`);
        await markProvisionFailed(req, id, 'modpack-install', err.message, 'Modpack install failed');
    } finally {
        if (cleanup) cleanup();
    }
}

// POST /servers/from-modpack — Create a server from a Modrinth modpack.
// The client sends only { projectId, versionId } plus the base fields; all
// pack metadata is re-fetched server-side so it cannot be spoofed.
router.post('/servers/from-modpack', async (req, res) => {
    const base = validateBaseServerFields(req.body);
    if (base.error) {
        return res.status(400).json({ error: base.error });
    }

    const { projectId, versionId } = req.body;
    if (typeof projectId !== 'string' || !modrinth.ID_RE.test(projectId)
        || typeof versionId !== 'string' || !modrinth.ID_RE.test(versionId)) {
        return res.status(400).json({ error: 'Invalid modpack reference.' });
    }

    let project, version;
    try {
        project = await modrinth.getProject(projectId);
        version = await modrinth.getVersion(versionId);
    } catch (err) {
        return sendModrinthError(res, err);
    }

    if (project.project_type !== 'modpack') {
        return res.status(400).json({ error: 'That Modrinth project is not a modpack.' });
    }
    if (version.project_id !== project.id) {
        return res.status(400).json({ error: 'That version does not belong to the selected modpack.' });
    }
    if (modrinth.isQuiltOnly(version.loaders)) {
        return res.status(400).json({ error: 'Quilt modpacks are not supported by Craftbox.' });
    }
    const serverType = pickLoaderFromArray(version.loaders);
    if (!serverType) {
        return res.status(400).json({ error: 'This modpack does not target a supported server loader (Fabric, Forge, or NeoForge).' });
    }

    const file = (version.files || []).find(f => f.primary) || (version.files || [])[0];
    if (!file || !/\.mrpack$/i.test(file.filename || '')) {
        return res.status(400).json({ error: 'This modpack version has no installable .mrpack package.' });
    }
    try {
        assertWhitelistedUrl(file.url);
    } catch {
        return res.status(400).json({ error: 'This modpack version has no allowed download source.' });
    }

    const id = uuidv4();
    const serverDir = path.join(SERVERS_DIR, id);

    try {
        fs.mkdirSync(path.join(serverDir, 'logs'), { recursive: true });
        fs.mkdirSync(path.join(serverDir, getContentType(serverType).folder), { recursive: true });
        copyDefaultIcon(id);

        const server = buildModpackServerRecord({
            id,
            base,
            serverType,
            version: String((version.game_versions || [])[0] || ''),
            modpackMeta: {
                projectId: project.id,
                versionId: version.id,
                name: project.title,
                versionNumber: version.version_number,
                iconUrl: project.icon_url || null,
                source: 'modrinth',
                installedAt: null
            }
        });
        await serversDb.set(`server_${id}`, server);

        log('info', `Creating server "${base.trimmedName}" (${id}) from Modrinth modpack "${project.title}" ${version.version_number}`);
        notifyDashboard(req);
        res.status(201).json({ success: true, server });

        provisionModpackServer({
            req,
            id,
            serverDir,
            name: base.trimmedName,
            base,
            mrpack: { url: file.url, sha512: file.hashes?.sha512 || null },
            iconUrl: project.icon_url || null
        });
    } catch (err) {
        log('error', `Failed to create server from modpack: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to create server: ${err.message}` });
        }
    }
});

// POST /servers/from-mrpack — Create a server from an uploaded .mrpack file.
// Shared by the single multipart route and the DGUP chunked mount below; the
// pack is parsed and the loader resolved BEFORE any record exists so a
// malformed or Quilt pack fails with a clean 400.
const createFromMrpackHandler = async (req, res) => {
    const tmpPath = req.file?.path;
    const cleanupTemp = () => {
        if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
    };
    const rejectUpload = (status, message) => {
        log('warn', `Modpack upload rejected ("${req.file?.originalname || 'unknown'}"): ${message}`);
        return res.status(status).json({ error: message });
    };

    if (!tmpPath) {
        return rejectUpload(400, 'No modpack uploaded.');
    }

    const base = validateBaseServerFields(req.body);
    if (base.error) {
        cleanupTemp();
        return rejectUpload(400, base.error);
    }

    if (!isZipFile(tmpPath)) {
        cleanupTemp();
        return rejectUpload(400, 'Not a valid .mrpack file.');
    }

    let manifest;
    let loaderInfo;
    try {
        const parsed = await parseMrpack(tmpPath);
        manifest = parsed.manifest;
        // installModpack reopens the archive itself — close this handle so the
        // background phase has sole ownership.
        try { await parsed.zip.close(); } catch { /* ignore */ }
        loaderInfo = resolveLoader(manifest.dependencies);
    } catch (err) {
        cleanupTemp();
        return rejectUpload(400, err.message);
    }

    const id = uuidv4();
    const serverDir = path.join(SERVERS_DIR, id);

    try {
        fs.mkdirSync(path.join(serverDir, 'logs'), { recursive: true });
        fs.mkdirSync(path.join(serverDir, getContentType(loaderInfo.serverType).folder), { recursive: true });
        copyDefaultIcon(id);

        const server = buildModpackServerRecord({
            id,
            base,
            serverType: loaderInfo.serverType,
            version: loaderInfo.mcVersion,
            modpackMeta: {
                projectId: null,
                versionId: null,
                name: manifest.name || null,
                versionNumber: manifest.versionId || null,
                iconUrl: null,
                source: 'file',
                installedAt: null
            }
        });
        await serversDb.set(`server_${id}`, server);

        log('info', `Creating server "${base.trimmedName}" (${id}) from uploaded modpack "${manifest.name || req.file.originalname}"`);
        notifyDashboard(req);
        res.status(201).json({ success: true, server });

        provisionModpackServer({
            req,
            id,
            serverDir,
            name: base.trimmedName,
            base,
            mrpack: { localPath: tmpPath },
            iconUrl: null,
            cleanup: cleanupTemp
        });
    } catch (err) {
        cleanupTemp();
        log('error', `Failed to create server from uploaded modpack: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to create server: ${err.message}` });
        }
    }
};

router.post('/servers/from-mrpack', multerShim(mrpackUpload.single('mrpack')), createFromMrpackHandler);

// POST /servers/from-mrpack/upload/{init,chunk,complete,cancel} — DGUP chunked
// upload for .mrpack files too large for a single request (e.g. behind
// Cloudflare Tunnel's 100 MB body cap). complete() runs the handler unchanged;
// the base form fields arrive in the complete request body.
router.use('/servers/from-mrpack/upload', createDgupRouter({
    routeKey: 'mrpack',
    field: 'mrpack',
    fileMode: 'single',
    maxBytes: 2 * 1024 * 1024 * 1024,
    ext: ['.mrpack'],
    extError: 'Only .mrpack files are allowed.',
    mimetype: 'application/x-modrinth-modpack+zip'
}, createFromMrpackHandler));

// POST /servers/:id/start
router.post('/servers/:id/start', async (req, res) => {
    if (!await loadServerOr404(req, res)) return;
    const serverManager = req.app.get('serverManager');
    try {
        await clearStatsHistory(req.params.id);
        await serverManager.startServer(req.params.id, { initiatedBy: req.user.username });
        logEvent(req.params.id, 'action', 'Server start requested', { initiatedBy: req.user.username }).catch(() => {});
        res.json({ success: true, message: 'Server is starting...' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /servers/:id/stop
router.post('/servers/:id/stop', async (req, res) => {
    if (!await loadServerOr404(req, res)) return;
    const serverManager = req.app.get('serverManager');
    try {
        await clearStatsHistory(req.params.id);
        await serverManager.stopServer(req.params.id, { initiatedBy: req.user.username });
        logEvent(req.params.id, 'action', 'Server stop requested', { initiatedBy: req.user.username }).catch(() => {});
        res.json({ success: true, message: 'Server is stopping...' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /servers/:id/restart
router.post('/servers/:id/restart', async (req, res) => {
    if (!await loadServerOr404(req, res)) return;
    const serverManager = req.app.get('serverManager');
    const id = req.params.id;
    const initiatedBy = req.user.username;
    const createBackupFirst = req.body?.backup === 'true' || req.body?.backup === true;

    if (!createBackupFirst) {
        try {
            await clearStatsHistory(id);
            await serverManager.restartServer(id, { initiatedBy });
            logEvent(id, 'action', 'Server restart requested', { initiatedBy }).catch(() => {});
            return res.json({ success: true, message: 'Server is restarting...' });
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
    }

    // Restart-with-backup: stop → backup (long) → start. Fire-and-forget so the
    // browser doesn't time out on the backup. Completion broadcast via WebSocket.
    const { runBackupJob, tryAcquireBackupLock, releaseBackupLock, formatSize } = require('../../mc/BackupManager');

    if (!tryAcquireBackupLock(id)) {
        return res.status(409).json({ error: 'A backup is already in progress for this server.' });
    }

    let lockOwnedByRoute = true;
    try {
        const proc = serverManager?.getProcess(id);
        if (proc && ['running', 'starting'].includes(proc.state)) {
            await serverManager.stopServer(id, { initiatedBy });
            await proc.waitForState('stopped', 60000);
        }

        await syncServerConfig(id);
        await serverManager.setOperationalState(id, STATES.BACKING_UP);
        lockOwnedByRoute = false;
        res.status(202).json({ success: true, status: 'started', message: 'Backup started; server will restart on completion.' });

        (async () => {
            try {
                const backup = await runBackupJob(id, 'Pre-restart backup', 'manual');
                logEvent(id, 'action', 'Pre-restart backup created', { initiatedBy }).catch(() => {});
                serverManager.broadcastOperation(id, 'backup', 'complete', {
                    backup: { ...backup, sizeFormatted: formatSize(backup.size) }
                });

                await serverManager.setOperationalState(id, STATES.STOPPED);
                await clearStatsHistory(id);
                await serverManager.startServer(id, { initiatedBy });
                logEvent(id, 'action', 'Server restarted with backup', { initiatedBy }).catch(() => {});
            } catch (err) {
                log('error', `Restart-with-backup failed for ${id}: ${err.message}`);
                logEvent(id, 'backup_create_fail', `Pre-restart backup failed: ${err.message}`, { initiatedBy }).catch(() => {});
                try {
                    await serverManager.setOperationalState(id, STATES.STOPPED);
                } catch (_) {}
                serverManager.broadcastOperation(id, 'backup', 'failed', err.message);
            }
        })();
    } catch (err) {
        if (lockOwnedByRoute) releaseBackupLock(id);
        log('error', `Restart-with-backup setup failed for ${id}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

// POST /servers/:id/command — Send a console command to a running server
router.post('/servers/:id/command', async (req, res) => {
    if (!await loadServerOr404(req, res)) return;

    const raw = req.body?.command;
    if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "command" field.' });
    }
    const line = raw.trim().slice(0, 1000);
    if (line.length === 0) {
        return res.status(400).json({ error: 'Command cannot be empty.' });
    }

    const serverManager = req.app.get('serverManager');
    const proc = serverManager.getProcess(req.params.id);
    if (!proc || proc.state !== 'running') {
        return res.status(409).json({ error: 'Server is not running.' });
    }

    proc.sendCommand(line);
    res.json({ success: true });
});

// POST /servers/:id/kill
router.post('/servers/:id/kill', async (req, res) => {
    if (!await loadServerOr404(req, res)) return;
    const serverManager = req.app.get('serverManager');
    try {
        await clearStatsHistory(req.params.id);
        await serverManager.killServer(req.params.id, { initiatedBy: req.user.username });
        logEvent(req.params.id, 'action', 'Server force-killed', { initiatedBy: req.user.username }).catch(() => {});
        res.json({ success: true, message: 'Server force-killed.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Import handler — shared by the multipart route and the DGUP complete step,
// which synthesizes an identical req.file. Responds 201 immediately;
// extraction continues in the background and completes via the WS 'operation'
// message.
const importServerHandler = async (req, res) => {
    const tmpPath = req.file?.path;
    const cleanupTemp = () => {
        if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
    };

    // Every rejection is logged — a silent 400 leaves nothing server-side to
    // diagnose "my archive won't import" reports with.
    const rejectImport = (status, message) => {
        log('warn', `Import rejected ("${req.file?.originalname || 'unknown'}"): ${message}`);
        return res.status(status).json({ error: message });
    };

    if (!tmpPath) {
        return rejectImport(400, 'No archive uploaded.');
    }

    // .cbx is a zip container — check the magic bytes, not just the extension.
    if (!isZipFile(tmpPath)) {
        cleanupTemp();
        return rejectImport(400, 'Not a valid Craftbox transfer archive.');
    }

    // node-stream-zip reads entry data from disk on demand — archive size is
    // bounded by disk space, not process memory.
    const zip = new StreamZip.async({ file: tmpPath });
    const discard = async () => {
        // Close the zip's file handle before unlinking — Windows cannot delete
        // an open file.
        try { await zip.close(); } catch { /* ignore */ }
        cleanupTemp();
    };

    try {
        let zipEntries;
        try {
            zipEntries = await zip.entries();
        } catch {
            await discard();
            return rejectImport(400, 'Failed to read archive.');
        }

        if (!zipEntries['craftbox-manifest.json']) {
            await discard();
            return rejectImport(400, 'Not a Craftbox export archive.');
        }

        let manifest;
        try {
            manifest = JSON.parse((await zip.entryData('craftbox-manifest.json')).toString('utf8'));
        } catch {
            await discard();
            return rejectImport(400, 'Export manifest is corrupted.');
        }
        if (manifest.format !== 'craftbox-server-export') {
            await discard();
            return rejectImport(400, 'Not a Craftbox export archive.');
        }
        if (manifest.formatVersion !== 1) {
            await discard();
            return rejectImport(400, 'This archive was created by a newer version of Craftbox and cannot be imported.');
        }

        // Sanity-check the embedded server object before touching disk or DB.
        const source = manifest.server;
        if (!source || typeof source !== 'object' || !UUID_RE.test(String(source.id))) {
            await discard();
            return rejectImport(400, 'Export manifest is invalid.');
        }
        const trimmedName = String(source.name || '').trim();
        if (trimmedName.length < 1 || trimmedName.length > 50 || !/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
            await discard();
            return rejectImport(400, 'Export manifest contains an invalid server name.');
        }
        if (!getProvider(source.serverType || 'vanilla')) {
            await discard();
            return rejectImport(400, 'Export manifest contains an unknown server type.');
        }
        const portNum = parseInt(source.port, 10);
        if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
            await discard();
            return rejectImport(400, 'Export manifest contains an invalid port.');
        }
        const memoryNum = parseInt(source.memory, 10);
        if (isNaN(memoryNum) || memoryNum < 512 || memoryNum > 65536) {
            await discard();
            return rejectImport(400, 'Export manifest contains an invalid memory value.');
        }

        // Reject unsafe or unexpected archive entries up front (zip-slip).
        const knownRootFiles = new Set(['craftbox-manifest.json', 'modenv.json', 'backups.json', 'events.json']);
        for (const entry of Object.values(zipEntries)) {
            const entryName = String(entry.name).replace(/\\/g, '/');
            if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName) || entryName.split('/').includes('..')) {
                await discard();
                return rejectImport(400, 'Archive contains unsafe paths.');
            }
            if (!entryName.startsWith('server/') && !entryName.startsWith('backups/') && !knownRootFiles.has(entryName)) {
                await discard();
                return rejectImport(400, `Archive contains an unexpected entry: ${entryName}`);
            }
        }

        // Keep the source UUID when it is free on this instance; otherwise re-key.
        let finalId = String(source.id).toLowerCase();
        if (await serversDb.get(`server_${finalId}`) || fs.existsSync(path.join(SERVERS_DIR, finalId))) {
            finalId = uuidv4();
        }

        const warnings = [];
        const allServers = await serversDb.all();
        const portClash = allServers.map(row => row.value).find(s => s && s.port === portNum);
        if (portClash) {
            warnings.push(`Port ${portNum} is already used by "${portClash.name}". Edit this server's port before starting it.`);
            log('warn', `Import of "${trimmedName}": port ${portNum} clashes with "${portClash.name}"`);
        }

        const groupResult = normalizeGroupName(source.group);
        const importedServer = {
            ...source,
            id: finalId,
            name: trimmedName,
            state: STATES.PROVISIONING,
            port: portNum,
            memory: memoryNum,
            jarFile: typeof source.jarFile === 'string' && source.jarFile ? source.jarFile : 'server.jar',
            group: groupResult.valid ? groupResult.value : null,
            autoStart: !!source.autoStart,
            exitCode: null,
            crashReason: null,
            crashDetected: false,
            lastStarted: null,
            lastStopped: null,
            advertisedIp: null,
            directory: path.join('data', 'servers', finalId)
        };
        if (importedServer.backupSchedule) delete importedServer.backupSchedule.nextBackupAt;

        await serversDb.set(`server_${finalId}`, importedServer);
        log('info', `Importing server "${trimmedName}" (${finalId}) from "${req.file.originalname}": `
            + `${Object.keys(zipEntries).length} archive entries`
            + `${zipEntries['backups.json'] ? ', with backups' : ''}`
            + `${zipEntries['events.json'] ? ', with events' : ''}`
            + `${finalId === String(source.id).toLowerCase() ? '' : ` (re-keyed from ${source.id})`}`
            + ` — extracting in background`);
        notifyDashboard(req);
        res.status(201).json({ success: true, server: importedServer, warnings });

        const serverManager = req.app.get('serverManager');
        const initiatedBy = req.user.username;
        (async () => {
            try {
                const serverDir = path.join(SERVERS_DIR, finalId);
                const resolvedServerDir = path.resolve(serverDir);
                await fs.promises.mkdir(serverDir, { recursive: true });

                // Extract server files (streamed, so any archive size works),
                // stripping the server/ prefix and re-checking every resolved
                // path (belt and braces vs the scan above).
                const streamEntryTo = (entryName, target) => new Promise((resolve, reject) => {
                    zip.stream(entryName).then((stm) => {
                        const out = fs.createWriteStream(target);
                        stm.on('error', reject);
                        out.on('error', reject);
                        out.on('finish', resolve);
                        stm.pipe(out);
                    }).catch(reject);
                });

                for (const entry of Object.values(zipEntries)) {
                    const entryName = String(entry.name).replace(/\\/g, '/');
                    if (!entryName.startsWith('server/')) continue;
                    const relative = entryName.slice('server/'.length);
                    if (!relative) continue;
                    const target = path.resolve(serverDir, relative);
                    if (target !== resolvedServerDir && !target.startsWith(resolvedServerDir + path.sep)) {
                        throw new Error(`Zip entry escapes target directory: ${entry.name}`);
                    }
                    if (entry.isDirectory) {
                        await fs.promises.mkdir(target, { recursive: true });
                    } else {
                        await fs.promises.mkdir(path.dirname(target), { recursive: true });
                        await streamEntryTo(entry.name, target);
                    }
                }
                await fs.promises.mkdir(path.join(serverDir, 'logs'), { recursive: true });

                // Mod environment map (disabled/client-only mods)
                if (zipEntries['modenv.json']) {
                    try {
                        const modEnv = JSON.parse((await zip.entryData('modenv.json')).toString('utf8'));
                        if (modEnv && typeof modEnv === 'object') await setModEnvMap(finalId, modEnv);
                    } catch { /* non-fatal */ }
                }

                // Backups — records are always re-keyed; filenames validated
                if (zipEntries['backups.json']) {
                    let backupRecords = [];
                    try { backupRecords = JSON.parse((await zip.entryData('backups.json')).toString('utf8')); } catch { /* skip */ }
                    if (Array.isArray(backupRecords)) {
                        ensureBackupDir(finalId);
                        let restoredBackups = 0;
                        for (const record of backupRecords) {
                            if (!record || typeof record.filename !== 'string') continue;
                            if (!zipEntries[`backups/${record.filename}`]) continue;
                            let backupPath;
                            try { backupPath = resolveBackupPath(finalId, record.filename); } catch { continue; }
                            await streamEntryTo(`backups/${record.filename}`, backupPath);
                            const newBackupId = uuidv4();
                            await backupsDb.set(`backup_${newBackupId}`, { ...record, id: newBackupId, serverId: finalId });
                            restoredBackups++;
                        }
                        log('info', `Import of "${trimmedName}": restored ${restoredBackups} of ${backupRecords.length} backup(s)`);
                    }
                }

                // Event history — re-keyed, capped at the pruneEvents limit
                if (zipEntries['events.json']) {
                    let eventRecords = [];
                    try { eventRecords = JSON.parse((await zip.entryData('events.json')).toString('utf8')); } catch { /* skip */ }
                    if (Array.isArray(eventRecords)) {
                        let restoredEvents = 0;
                        for (const record of eventRecords.slice(0, 500)) {
                            if (!record || typeof record !== 'object') continue;
                            const newEventId = uuidv4();
                            await eventsDb.set(`event_${newEventId}`, { ...record, id: newEventId, serverId: finalId });
                            restoredEvents++;
                        }
                        log('info', `Import of "${trimmedName}": restored ${restoredEvents} event record(s)`);
                    }
                }

                // Keep DB ↔ server.properties/eula.txt consistent on the new host
                await syncServerConfig(finalId);

                if (importedServer.backupSchedule?.enabled) {
                    const backupScheduler = req.app.get('backupScheduler');
                    if (backupScheduler) {
                        await backupScheduler.restartSchedule(finalId);
                    }
                }

                if (serverManager) {
                    await serverManager.setOperationalState(finalId, STATES.STOPPED);
                    serverManager.broadcastOperation(finalId, 'import', 'complete', { warnings });
                }
                logEvent(finalId, 'action', 'Imported from Craftbox export archive', { initiatedBy }).catch(() => {});
                log('info', `Server "${trimmedName}" (${finalId}) imported from export archive.`);
            } catch (err) {
                log('error', `Failed to import server ${finalId}: ${err.message}`);
                logEvent(finalId, 'action', `Import failed: ${err.message}`, { initiatedBy }).catch(() => {});
                if (serverManager) {
                    try {
                        await serverManager.setOperationalState(finalId, STATES.CRASHED, {
                            crashReason: 'Import failed: ' + err.message
                        });
                    } catch (_) {}
                    serverManager.broadcastOperation(finalId, 'import', 'failed', err.message);
                }
            } finally {
                await discard();
            }
        })();
    } catch (err) {
        await discard();
        log('error', `Failed to import server: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to import server: ${err.message}` });
        }
    }
};

// POST /servers/import — Import a server from a Craftbox export archive
// (created by GET /servers/:id/export) as a single multipart request.
router.post('/servers/import', multerShim(importUpload.single('archive')), importServerHandler);

// POST /servers/import/upload/{init,chunk,complete,cancel} — DGUP chunked
// import for archives too large for a single request (e.g. behind Cloudflare
// Tunnel's 100 MB body cap). complete() runs importServerHandler unchanged.
router.use('/servers/import/upload', createDgupRouter({
    routeKey: 'import',
    field: 'archive',
    fileMode: 'single',
    maxBytes: Infinity,
    ext: IMPORT_EXTENSIONS,
    extError: IMPORT_EXT_ERROR,
    mimetype: 'application/x-craftbox-export+zip'
}, importServerHandler));

// POST /servers/:id/duplicate
router.post('/servers/:id/duplicate', async (req, res) => {
    const id = req.params.id;
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(id);
    const stopFirst = req.body.stopFirst === 'true' || req.body.stopFirst === true;
    const startAfter = req.body.startAfter === 'true' || req.body.startAfter === true;

    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        if (!stopFirst) {
            return res.status(409).json({ error: 'Stop the server before duplicating it.' });
        }
        try {
            if (proc.state === 'running' || proc.state === 'starting') {
                await serverManager.stopServer(id);
                await proc.waitForState('stopped', 60000);
            }
        } catch (err) {
            log('error', `Failed to stop server before duplicate: ${err.message}`);
            return res.status(500).json({ error: `Failed to stop server: ${err.message}` });
        }
    }

    const { name, port, includeWorld } = req.body;

    const trimmedName = String(name || '').trim();
    if (trimmedName.length < 1 || trimmedName.length > 50 || !/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        return res.status(400).json({ error: 'Invalid server name.' });
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        return res.status(400).json({ error: 'Port must be between 1024 and 65535.' });
    }

    const newId = uuidv4();
    const sourceDir = path.join(SERVERS_DIR, id);
    const newDir = path.join(SERVERS_DIR, newId);
    const initiatedBy = req.user.username;

    try {
        const newServer = {
            ...server,
            id: newId,
            name: trimmedName,
            port: portNum,
            state: STATES.PROVISIONING,
            createdAt: new Date().toISOString(),
            lastStarted: null,
            lastStopped: null,
            exitCode: null,
            crashReason: null,
            directory: path.join('data', 'servers', newId),
            backupSchedule: {
                enabled: server.backupSchedule?.enabled || false,
                intervalHours: server.backupSchedule?.intervalHours || 24,
                countdownMinutes: server.backupSchedule?.countdownMinutes || 5,
                retentionCount: server.backupSchedule?.retentionCount || 5,
                retentionDays: server.backupSchedule?.retentionDays || 0
            }
        };

        await serversDb.set(`server_${newId}`, newServer);
        notifyDashboard(req);
        res.status(201).json({ success: true, server: newServer, warning: null });

        (async () => {
            try {
                await fs.promises.cp(sourceDir, newDir, { recursive: true });

                if (includeWorld !== 'true' && includeWorld !== true) {
                    const worldDirs = ['world', 'world_nether', 'world_the_end'];
                    for (const dir of worldDirs) {
                        const worldPath = path.join(newDir, dir);
                        await fs.promises.rm(worldPath, { recursive: true, force: true });
                    }
                }

                const logsDir = path.join(newDir, 'logs');
                await fs.promises.rm(logsDir, { recursive: true, force: true });
                await fs.promises.mkdir(logsDir, { recursive: true });

                updateServerProperties(newDir, { 'server-port': String(portNum) });

                await copyModEnvMap(id, newId);

                if (newServer.backupSchedule?.enabled) {
                    const backupScheduler = req.app.get('backupScheduler');
                    if (backupScheduler) {
                        await backupScheduler.restartSchedule(newId);
                    }
                }

                if (serverManager) {
                    await serverManager.setOperationalState(newId, STATES.STOPPED);
                    serverManager.broadcastOperation(newId, 'duplicate', 'complete', {});
                }
                logEvent(newId, 'action', `Duplicated from "${server.name}"`, { initiatedBy }).catch(() => {});
                log('info', `Server "${trimmedName}" (${newId}) duplicated from "${server.name}" (${id}).`);

                if (startAfter && stopFirst) {
                    try {
                        await serverManager.startServer(id, { initiatedBy });
                    } catch (err) {
                        log('error', `Failed to restart source server after duplicate: ${err.message}`);
                    }
                }
            } catch (err) {
                log('error', `Failed to duplicate server ${id} → ${newId}: ${err.message}`);
                logEvent(newId, 'action', `Duplication failed: ${err.message}`, { initiatedBy }).catch(() => {});
                if (serverManager) {
                    try {
                        await serverManager.setOperationalState(newId, STATES.CRASHED, {
                            crashReason: 'Duplication failed: ' + err.message
                        });
                    } catch (_) {}
                    serverManager.broadcastOperation(newId, 'duplicate', 'failed', err.message);
                }
            }
        })();
    } catch (err) {
        log('error', `Failed to duplicate server ${id}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to duplicate server: ${err.message}` });
        }
    }
});

// DELETE /servers/:id — Delete a server entirely
router.delete('/servers/:id', async (req, res) => {
    const id = req.params.id;
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(id);
    const liveState = proc ? proc.state : server.state;
    if (!['stopped', 'crashed'].includes(liveState)) {
        return res.status(409).json({ error: 'Stop the server before deleting it.' });
    }

    try {
        serverManager?.removeProcess(id);

        const backupScheduler = req.app.get('backupScheduler');
        if (backupScheduler) backupScheduler.stopSchedule(id);

        // Delete the DB record first so the user's UI immediately reflects the
        // server as gone. Filesystem cleanup runs asynchronously below.
        await serversDb.delete(`server_${id}`);
        log('info', `Server "${server.name}" (${id}) marked for deletion.`);

        notifyDashboard(req);
        res.json({ success: true });

        // Background cleanup — failures only orphan data, they don't affect the
        // user's view (the record is already gone).
        (async () => {
            await cleanupServerData(id, server.group);
            log('info', `Server "${server.name}" (${id}) cleanup complete.`);
        })();
    } catch (err) {
        log('error', `Failed to delete server ${id}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to delete server: ${err.message}` });
        }
    }
});

// POST /servers/:id/edit — Edit server settings (name, port, memory, javaArgs, gamemode, difficulty, seed, version, customJarUrl)
router.post('/servers/:id/edit', async (req, res) => {
    const id = req.params.id;
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const { name, port, memory, javaArgs, gamemode, difficulty, seed, version, customJarUrl, group } = req.body;

    const trimmedName = String(name).trim();
    if (trimmedName.length < 1 || trimmedName.length > 50 || !/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        return res.status(400).json({ error: 'Invalid server name.' });
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        return res.status(400).json({ error: 'Port must be between 1024 and 65535.' });
    }

    const memoryNum = parseInt(memory, 10);
    if (isNaN(memoryNum) || memoryNum < 512 || memoryNum > 65536) {
        return res.status(400).json({ error: 'Memory must be between 512 and 65536 MB.' });
    }

    const validGamemodes = ['survival', 'creative', 'adventure', 'spectator'];
    const validDifficulties = ['peaceful', 'easy', 'normal', 'hard'];
    const gamemodeStr = validGamemodes.includes(gamemode) ? gamemode : server.gamemode;
    const difficultyStr = validDifficulties.includes(difficulty) ? difficulty : server.difficulty;
    const seedStr = String(seed || '').trim();
    const safeJavaArgs = String(javaArgs || '').trim();

    const groupResult = normalizeGroupName(group);
    if (!groupResult.valid) {
        return res.status(400).json({ error: GROUP_NAME_ERROR });
    }

    const type = server.serverType || 'vanilla';
    const newVersion = String(version || '').trim();

    // Everything that mutates the server, deferred into one closure so the
    // backup path can run it only once a restore point exists. Throws
    // httpError; callers map that to a status code or a WebSocket failure.
    const applyEdit = async () => {
        let versionChanged = false;

        if (type !== 'custom' && newVersion && newVersion !== server.version) {
            if (!MC_VERSION_RE.test(newVersion)) {
                throw httpError(400, 'Invalid version format.');
            }
            if (await isVersionDowngrade(type, server.version, newVersion, id)) {
                throw httpError(400, 'Version downgrades are not permitted.');
            }

            const proc = req.app.get('serverManager')?.getProcess(id);
            if (proc && !['stopped', 'crashed'].includes(proc.state)) {
                throw httpError(409, 'Stop the server before changing the version.');
            }

            const libStash = stashLoaderLibraries(type, id, server.name);
            try {
                const jarPath = path.join(SERVERS_DIR, id, server.jarFile || 'server.jar');
                const result = await downloadJarSafely(type, newVersion, jarPath);
                libStash?.commit();
                const oldVersion = server.version;
                server.version = newVersion;
                if (result?.build) server.build = result.build;
                // Set-or-clear so a stale Java requirement never survives a version change
                server.javaMajor = result?.javaMajor || null;
                versionChanged = true;
                log('info', `Server "${server.name}" upgraded from ${oldVersion} to ${newVersion}.`);
            } catch (err) {
                libStash?.rollback();
                log('error', `Version upgrade failed for ${id}: ${err.message}`);
                throw httpError(500, `Failed to upgrade version: ${err.message}`);
            }
        }

        let jarChanged = false;
        if (type === 'custom' && customJarUrl) {
            const newUrl = String(customJarUrl).trim();
            if (newUrl && newUrl !== (server.customJarUrl || '')) {
                const proc = req.app.get('serverManager')?.getProcess(id);
                if (proc && !['stopped', 'crashed'].includes(proc.state)) {
                    throw httpError(409, 'Stop the server before changing the jar URL.');
                }

                try {
                    const jarPath = path.join(SERVERS_DIR, id, server.jarFile || 'server.jar');
                    await downloadJarSafely('custom', newUrl, jarPath);
                    server.customJarUrl = newUrl;
                    jarChanged = true;
                    log('info', `Server "${server.name}" jar replaced from new URL.`);
                } catch (err) {
                    log('error', `Custom jar download failed for ${id}: ${err.message}`);
                    throw httpError(500, `Failed to download jar: ${err.message}`);
                }
            }
        }

        // `server` was snapshotted when the request arrived, and the restore-point
        // path stops the server, backs it up and restarts it around this call — so
        // its runtime fields are stale by now. Take those from the current record
        // instead of writing our copy back: persisting a stale `state: "running"`
        // makes _ensureProcess rebuild the process in that state, and the restart
        // then dies with "Cannot start server in state: running".
        const current = await serversDb.get(`server_${id}`);
        if (current) {
            server.state = current.state;
            server.crashReason = current.crashReason;
            server.exitCode = current.exitCode;
            server.lastStarted = current.lastStarted;
            server.lastStopped = current.lastStopped;
        }

        const previousGroup = server.group || null;
        server.name = trimmedName;
        server.port = portNum;
        server.memory = memoryNum;
        server.javaArgs = safeJavaArgs;
        server.gamemode = gamemodeStr;
        server.difficulty = difficultyStr;
        server.seed = seedStr;
        server.group = groupResult.value;
        await serversDb.set(`server_${id}`, server);

        // Best-effort cleanup of the old group's color if it emptied — a failure
        // here must not fail the edit, which already saved.
        if (previousGroup && previousGroup !== server.group) {
            try {
                await pruneGroupMetaIfEmpty(previousGroup);
            } catch (err) {
                log('error', `Group cleanup failed for "${previousGroup}": ${err.message}`);
            }
        }

        const serverDir = path.join(SERVERS_DIR, id);
        if (fs.existsSync(path.join(serverDir, 'server.properties'))) {
            updateServerProperties(serverDir, {
                'server-port': String(portNum),
                'gamemode': gamemodeStr,
                'difficulty': difficultyStr,
                'level-seed': seedStr
            });
        }

        const proc = req.app.get('serverManager')?.getProcess(id);
        if (proc) Object.assign(proc.config, server);

        return { versionChanged, jarChanged };
    };

    // A backup taken after the save can't undo it — so when one is asked for,
    // it is taken first and the edit is applied on the far side of it.
    if (req.body?.backup === true || req.body?.backup === 'true') {
        return runWithRestorePoint({
            req, res, server,
            label: 'Pre-edit backup',
            operation: 'settings-save',
            apply: applyEdit
        });
    }

    try {
        const { versionChanged, jarChanged } = await applyEdit();
        notifyDashboard(req);
        res.json({ success: true, server, versionChanged, jarChanged });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /servers/:id/properties — Update server.properties
router.post('/servers/:id/properties', async (req, res) => {
    const id = req.params.id;
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const applyProperties = async () => {
        const serverDir = path.join(SERVERS_DIR, id);
        const currentProps = parseServerProperties(serverDir);
        const updates = {};

        for (const key of Object.keys(currentProps)) {
            // `backup` is this endpoint's own flag, never a Minecraft property.
            if (key === 'backup') continue;
            const meta = PROPERTY_META[key];
            if (meta && meta.type === 'boolean') {
                updates[key] = req.body[key] === 'true' || req.body[key] === true ? 'true' : 'false';
            } else if (req.body[key] !== undefined) {
                updates[key] = String(req.body[key]);
            }
        }

        updateServerProperties(serverDir, updates);
        await syncServerConfig(id);
        return {};
    };

    // As with /edit: a backup only rolls the change back if it predates it.
    if (req.body?.backup === true || req.body?.backup === 'true') {
        return runWithRestorePoint({
            req, res, server,
            label: 'Pre-properties backup',
            operation: 'settings-save',
            apply: applyProperties
        });
    }

    await applyProperties();
    res.json({ success: true });
});

// POST /servers/:id/edit-file — Save a text file in the server directory
router.post('/servers/:id/edit-file', async (req, res) => {
    const id = req.params.id;
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const filePath = req.body.filePath;
    if (!filePath) {
        return res.status(400).json({ error: 'No file path specified.' });
    }

    const serverDir = path.resolve(SERVERS_DIR, id);
    const targetPath = path.resolve(serverDir, filePath);

    if (!isPathInside(serverDir, targetPath)) {
        return res.status(403).json({ error: 'Access denied.' });
    }

    if (!isTextFile(path.basename(targetPath))) {
        return res.status(400).json({ error: 'This file type cannot be edited.' });
    }

    try {
        const content = req.body.content || '';
        fs.writeFileSync(targetPath, content, 'utf8');
        log('info', `File edited: ${filePath} on server ${server.name} (${id})`);

        const editedFile = path.basename(targetPath);
        if (editedFile === 'server.properties' || editedFile === 'eula.txt') {
            await syncServerConfig(id);
        }

        res.json({ success: true, file: path.basename(targetPath) });
    } catch (err) {
        log('error', `Failed to save file ${filePath}: ${err.message}`);
        res.status(500).json({ error: `Failed to save file: ${err.message}` });
    }
});

module.exports = router;
