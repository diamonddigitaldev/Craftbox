const express = require('express');
const fs = require('fs');
const path = require('path');
const contentDisposition = require('content-disposition');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, SERVERS_DIR } = require('../db');
const { downloadServerJar } = require('../mc/downloader');
const { getProvider } = require('../mc/serverTypes');
const { writeServerProperties, writeEula, parseServerProperties, updateServerProperties } = require('../mc/serverProperties');
const { PROPERTY_META, GROUPS } = require('../mc/propertyMeta');
const { log } = require('../utils/log');
const { logEvent, deleteServerEvents } = require('../utils/eventLogger');
const { syncServerConfig } = require('../mc/syncServerConfig');
const { clearStatsHistory } = require('../utils/statsHistory');
const { getContentType } = require('../utils/contentType');
const { copyDefaultIcon, hasIcon } = require('../utils/serverIcon');
const { STATES } = require('../mc/stateMachine');

// GET /servers/create — Server creation form
router.get('/servers/create', ensureAuth, (req, res) => {
    res.render('servers/create', {
        title: 'Create Server',
        description: 'Set up a new Minecraft server instance.',
        navbar: true,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// POST /servers/create — Create a new server
router.post('/servers/create', ensureAuth, async (req, res) => {
    const { name, version, port, memory, javaArgs, eula, gamemode, difficulty, seed, serverType, customJarUrl } = req.body;

    // Validation
    if (!name || !port || !memory) {
        req.session.flash = { error: 'All required fields must be filled.' };
        return res.redirect('/servers/create');
    }

    const trimmedName = String(name).trim();
    if (trimmedName.length < 1 || trimmedName.length > 50) {
        req.session.flash = { error: 'Server name must be 1–50 characters.' };
        return res.redirect('/servers/create');
    }
    if (!/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        req.session.flash = { error: 'Server name can only contain letters, numbers, spaces, hyphens, and underscores.' };
        return res.redirect('/servers/create');
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        req.session.flash = { error: 'Port must be between 1024 and 65535.' };
        return res.redirect('/servers/create');
    }

    const memoryNum = parseInt(memory, 10);
    if (isNaN(memoryNum) || memoryNum < 512 || memoryNum > 65536) {
        req.session.flash = { error: 'Memory must be between 512 and 65536 MB.' };
        return res.redirect('/servers/create');
    }

    if (!eula) {
        req.session.flash = { error: 'You must accept the Minecraft EULA.' };
        return res.redirect('/servers/create');
    }

    // Validate server type
    const type = serverType || 'vanilla';
    const provider = getProvider(type);
    if (!provider) {
        req.session.flash = { error: 'Invalid server type.' };
        return res.redirect('/servers/create');
    }

    // Custom type requires a URL instead of a version
    if (type === 'custom') {
        if (!customJarUrl || typeof customJarUrl !== 'string' || customJarUrl.trim().length === 0) {
            req.session.flash = { error: 'A download URL is required for custom server jars.' };
            return res.redirect('/servers/create');
        }
        try {
            const parsed = new URL(customJarUrl.trim());
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        } catch {
            req.session.flash = { error: 'Invalid jar download URL.' };
            return res.redirect('/servers/create');
        }
    }

    const versionStr = String(version || '').trim();
    // Validate version format for non-custom types
    if (type !== 'custom') {
        if (!versionStr || (!/^\d+\.\d+(\.\d+)?(-\w+)?$/.test(versionStr) && versionStr !== 'latest')) {
            req.session.flash = { error: 'Invalid Minecraft version format.' };
            return res.redirect('/servers/create');
        }
    }

    // Sanitize javaArgs — only allow safe JVM flag patterns
    const safeJavaArgs = String(javaArgs || '').trim();

    // Validate game settings
    const validGamemodes = ['survival', 'creative', 'adventure', 'spectator'];
    const validDifficulties = ['peaceful', 'easy', 'normal', 'hard'];
    const gamemodeStr = validGamemodes.includes(gamemode) ? gamemode : 'survival';
    const difficultyStr = validDifficulties.includes(difficulty) ? difficulty : 'easy';
    const seedStr = String(seed || '').trim();

    try {
        const id = uuidv4();
        const serverDir = path.join(SERVERS_DIR, id);
        const logsDir = path.join(serverDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });

        // Create plugins/mods directory for supported server types
        const contentType = getContentType(type);
        if (contentType) {
            fs.mkdirSync(path.join(serverDir, contentType.folder), { recursive: true });
        }

        // Copy default Craftbox icon as server-icon.png
        copyDefaultIcon(id);

        log('info', `Creating server "${trimmedName}" (${id}) — ${type} ${type === 'custom' ? '' : versionStr}`);

        // Download server jar via the appropriate provider
        const jarVersion = type === 'custom' ? customJarUrl.trim() : versionStr;
        const downloadResult = await downloadServerJar(type, jarVersion, null, path.join(serverDir, 'server.jar'));

        // Write server.properties and eula.txt
        writeServerProperties(serverDir, {
            serverPort: portNum,
            gamemode: gamemodeStr,
            difficulty: difficultyStr,
            levelSeed: seedStr
        });
        writeEula(serverDir);

        // Register in database
        const server = {
            id,
            name: trimmedName,
            serverType: type,
            build: downloadResult?.build || null,
            state: 'stopped',
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
        log('info', `Server "${trimmedName}" (${id}) created successfully.`);

        req.session.flash = { success: `Server "${trimmedName}" created successfully.` };
        res.redirect(`/servers/${id}`);
    } catch (err) {
        log('error', `Failed to create server: ${err.message}`);
        req.session.flash = { error: `Failed to create server: ${err.message}` };
        res.redirect('/servers/create');
    }
});

// GET /servers/:id — Server detail page
router.get('/servers/:id', ensureAuth, async (req, res) => {
    const id = req.params.id;

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Invalid server ID.'
        });
    }

    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    // Enrich with live state
    const serverManager = req.app.get('serverManager');
    if (serverManager) {
        const proc = serverManager.getProcess(id);
        if (proc) {
            server.state = proc.state;
        }
    }

    res.render('servers/view', {
        title: server.name,
        description: `View live logs and resource metrics for ${server.name}.`,
        navbar: true,
        fluid: true,
        user: req.user,
        server,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// POST /servers/:id/start
router.post('/servers/:id/start', ensureAuth, async (req, res) => {
    const serverManager = req.app.get('serverManager');
    try {
        await clearStatsHistory(req.params.id);
        await serverManager.startServer(req.params.id, { initiatedBy: req.user.username });
        logEvent(req.params.id, 'action', 'Server start requested', { initiatedBy: req.user.username }).catch(() => {});
        req.session.flash = { success: 'Server is starting...' };
    } catch (err) {
        req.session.flash = { error: err.message };
    }
    res.redirect(`/servers/${req.params.id}`);
});

// POST /servers/:id/stop
router.post('/servers/:id/stop', ensureAuth, async (req, res) => {
    const serverManager = req.app.get('serverManager');
    try {
        await clearStatsHistory(req.params.id);
        await serverManager.stopServer(req.params.id, { initiatedBy: req.user.username });
        logEvent(req.params.id, 'action', 'Server stop requested', { initiatedBy: req.user.username }).catch(() => {});
        req.session.flash = { success: 'Server is stopping...' };
    } catch (err) {
        req.session.flash = { error: err.message };
    }
    res.redirect(`/servers/${req.params.id}`);
});

// POST /servers/:id/restart
router.post('/servers/:id/restart', ensureAuth, async (req, res) => {
    const serverManager = req.app.get('serverManager');
    const id = req.params.id;
    const createBackupFirst = req.body.backup === 'true' || req.body.backup === true;

    try {
        // Create backup before restart if requested
        if (createBackupFirst) {
            const { createBackup } = require('../mc/BackupManager');

            // Stop the server first so the backup captures a consistent state
            const proc = serverManager?.getProcess(id);
            if (proc && ['running', 'starting'].includes(proc.state)) {
                await serverManager.stopServer(id, { initiatedBy: req.user.username });
                await proc.waitForState('stopped', 60000);
            }

            // Sync server metadata before backup so the backup includes current DB state
            await syncServerConfig(id);

            await serverManager.setOperationalState(id, STATES.BACKING_UP);
            try {
                await createBackup(id, 'Pre-restart backup', 'manual');
                logEvent(id, 'action', 'Pre-restart backup created', { initiatedBy: req.user.username }).catch(() => {});
            } finally {
                await serverManager.setOperationalState(id, STATES.STOPPED);
            }

            // Now start the server (since we stopped it for backup)
            await clearStatsHistory(id);
            await serverManager.startServer(id, { initiatedBy: req.user.username });
            logEvent(id, 'action', 'Server restarted with backup', { initiatedBy: req.user.username }).catch(() => {});
            req.session.flash = { success: 'Backup created and server is restarting...' };
        } else {
            await clearStatsHistory(id);
            await serverManager.restartServer(id, { initiatedBy: req.user.username });
            logEvent(id, 'action', 'Server restart requested', { initiatedBy: req.user.username }).catch(() => {});
            req.session.flash = { success: 'Server is restarting...' };
        }
    } catch (err) {
        req.session.flash = { error: err.message };
    }
    res.redirect(`/servers/${id}`);
});

// POST /servers/:id/kill
router.post('/servers/:id/kill', ensureAuth, async (req, res) => {
    const serverManager = req.app.get('serverManager');
    try {
        await clearStatsHistory(req.params.id);
        await serverManager.killServer(req.params.id, { initiatedBy: req.user.username });
        logEvent(req.params.id, 'action', 'Server force-killed', { initiatedBy: req.user.username }).catch(() => {});
        req.session.flash = { warning: 'Server force-killed.' };
    } catch (err) {
        req.session.flash = { error: err.message };
    }
    res.redirect(`/servers/${req.params.id}`);
});

// POST /servers/:id/duplicate
router.post('/servers/:id/duplicate', ensureAuth, async (req, res) => {
    const id = req.params.id;
    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(id);
    const stopFirst = req.body.stopFirst === 'true' || req.body.stopFirst === true;
    const startAfter = req.body.startAfter === 'true' || req.body.startAfter === true;

    // Server must be stopped (or user chose to stop it)
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        if (!stopFirst) {
            req.session.flash = { error: 'Stop the server before duplicating it.' };
            return res.redirect(`/servers/${id}/edit`);
        }
        try {
            if (proc.state === 'running' || proc.state === 'starting') {
                await serverManager.stopServer(id);
                await proc.waitForState('stopped', 60000);
            }
        } catch (err) {
            log('error', `Failed to stop server before duplicate: ${err.message}`);
            req.session.flash = { error: `Failed to stop server: ${err.message}` };
            return res.redirect(`/servers/${id}/edit`);
        }
    }

    const { name, port, includeWorld } = req.body;

    // Validate name
    const trimmedName = String(name || '').trim();
    if (trimmedName.length < 1 || trimmedName.length > 50 || !/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        req.session.flash = { error: 'Invalid server name.' };
        return res.redirect(`/servers/${id}/edit`);
    }

    // Validate port
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        req.session.flash = { error: 'Port must be between 1024 and 65535.' };
        return res.redirect(`/servers/${id}/edit`);
    }

    try {
        const newId = uuidv4();
        const sourceDir = path.join(SERVERS_DIR, id);
        const newDir = path.join(SERVERS_DIR, newId);

        // Copy the entire server directory
        fs.cpSync(sourceDir, newDir, { recursive: true });

        // Remove world data if not requested
        if (includeWorld !== 'true' && includeWorld !== true) {
            const worldDirs = ['world', 'world_nether', 'world_the_end'];
            for (const dir of worldDirs) {
                const worldPath = path.join(newDir, dir);
                if (fs.existsSync(worldPath)) {
                    fs.rmSync(worldPath, { recursive: true, force: true });
                }
            }
        }

        // Clear log files in the new server
        const logsDir = path.join(newDir, 'logs');
        if (fs.existsSync(logsDir)) {
            fs.rmSync(logsDir, { recursive: true, force: true });
        }
        fs.mkdirSync(logsDir, { recursive: true });

        // Update server.properties with new port
        const { updateServerProperties } = require('../mc/serverProperties');
        updateServerProperties(newDir, { 'server-port': String(portNum) });

        // Create new DB entry
        const newServer = {
            ...server,
            id: newId,
            name: trimmedName,
            port: portNum,
            state: 'stopped',
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
        log('info', `Server "${trimmedName}" (${newId}) duplicated from "${server.name}" (${id}).`);

        // Start backup schedule for duplicated server if enabled
        if (newServer.backupSchedule?.enabled) {
            const backupScheduler = req.app.get('backupScheduler');
            if (backupScheduler) {
                await backupScheduler.restartSchedule(newId);
            }
        }

        // Restart original server if requested
        if (startAfter && stopFirst) {
            try {
                await serverManager.startServer(id);
            } catch (err) {
                log('error', `Failed to restart server after duplicate: ${err.message}`);
                req.session.flash = { warning: `Server duplicated as "${trimmedName}", but the original server failed to restart: ${err.message}` };
                return res.redirect(`/servers/${newId}`);
            }
        }

        req.session.flash = { success: `Server duplicated as "${trimmedName}".` };
        res.redirect(`/servers/${newId}`);
    } catch (err) {
        log('error', `Failed to duplicate server ${id}: ${err.message}`);
        req.session.flash = { error: `Failed to duplicate server: ${err.message}` };
        res.redirect(`/servers/${id}/edit`);
    }
});

// POST /servers/:id/delete
router.post('/servers/:id/delete', ensureAuth, async (req, res) => {
    const id = req.params.id;
    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    // Don't delete running/busy servers
    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(id);
    const liveState = proc ? proc.state : server.state;
    if (!['stopped', 'crashed'].includes(liveState)) {
        req.session.flash = { error: 'Stop the server before deleting it.' };
        return res.redirect(`/servers/${id}`);
    }

    try {
        // Remove process from manager
        serverManager?.removeProcess(id);

        // Stop backup schedule and delete all backups
        const backupScheduler = req.app.get('backupScheduler');
        if (backupScheduler) backupScheduler.stopSchedule(id);
        const { deleteAllBackups } = require('../mc/BackupManager');
        await deleteAllBackups(id);

        // Delete server events and stats history
        await deleteServerEvents(id);
        await clearStatsHistory(id);

        // Delete server directory
        const serverDir = path.join(SERVERS_DIR, id);
        if (fs.existsSync(serverDir)) {
            fs.rmSync(serverDir, { recursive: true, force: true });
        }

        // Remove from database
        await serversDb.delete(`server_${id}`);
        log('info', `Server "${server.name}" (${id}) deleted.`);

        req.session.flash = { success: `Server "${server.name}" deleted.` };
        res.redirect('/dashboard');
    } catch (err) {
        log('error', `Failed to delete server ${id}: ${err.message}`);
        req.session.flash = { error: `Failed to delete server: ${err.message}` };
        res.redirect(`/servers/${id}`);
    }
});

// ── Helper: load server with live state ──
async function getServerWithState(req) {
    const id = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const server = await serversDb.get(`server_${id}`);
    if (!server) return null;
    const serverManager = req.app.get('serverManager');
    if (serverManager) {
        const proc = serverManager.getProcess(id);
        if (proc) server.state = proc.state;
    }
    return server;
}

// ── Helper: format file size ──
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
}

// ═══════════════════════════════════════════
// Edit Server Settings
// ═══════════════════════════════════════════

router.get('/servers/:id/edit', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    // Read current MOTD from server.properties
    const serverDir = path.join(SERVERS_DIR, server.id);
    const props = parseServerProperties(serverDir);
    const currentMotd = props.motd || 'A Minecraft Server';

    res.render('servers/edit', {
        title: server.name + ' Settings',
        description: `Configure basic server and runtime settings for ${server.name}.`,
        server,
        currentMotd,
        hasIcon: hasIcon(server.id),
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

router.post('/servers/:id/edit', ensureAuth, async (req, res) => {
    const id = req.params.id;
    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    const { name, port, memory, javaArgs, gamemode, difficulty, seed, version, customJarUrl } = req.body;

    const trimmedName = String(name).trim();
    if (trimmedName.length < 1 || trimmedName.length > 50 || !/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        req.session.flash = { error: 'Invalid server name.' };
        return res.redirect(`/servers/${id}/edit`);
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        req.session.flash = { error: 'Port must be between 1024 and 65535.' };
        return res.redirect(`/servers/${id}/edit`);
    }

    const memoryNum = parseInt(memory, 10);
    if (isNaN(memoryNum) || memoryNum < 512 || memoryNum > 65536) {
        req.session.flash = { error: 'Memory must be between 512 and 65536 MB.' };
        return res.redirect(`/servers/${id}/edit`);
    }

    const validGamemodes = ['survival', 'creative', 'adventure', 'spectator'];
    const validDifficulties = ['peaceful', 'easy', 'normal', 'hard'];
    const gamemodeStr = validGamemodes.includes(gamemode) ? gamemode : server.gamemode;
    const difficultyStr = validDifficulties.includes(difficulty) ? difficulty : server.difficulty;
    const seedStr = String(seed || '').trim();
    const safeJavaArgs = String(javaArgs || '').trim();

    // Handle version upgrade (non-custom types only)
    const type = server.serverType || 'vanilla';
    const newVersion = String(version || '').trim();
    let versionChanged = false;

    if (type !== 'custom' && newVersion && newVersion !== server.version) {
        // Validate version format
        if (!/^\d+\.\d+(\.\d+)?(-\w+)?$/.test(newVersion)) {
            req.session.flash = { error: 'Invalid version format.' };
            return res.redirect(`/servers/${id}/edit`);
        }

        // Prevent downgrades: compare version parts numerically
        const curParts = server.version.split('.').map(Number);
        const newParts = newVersion.split('.').map(Number);
        let isDowngrade = false;
        for (let i = 0; i < Math.max(curParts.length, newParts.length); i++) {
            const diff = (newParts[i] || 0) - (curParts[i] || 0);
            if (diff < 0) { isDowngrade = true; break; }
            if (diff > 0) break;
        }
        if (isDowngrade) {
            req.session.flash = { error: 'Version downgrades are not permitted.' };
            return res.redirect(`/servers/${id}/edit`);
        }

        // Server must be stopped to change version
        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(id);
        if (proc && !['stopped', 'crashed'].includes(proc.state)) {
            req.session.flash = { error: 'Stop the server before changing the version.' };
            return res.redirect(`/servers/${id}/edit`);
        }

        // Download the new server jar
        let libBackupPath = null;
        try {
            // For Forge/NeoForge, rename old version library directories before installing new version
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

            // Download succeeded — clean up the old libraries backup
            if (libBackupPath && fs.existsSync(libBackupPath)) {
                fs.rmSync(libBackupPath, { recursive: true, force: true });
            }
        } catch (err) {
            // Download failed — restore the old libraries if we moved them
            if (libBackupPath && fs.existsSync(libBackupPath)) {
                const libSubdir = libBackupPath.replace(/\.tmp$/, '');
                fs.renameSync(libBackupPath, libSubdir);
                log('info', `[${server.name}] Restored old ${type} libraries after failed upgrade.`);
            }
            log('error', `Version upgrade failed for ${id}: ${err.message}`);
            req.session.flash = { error: `Failed to upgrade version: ${err.message}` };
            return res.redirect(`/servers/${id}/edit`);
        }
    }

    // Handle custom jar URL change
    let jarChanged = false;
    if (type === 'custom' && customJarUrl) {
        const newUrl = String(customJarUrl).trim();
        if (newUrl && newUrl !== (server.customJarUrl || '')) {
            // Server must be stopped to change jar
            const serverManager = req.app.get('serverManager');
            const proc = serverManager?.getProcess(id);
            if (proc && !['stopped', 'crashed'].includes(proc.state)) {
                req.session.flash = { error: 'Stop the server before changing the jar URL.' };
                return res.redirect(`/servers/${id}/edit`);
            }

            // Download new jar to a temp file first, then replace the old one
            try {
                const jarPath = path.join(SERVERS_DIR, id, server.jarFile || 'server.jar');
                const tmpPath = jarPath + '.tmp';
                await downloadServerJar('custom', newUrl, null, tmpPath);
                // Download succeeded — safe to replace the old jar
                if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
                fs.renameSync(tmpPath, jarPath);
                server.customJarUrl = newUrl;
                jarChanged = true;
                log('info', `Server "${server.name}" jar replaced from new URL.`);
            } catch (err) {
                log('error', `Custom jar download failed for ${id}: ${err.message}`);
                req.session.flash = { error: `Failed to download jar: ${err.message}` };
                return res.redirect(`/servers/${id}/edit`);
            }
        }
    }

    // Update DB
    server.name = trimmedName;
    server.port = portNum;
    server.memory = memoryNum;
    server.javaArgs = safeJavaArgs;
    server.gamemode = gamemodeStr;
    server.difficulty = difficultyStr;
    server.seed = seedStr;
    await serversDb.set(`server_${id}`, server);

    // Update server.properties
    const serverDir = path.join(SERVERS_DIR, id);
    if (fs.existsSync(path.join(serverDir, 'server.properties'))) {
        updateServerProperties(serverDir, {
            'server-port': String(portNum),
            'gamemode': gamemodeStr,
            'difficulty': difficultyStr,
            'level-seed': seedStr
        });
    }

    // Update live process config
    const serverManager2 = req.app.get('serverManager');
    const proc2 = serverManager2?.getProcess(id);
    if (proc2) Object.assign(proc2.config, server);

    const successMsg = versionChanged
        ? `Server settings saved. Version upgraded to ${server.version}.`
        : jarChanged
            ? 'Server settings saved. Server jar replaced.'
            : 'Server settings saved.';
    req.session.flash = { success: successMsg };
    res.redirect(`/servers/${id}/edit?saved=1`);
});

// ═══════════════════════════════════════════
// Server Properties Editor (Phase 3)
// ═══════════════════════════════════════════

router.get('/servers/:id/properties', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const serverDir = path.join(SERVERS_DIR, server.id);
    const properties = parseServerProperties(serverDir);

    res.render('servers/properties', {
        title: server.name + ' Properties',
        description: `Edit server properties for ${server.name}.`,
        server,
        properties,
        propertyMeta: PROPERTY_META,
        groups: GROUPS,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

router.post('/servers/:id/properties', ensureAuth, async (req, res) => {
    const id = req.params.id;
    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    const serverDir = path.join(SERVERS_DIR, id);
    const currentProps = parseServerProperties(serverDir);
    const updates = {};

    for (const key of Object.keys(currentProps)) {
        const meta = PROPERTY_META[key];
        if (meta && meta.type === 'boolean') {
            // Unchecked checkboxes don't send a value
            updates[key] = req.body[key] === 'true' ? 'true' : 'false';
        } else if (req.body[key] !== undefined) {
            updates[key] = String(req.body[key]);
        }
    }

    updateServerProperties(serverDir, updates);

    // Sync mirrored DB fields from the updated server.properties
    await syncServerConfig(id);

    req.session.flash = { success: 'Server properties saved.' };
    res.redirect(`/servers/${id}/properties?saved=1`);
});

// ═══════════════════════════════════════════
// File Browser & Editor
// ═══════════════════════════════════════════

const TEXT_EXTENSIONS = new Set([
    '.txt', '.log', '.properties', '.json', '.yml', '.yaml', '.xml',
    '.cfg', '.conf', '.ini', '.toml', '.csv', '.md', '.sh', '.bat',
    '.cmd', '.ps1', '.js', '.ts', '.py', '.java', '.html', '.css',
    '.mcmeta', '.lang', '.sk', '.nbt'
]);

function isTextFile(filename) {
    return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

async function handleFiles(req, res, subpath) {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, subpath || '');

    // Security: prevent directory traversal
    if (!targetPath.startsWith(serverDir)) {
        return res.status(403).render('errors/403', {
            title: 'Forbidden', navbar: true, user: req.user, message: 'Access denied.'
        });
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Directory not found.'
        });
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files = entries.map(entry => {
        const entryPath = path.join(targetPath, entry.name);
        let stat;
        try { stat = fs.statSync(entryPath); } catch { return null; }
        return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stat.size,
            sizeFormatted: formatSize(stat.size),
            modified: stat.mtime,
            modifiedISO: stat.mtime.toISOString(),
            editable: !entry.isDirectory() && isTextFile(entry.name)
        };
    }).filter(Boolean).sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    const breadcrumbs = subpath ? subpath.split('/').filter(Boolean) : [];
    const parentPath = breadcrumbs.length > 1 ? breadcrumbs.slice(0, -1).join('/') : '';

    res.render('servers/files', {
        title: server.name + ' Files',
        description: `Browse and manage files for ${server.name}.`,
        server,
        files,
        breadcrumbs,
        currentPath: subpath || '',
        parentPath,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
}

router.get('/servers/:id/files', ensureAuth, (req, res) => handleFiles(req, res, ''));
router.get('/servers/:id/files/*subpath', ensureAuth, (req, res) => {
    // Express 5 returns wildcard params as an array of segments
    const sub = Array.isArray(req.params.subpath) ? req.params.subpath.join('/') : req.params.subpath;
    handleFiles(req, res, sub);
});

// Individual file download
router.get('/servers/:id/download', ensureAuth, async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Not found' });

    // Only allow downloads when server is stopped to avoid file corruption
    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        req.session.flash = { error: 'Stop the server before downloading files.' };
        return res.redirect(`/servers/${server.id}/files`);
    }

    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'No path specified' });

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, filePath);

    if (!targetPath.startsWith(serverDir)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        return res.status(404).json({ error: 'File not found' });
    }

    const fileName = path.basename(targetPath);
    res.setHeader('Content-Disposition', contentDisposition(fileName));
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = fs.createReadStream(targetPath);
    stream.on('error', (err) => {
        if (!res.headersSent) {
            if (err.code === 'EBUSY') {
                res.status(409).json({ error: 'File is currently in use by the server. Try again later or stop the server first.' });
            } else {
                res.status(500).json({ error: 'Failed to download file.' });
            }
        }
    });
    stream.pipe(res);
});

// Full server directory download as .zip
router.get('/servers/:id/download-zip', ensureAuth, async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Not found' });

    // Only allow ZIP download when server is stopped to avoid file corruption
    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        req.session.flash = { error: 'Stop the server before downloading.' };
        return res.redirect(`/servers/${server.id}/files`);
    }

    const serverDir = path.join(SERVERS_DIR, server.id);
    if (!fs.existsSync(serverDir)) return res.status(404).json({ error: 'Directory not found' });

    const archiver = require('archiver');
    const safeName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${safeName}.zip`));

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
        log('error', `Archive error for ${server.name}: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Archive failed' });
    });
    archive.pipe(res);
    archive.directory(serverDir, false);
    archive.finalize();
});

