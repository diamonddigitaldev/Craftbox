const express = require('express');
const path = require('path');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, SERVERS_DIR } = require('../db');
const { getProvider, listProviders } = require('../mc/serverTypes');
const { downloadServerJar } = require('../mc/downloader');
const { log } = require('../utils/log');

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
        res.json({ versions: result.versions, latest: result.latest });
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

module.exports = router;
