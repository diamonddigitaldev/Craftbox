const express = require('express');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb } = require('../db');
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

// GET /api/versions — Fetch Minecraft versions from Mojang
router.get('/api/versions', ensureAuth, async (req, res) => {
    try {
        const response = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        if (!response.ok) throw new Error('Failed to fetch version manifest');

        const manifest = await response.json();
        const releases = manifest.versions
            .filter(v => v.type === 'release')
            .map(v => ({ id: v.id, url: v.url }));

        res.json({ versions: releases, latest: manifest.latest.release });
    } catch (err) {
        log('error', `Failed to fetch MC versions: ${err.message}`);
        res.status(500).json({ error: 'Failed to fetch Minecraft versions.' });
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

module.exports = router;
