const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { serversDb, SERVERS_DIR } = require('../../db');
const { getProvider, listProviders } = require('../../mc/serverTypes');
const { downloadServerJar } = require('../../mc/downloader');
const { log } = require('../../utils/log');
const { logEvent, deleteServerEvents } = require('../../utils/eventLogger');
const { getEvents } = require('../../utils/eventLogger');
const { getProcessMemory, getProcessCpu, getDirectorySize, getUptime, formatSize, formatUptime } = require('../../utils/resourceStats');
const { clearStatsHistory, getStatsHistory } = require('../../utils/statsHistory');
const { setServerIcon, resetServerIcon, removeServerIcon, getIconPath, copyDefaultIcon } = require('../../utils/serverIcon');
const { writeServerProperties, writeEula, parseServerProperties, updateServerProperties } = require('../../mc/serverProperties');
const { PROPERTY_META } = require('../../mc/propertyMeta');
const { getContentType } = require('../../utils/contentType');
const { copyModEnvMap, clearAllModEnv } = require('../../utils/modEnvironment');
const { syncServerConfig } = require('../../mc/syncServerConfig');
const { STATES } = require('../../mc/stateMachine');
const { isPathInside } = require('../../utils/pathSafety');

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

const TEXT_EXTENSIONS = new Set([
    '.txt', '.log', '.properties', '.json', '.yml', '.yaml', '.xml',
    '.cfg', '.conf', '.ini', '.toml', '.csv', '.md', '.sh', '.bat',
    '.cmd', '.ps1', '.js', '.ts', '.py', '.java', '.html', '.css',
    '.mcmeta', '.lang', '.sk', '.nbt'
]);
function isTextFile(filename) {
    return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

// Multer config for server icon upload — PNG only, 5 MB limit
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

// GET /versions — Fetch versions for a server type (?type=vanilla|paper|...)
router.get('/versions', async (req, res) => {
    const type = req.query.type || 'vanilla';
    const provider = getProvider(type);
    if (!provider) {
        return res.status(400).json({ error: `Unknown server type: ${type}` });
    }

    try {
        const result = await provider.listVersions();
        if (!result) {
            return res.json({ versions: [], latest: null });
        }

        const sorted = [...result.versions].sort((a, b) => {
            const aParts = a.id.split('.').map(Number);
            const bParts = b.id.split('.').map(Number);
            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                const diff = (bParts[i] || 0) - (aParts[i] || 0);
                if (diff !== 0) return diff;
            }
            return 0;
        });

        res.json({ versions: sorted, latest: result.latest });
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

// GET /servers/:id/check-update — Check if a newer build is available
router.get('/servers/:id/check-update', async (req, res) => {
    try {
        const server = await loadServerOr404(req, res);
        if (!server) return;

        const type = server.serverType || 'vanilla';
        const provider = getProvider(type);
        if (!provider) return res.json({ updateAvailable: false });

        if (!provider.getBuilds || type === 'custom') {
            return res.json({ updateAvailable: false, reason: 'No build tracking for this server type.' });
        }

        const builds = await provider.getBuilds(server.version);
        if (!builds || builds.length === 0) {
            return res.json({ updateAvailable: false });
        }

        const latestBuild = builds[0].build;
        const currentBuild = server.build;

        if (currentBuild == null) {
            return res.json({
                updateAvailable: false,
                latestBuild,
                currentBuild: null,
                reason: 'No build number recorded for this server.'
            });
        }

        const updateAvailable = latestBuild !== currentBuild && latestBuild > currentBuild;
        res.json({
            updateAvailable,
            currentBuild,
            latestBuild,
            channel: builds[0].channel || null
        });
    } catch (err) {
        log('error', `Check-update failed for ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: 'Failed to check for updates.' });
    }
});

// POST /servers/:id/update-jar — Kick off a jar download. Returns 202 immediately;
// completion is reported via the per-server WebSocket as
// { type: 'operation', operation: 'jar-update', status: 'complete'|'failed', ... }.
router.post('/servers/:id/update-jar', async (req, res) => {
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        return res.status(409).json({ error: 'Stop the server before updating the jar.' });
    }

    const type = server.serverType || 'vanilla';
    const provider = getProvider(type);
    if (!provider) return res.status(400).json({ error: 'Unknown server type.' });

    const initiatedBy = req.user.username;

    try {
        await serverManager.setOperationalState(server.id, STATES.UPDATING_JAR);
        res.status(202).json({ success: true, status: 'started' });

        (async () => {
            try {
                const jarPath = path.join(SERVERS_DIR, server.id, server.jarFile || 'server.jar');
                const result = await downloadServerJar(type, server.version, null, jarPath);

                if (result?.build) {
                    const fresh = await serversDb.get(`server_${server.id}`);
                    if (fresh) {
                        fresh.build = result.build;
                        await serversDb.set(`server_${server.id}`, fresh);
                    }
                }

                await serverManager.setOperationalState(server.id, STATES.STOPPED);
                logEvent(server.id, 'jar_update', `Jar updated to build ${result?.build || 'latest'}`, { initiatedBy }).catch(() => {});
                log('info', `Server "${server.name}" jar updated to build ${result?.build || 'latest'}.`);
                serverManager.broadcastOperation(server.id, 'jar-update', 'complete', {
                    build: result?.build || null,
                    version: server.version
                });
            } catch (err) {
                log('error', `Update-jar failed for ${server.id}: ${err.message}`);
                logEvent(server.id, 'jar_update_fail', `Jar update failed: ${err.message}`, { initiatedBy }).catch(() => {});
                try {
                    await serverManager.setOperationalState(server.id, STATES.STOPPED);
                } catch (_) {}
                serverManager.broadcastOperation(server.id, 'jar-update', 'failed', err.message);
            }
        })();
    } catch (err) {
        log('error', `Update-jar setup failed for ${req.params.id}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to update jar: ${err.message}` });
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

// POST /servers/:id/icon — Upload server icon
router.post('/servers/:id/icon', function (req, res, next) {
    iconUpload.single('icon')(req, res, function (err) {
        if (err) {
            return res.status(400).json({ error: err.message || 'Upload failed.' });
        }
        next();
    });
}, async (req, res) => {
    const fs = require('fs');
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
        log('error', `Failed to update server icon: ${err.message}`);
        res.status(500).json({ error: 'Failed to update server icon.' });
    }
});

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

// POST /servers — Create a new server
router.post('/servers', async (req, res) => {
    const { name, version, port, memory, javaArgs, eula, gamemode, difficulty, seed, serverType, customJarUrl } = req.body;

    if (!name || !port || !memory) {
        return res.status(400).json({ error: 'All required fields must be filled.' });
    }

    const trimmedName = String(name).trim();
    if (trimmedName.length < 1 || trimmedName.length > 50) {
        return res.status(400).json({ error: 'Server name must be 1-50 characters.' });
    }
    if (!/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        return res.status(400).json({ error: 'Server name can only contain letters, numbers, spaces, hyphens, and underscores.' });
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        return res.status(400).json({ error: 'Port must be between 1024 and 65535.' });
    }

    const memoryNum = parseInt(memory, 10);
    if (isNaN(memoryNum) || memoryNum < 512 || memoryNum > 65536) {
        return res.status(400).json({ error: 'Memory must be between 512 and 65536 MB.' });
    }

    if (!eula) {
        return res.status(400).json({ error: 'You must accept the Minecraft EULA.' });
    }

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
        if (!versionStr || (!/^\d+\.\d+(\.\d+)?(-\w+)?$/.test(versionStr) && versionStr !== 'latest')) {
            return res.status(400).json({ error: 'Invalid Minecraft version format.' });
        }
    }

    const safeJavaArgs = String(javaArgs || '').trim();
    const validGamemodes = ['survival', 'creative', 'adventure', 'spectator'];
    const validDifficulties = ['peaceful', 'easy', 'normal', 'hard'];
    const gamemodeStr = validGamemodes.includes(gamemode) ? gamemode : 'survival';
    const difficultyStr = validDifficulties.includes(difficulty) ? difficulty : 'easy';
    const seedStr = String(seed || '').trim();

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
            createdAt: new Date().toISOString(),
            lastStarted: null,
            lastStopped: null,
            exitCode: null,
            crashReason: null,
            directory: path.join('data', 'servers', id)
        };

        await serversDb.set(`server_${id}`, server);

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
                logEvent(id, 'action', `Server provisioning failed: ${err.message}`, { initiatedBy }).catch(() => {});
                if (serverManager) {
                    try {
                        await serverManager.setOperationalState(id, STATES.CRASHED, {
                            crashReason: 'Provisioning failed: ' + err.message
                        });
                    } catch (_) {}
                    serverManager.broadcastOperation(id, 'create', 'failed', err.message);
                }
            }
        })();
    } catch (err) {
        log('error', `Failed to create server: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to create server: ${err.message}` });
        }
    }
});

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

        res.json({ success: true });

        // Background cleanup. Failures here orphan files on disk but do not
        // affect the user's view, so we only log.
        (async () => {
            try {
                const { deleteAllBackups } = require('../../mc/BackupManager');
                await deleteAllBackups(id);
                await deleteServerEvents(id);
                await clearStatsHistory(id);
                await clearAllModEnv(id);

                const serverDir = path.join(SERVERS_DIR, id);
                await fs.promises.rm(serverDir, { recursive: true, force: true });
                log('info', `Server "${server.name}" (${id}) cleanup complete.`);
            } catch (err) {
                log('error', `Background cleanup failed for ${server.name} (${id}): ${err.message}`);
            }
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

    const { name, port, memory, javaArgs, gamemode, difficulty, seed, version, customJarUrl } = req.body;

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

    const type = server.serverType || 'vanilla';
    const newVersion = String(version || '').trim();
    let versionChanged = false;

    if (type !== 'custom' && newVersion && newVersion !== server.version) {
        if (!/^\d+\.\d+(\.\d+)?(-\w+)?$/.test(newVersion)) {
            return res.status(400).json({ error: 'Invalid version format.' });
        }

        const curParts = server.version.split('.').map(Number);
        const newParts = newVersion.split('.').map(Number);
        let isDowngrade = false;
        for (let i = 0; i < Math.max(curParts.length, newParts.length); i++) {
            const diff = (newParts[i] || 0) - (curParts[i] || 0);
            if (diff < 0) { isDowngrade = true; break; }
            if (diff > 0) break;
        }
        if (isDowngrade) {
            return res.status(400).json({ error: 'Version downgrades are not permitted.' });
        }

        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(id);
        if (proc && !['stopped', 'crashed'].includes(proc.state)) {
            return res.status(409).json({ error: 'Stop the server before changing the version.' });
        }

        let libBackupPath = null;
        try {
            if (type === 'forge' || type === 'neoforge') {
                const libSubdir = type === 'neoforge'
                    ? path.join(SERVERS_DIR, id, 'libraries', 'net', 'neoforged', 'neoforge')
                    : path.join(SERVERS_DIR, id, 'libraries', 'net', 'minecraftforge', 'forge');
                if (fs.existsSync(libSubdir)) {
                    libBackupPath = libSubdir + '.tmp';
                    fs.renameSync(libSubdir, libBackupPath);
                    log('info', `[${server.name}] Moved old ${type} libraries to .tmp before upgrade.`);
                }
            }

            const jarPath = path.join(SERVERS_DIR, id, server.jarFile || 'server.jar');
            const result = await downloadServerJar(type, newVersion, null, jarPath);
            const oldVersion = server.version;
            server.version = newVersion;
            if (result?.build) server.build = result.build;
            versionChanged = true;
            log('info', `Server "${server.name}" upgraded from ${oldVersion} to ${newVersion}.`);

            if (libBackupPath && fs.existsSync(libBackupPath)) {
                fs.rmSync(libBackupPath, { recursive: true, force: true });
            }
        } catch (err) {
            if (libBackupPath && fs.existsSync(libBackupPath)) {
                const libSubdir = libBackupPath.replace(/\.tmp$/, '');
                fs.renameSync(libBackupPath, libSubdir);
                log('info', `[${server.name}] Restored old ${type} libraries after failed upgrade.`);
            }
            log('error', `Version upgrade failed for ${id}: ${err.message}`);
            return res.status(500).json({ error: `Failed to upgrade version: ${err.message}` });
        }
    }

    let jarChanged = false;
    if (type === 'custom' && customJarUrl) {
        const newUrl = String(customJarUrl).trim();
        if (newUrl && newUrl !== (server.customJarUrl || '')) {
            const serverManager = req.app.get('serverManager');
            const proc = serverManager?.getProcess(id);
            if (proc && !['stopped', 'crashed'].includes(proc.state)) {
                return res.status(409).json({ error: 'Stop the server before changing the jar URL.' });
            }

            try {
                const jarPath = path.join(SERVERS_DIR, id, server.jarFile || 'server.jar');
                const tmpPath = jarPath + '.tmp';
                await downloadServerJar('custom', newUrl, null, tmpPath);
                if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
                fs.renameSync(tmpPath, jarPath);
                server.customJarUrl = newUrl;
                jarChanged = true;
                log('info', `Server "${server.name}" jar replaced from new URL.`);
            } catch (err) {
                log('error', `Custom jar download failed for ${id}: ${err.message}`);
                return res.status(500).json({ error: `Failed to download jar: ${err.message}` });
            }
        }
    }

    server.name = trimmedName;
    server.port = portNum;
    server.memory = memoryNum;
    server.javaArgs = safeJavaArgs;
    server.gamemode = gamemodeStr;
    server.difficulty = difficultyStr;
    server.seed = seedStr;
    await serversDb.set(`server_${id}`, server);

    const serverDir = path.join(SERVERS_DIR, id);
    if (fs.existsSync(path.join(serverDir, 'server.properties'))) {
        updateServerProperties(serverDir, {
            'server-port': String(portNum),
            'gamemode': gamemodeStr,
            'difficulty': difficultyStr,
            'level-seed': seedStr
        });
    }

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(id);
    if (proc) Object.assign(proc.config, server);

    res.json({ success: true, server, versionChanged, jarChanged });
});

// POST /servers/:id/properties — Update server.properties
router.post('/servers/:id/properties', async (req, res) => {
    const id = req.params.id;
    const server = await loadServerOr404(req, res);
    if (!server) return;

    const serverDir = path.join(SERVERS_DIR, id);
    const currentProps = parseServerProperties(serverDir);
    const updates = {};

    for (const key of Object.keys(currentProps)) {
        const meta = PROPERTY_META[key];
        if (meta && meta.type === 'boolean') {
            updates[key] = req.body[key] === 'true' || req.body[key] === true ? 'true' : 'false';
        } else if (req.body[key] !== undefined) {
            updates[key] = String(req.body[key]);
        }
    }

    updateServerProperties(serverDir, updates);
    await syncServerConfig(id);

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
