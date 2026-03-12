const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, SERVERS_DIR } = require('../db');
const { downloadVanillaJar } = require('../mc/downloader');
const { writeServerProperties, writeEula } = require('../mc/serverProperties');
const { log } = require('../utils/log');

// GET /servers/create — Server creation form
router.get('/servers/create', ensureAuth, (req, res) => {
    res.render('servers/create', {
        title: 'Create Server',
        navbar: true,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// POST /servers/create — Create a new server
router.post('/servers/create', ensureAuth, async (req, res) => {
    const { name, version, port, memory, javaArgs, eula, gamemode, difficulty, seed } = req.body;

    // Validation
    if (!name || !version || !port || !memory) {
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

    const versionStr = String(version).trim();
    if (!/^\d+\.\d+(\.\d+)?(-\w+)?$/.test(versionStr) && versionStr !== 'latest') {
        req.session.flash = { error: 'Invalid Minecraft version format.' };
        return res.redirect('/servers/create');
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

        log('info', `Creating server "${trimmedName}" (${id}) — version ${versionStr}`);

        // Download server jar
        await downloadVanillaJar(versionStr, path.join(serverDir, 'server.jar'));

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
            state: 'stopped',
            port: portNum,
            memory: memoryNum,
            javaArgs: safeJavaArgs,
            version: versionStr,
            gamemode: gamemodeStr,
            difficulty: difficultyStr,
            seed: seedStr,
            jarFile: 'server.jar',
            eula: true,
            autoRestart: false,
            autoStart: false,
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
        await serverManager.startServer(req.params.id);
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
        await serverManager.stopServer(req.params.id);
        req.session.flash = { success: 'Server is stopping...' };
    } catch (err) {
        req.session.flash = { error: err.message };
    }
    res.redirect(`/servers/${req.params.id}`);
});

// POST /servers/:id/restart
router.post('/servers/:id/restart', ensureAuth, async (req, res) => {
    const serverManager = req.app.get('serverManager');
    try {
        await serverManager.restartServer(req.params.id);
        req.session.flash = { success: 'Server is restarting...' };
    } catch (err) {
        req.session.flash = { error: err.message };
    }
    res.redirect(`/servers/${req.params.id}`);
});

// POST /servers/:id/kill
router.post('/servers/:id/kill', ensureAuth, async (req, res) => {
    const serverManager = req.app.get('serverManager');
    try {
        await serverManager.killServer(req.params.id);
        req.session.flash = { warning: 'Server force-killed.' };
    } catch (err) {
        req.session.flash = { error: err.message };
    }
    res.redirect(`/servers/${req.params.id}`);
});

// POST /servers/:id/delete
router.post('/servers/:id/delete', ensureAuth, async (req, res) => {
    const id = req.params.id;
    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    // Don't delete running servers
    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        req.session.flash = { error: 'Stop the server before deleting it.' };
        return res.redirect(`/servers/${id}`);
    }

    try {
        // Remove process from manager
        serverManager?.removeProcess(id);

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

module.exports = router;
