const express = require('express');
const os = require('os');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, SERVERS_DIR } = require('../db');
const { getProvider, listProviders } = require('../mc/serverTypes');
const { downloadServerJar } = require('../mc/downloader');
const { log } = require('../utils/log');
const { getEvents } = require('../utils/eventLogger');
const { getProcessMemory, getProcessCpu, getDirectorySize, getUptime, formatSize, formatUptime } = require('../utils/resourceStats');
const { getStatsHistory } = require('../utils/statsHistory');
const { setServerIcon, resetServerIcon, removeServerIcon, getIconPath } = require('../utils/serverIcon');
const { updateServerProperties } = require('../mc/serverProperties');

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

// GET /api/servers — JSON list of all servers
router.get('/api/servers', ensureAuth, async (req, res) => {
    try {
        const all = await serversDb.all();
        const serverManager = req.app.get('serverManager');

        const servers = all.map(row => {
            const s = { ...row.value };
            // Remove sensitive info
            delete s.directory;
            // Enrich with live state
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

// GET /api/servers/:id — JSON single server
router.get('/api/servers/:id', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

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

// GET /api/server-types — List available server types
router.get('/api/server-types', ensureAuth, (req, res) => {
    res.json({ types: listProviders() });
});

// GET /api/versions — Fetch versions for a server type (?type=vanilla|paper|...)
router.get('/api/versions', ensureAuth, async (req, res) => {
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

        // Ensure versions are sorted in reverse chronological order (newest first)
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

// GET /api/versions/:type/builds/:version — Get builds for a version (Paper, Purpur, Folia)
router.get('/api/versions/:type/builds/:version', ensureAuth, async (req, res) => {
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

// POST /api/servers/:id/autorestart — Toggle auto-restart
router.post('/api/servers/:id/autorestart', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        server.autoRestart = !!req.body.enabled;
        await serversDb.set(`server_${server.id}`, server);

        // Update live process config
        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        if (proc) proc.config.autoRestart = server.autoRestart;

        res.json({ autoRestart: server.autoRestart });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// POST /api/servers/:id/autostart — Toggle auto-start
router.post('/api/servers/:id/autostart', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        server.autoStart = !!req.body.enabled;
        await serversDb.set(`server_${server.id}`, server);

        // Update live process config
        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        if (proc) proc.config.autoStart = server.autoStart;

        res.json({ autoStart: server.autoStart });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// GET /api/servers/:id/check-update — Check if a newer build is available
router.get('/api/servers/:id/check-update', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        const type = server.serverType || 'vanilla';
        const provider = getProvider(type);
        if (!provider) return res.json({ updateAvailable: false });

        // Types without builds (vanilla, fabric, custom) — no build-level updates
        if (!provider.getBuilds || type === 'custom') {
            return res.json({ updateAvailable: false, reason: 'No build tracking for this server type.' });
        }

        const builds = await provider.getBuilds(server.version);
        if (!builds || builds.length === 0) {
            return res.json({ updateAvailable: false });
        }

        const latestBuild = builds[0].build;
        const currentBuild = server.build;

        // If no build is stored, we can't compare
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

// POST /api/servers/:id/update-jar — Download the latest build, replacing the current jar
router.post('/api/servers/:id/update-jar', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        // Server must be stopped
        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        if (proc && !['stopped', 'crashed'].includes(proc.state)) {
            return res.status(409).json({ error: 'Stop the server before updating the jar.' });
        }

        const type = server.serverType || 'vanilla';
        const provider = getProvider(type);
        if (!provider) return res.status(400).json({ error: 'Unknown server type.' });

        const jarPath = path.join(SERVERS_DIR, server.id, server.jarFile || 'server.jar');
        const result = await downloadServerJar(type, server.version, null, jarPath);

        // Update stored build number
        if (result?.build) {
            server.build = result.build;
            await serversDb.set(`server_${server.id}`, server);
        }

        log('info', `Server "${server.name}" jar updated to build ${result?.build || 'latest'}.`);
        res.json({ success: true, build: result?.build || null });
    } catch (err) {
        log('error', `Update-jar failed for ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: `Failed to update jar: ${err.message}` });
    }
});

// POST /api/servers/:id/backup-schedule — Update backup schedule settings
router.post('/api/servers/:id/backup-schedule', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

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

        await serversDb.set(`server_${server.id}`, server);

        // Update the scheduler
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

// POST /api/servers/:id/backup-retention — Update retention policy
router.post('/api/servers/:id/backup-retention', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

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

// GET /api/servers/:id/events — Get event history for a server
router.get('/api/servers/:id/events', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const types = req.query.types ? req.query.types.split(',') : null;
        const events = await getEvents(server.id, { limit, types });

        res.json({ events });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch events.' });
    }
});

// GET /api/servers/:id/stats — Get resource stats for a server
router.get('/api/servers/:id/stats', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        const serverManager = req.app.get('serverManager');
        const statsCollector = req.app.get('statsCollector');
        const proc = serverManager?.getProcess(server.id);

        // Use cached stats from background collector when available
        const cached = statsCollector?.getLatestStats(server.id);

        let stats;
        if (cached && proc && proc.state === 'running') {
            stats = { ...cached };
            // Refresh uptime and players from live data
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

        // Disk size is computed on demand (expensive, not polled in background)
        const serverDir = path.resolve(server.directory);
        stats.diskBytes = getDirectorySize(serverDir);
        stats.diskFormatted = formatSize(stats.diskBytes);

        const history = await getStatsHistory(server.id);
        res.json({ stats, history });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// POST /api/servers/:id/statuspublic — Toggle status page visibility
router.post('/api/servers/:id/statuspublic', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        server.statusPagePublic = !!req.body.enabled;
        await serversDb.set(`server_${server.id}`, server);

        res.json({ statusPagePublic: server.statusPagePublic });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// POST /api/servers/:id/advertisedip — Update advertised IP
router.post('/api/servers/:id/advertisedip', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        server.advertisedIp = String(req.body.value || '').trim() || null;
        await serversDb.set(`server_${server.id}`, server);

        res.json({ advertisedIp: server.advertisedIp });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting.' });
    }
});

// POST /api/servers/:id/icon — Upload server icon
router.post('/api/servers/:id/icon', ensureAuth, function (req, res, next) {
    iconUpload.single('icon')(req, res, function (err) {
        if (err) {
            return res.status(400).json({ error: err.message || 'Upload failed.' });
        }
        next();
    });
}, async (req, res) => {
    const fs = require('fs');
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        await setServerIcon(req.params.id, req.file.path);

        // Clean up temp file
        fs.unlink(req.file.path, () => {});

        log('info', `Server "${server.name}" icon updated.`);
        res.json({ success: true });
    } catch (err) {
        // Clean up temp file on error
        if (req.file) fs.unlink(req.file.path, () => {});
        log('error', `Failed to update server icon: ${err.message}`);
        res.status(500).json({ error: 'Failed to update server icon.' });
    }
});

// POST /api/servers/:id/icon/reset — Reset server icon to Craftbox default
router.post('/api/servers/:id/icon/reset', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

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

// GET /api/servers/:id/icon — Get current server icon
router.get('/api/servers/:id/icon', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        const iconPath = getIconPath(req.params.id);
        const fs = require('fs');
        if (!fs.existsSync(iconPath)) {
            return res.status(404).json({ error: 'No icon set.' });
        }

        res.type('image/png').sendFile(path.resolve(iconPath));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch icon.' });
    }
});

// DELETE /api/servers/:id/icon — Remove server icon entirely
router.delete('/api/servers/:id/icon', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        removeServerIcon(req.params.id);

        log('info', `Server "${server.name}" icon removed.`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to remove server icon: ${err.message}`);
        res.status(500).json({ error: 'Failed to remove server icon.' });
    }
});

// POST /api/servers/:id/motd — Update server MOTD
router.post('/api/servers/:id/motd', ensureAuth, async (req, res) => {
    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        const motd = String(req.body.motd ?? 'A Minecraft Server');
        const serverDir = path.join(SERVERS_DIR, server.id);
        updateServerProperties(serverDir, { motd });

        log('info', `Server "${server.name}" MOTD updated.`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to update MOTD: ${err.message}`);
        res.status(500).json({ error: 'Failed to update MOTD.' });
    }
});

module.exports = router;