router.get('/servers/:id/edit-file', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const filePath = req.query.path;
    if (!filePath) return res.redirect(`/servers/${server.id}/files`);

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, filePath);

    if (!targetPath.startsWith(serverDir)) {
        return res.status(403).render('errors/403', {
            title: 'Forbidden', navbar: true, user: req.user, message: 'Access denied.'
        });
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'File not found.'
        });
    }

    if (!isTextFile(path.basename(targetPath))) {
        return res.status(400).render('errors/404', {
            title: 'Not Editable', navbar: true, user: req.user, message: 'This file type cannot be edited.'
        });
    }

    let content;
    try {
        content = fs.readFileSync(targetPath, 'utf8');
    } catch (err) {
        req.session.flash = { error: 'Could not read file: ' + err.message };
        return res.redirect(`/servers/${server.id}/files`);
    }

    const breadcrumbs = filePath.split('/').filter(Boolean);
    const fileName = breadcrumbs[breadcrumbs.length - 1];

    res.render('servers/fileEdit', {
        title: server.name + ' | Edit ' + fileName,
        description: `Edit ${fileName} for ${server.name}.`,
        server,
        filePath,
        fileName,
        content,
        breadcrumbs,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

router.post('/servers/:id/edit-file', ensureAuth, async (req, res) => {
    const id = req.params.id;
    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    const filePath = req.body.filePath;
    if (!filePath) {
        req.session.flash = { error: 'No file path specified.' };
        return res.redirect(`/servers/${id}/files`);
    }

    const serverDir = path.resolve(SERVERS_DIR, id);
    const targetPath = path.resolve(serverDir, filePath);

    if (!targetPath.startsWith(serverDir)) {
        req.session.flash = { error: 'Access denied.' };
        return res.redirect(`/servers/${id}/files`);
    }

    if (!isTextFile(path.basename(targetPath))) {
        req.session.flash = { error: 'This file type cannot be edited.' };
        return res.redirect(`/servers/${id}/files`);
    }

    try {
        const content = req.body.content || '';
        fs.writeFileSync(targetPath, content, 'utf8');
        log('info', `File edited: ${filePath} on server ${server.name} (${id})`);

        // If server.properties or eula.txt was edited, sync mirrored fields back to DB
        const editedFile = path.basename(targetPath);
        if (editedFile === 'server.properties' || editedFile === 'eula.txt') {
            await syncServerConfig(id);
        }

        req.session.flash = { success: `File "${path.basename(targetPath)}" saved.` };
    } catch (err) {
        log('error', `Failed to save file ${filePath}: ${err.message}`);
        req.session.flash = { error: 'Failed to save file: ' + err.message };
    }

    // Redirect back to the parent directory in the file browser
    const parentDir = filePath.split('/').slice(0, -1).join('/');
    res.redirect(`/servers/${id}/files${parentDir ? '/' + parentDir : ''}`);
});

module.exports = router;
