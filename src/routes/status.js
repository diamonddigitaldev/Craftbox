const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const contentDisposition = require('content-disposition');
const router = express.Router();
const { serversDb } = require('../db');
const { getEvents } = require('../utils/eventLogger');
const { getUptime, formatUptime } = require('../utils/resourceStats');
const { log } = require('../utils/log');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only these event types are shown on public pages
const PUBLIC_EVENT_TYPES = ['started', 'stopped', 'crashed', 'restarted'];

/**
 * Sanitize server data for public consumption.
 * NEVER expose: directory, crashReason, javaArgs, exitCode, file paths.
 */
function sanitizeForPublic(server, proc) {
    const state = proc?.state || server.state;
    const running = state === 'running';
    return {
        id: server.id,
        name: server.name,
        state,
        port: server.port,
        version: (server.serverType || 'vanilla') === 'custom' ? null : server.version,
        serverType: server.serverType || 'vanilla',
        playerCount: proc ? proc.players.size : 0,
        players: proc ? Array.from(proc.players).sort((a, b) => a.localeCompare(b)) : [],
        uptime: running ? getUptime(server.lastStarted) : 0,
        uptimeFormatted: running ? formatUptime(getUptime(server.lastStarted)) : 'Offline',
        statusPagePublic: !!server.statusPagePublic,
        advertisedIp: server.advertisedIp || null
    };
}

// GET /status — Public status list page (only public servers)
router.get('/status', async (req, res) => {
    try {
        const all = await serversDb.all();
        const serverManager = req.app.get('serverManager');

        const servers = all
            .map(row => row.value)
            .filter(s => s.statusPagePublic)
            .map(s => {
                const proc = serverManager?.getProcess(s.id);
                return sanitizeForPublic(s, proc);
            })
            .sort((a, b) => {
                const stateOrder = { running: 0, starting: 1, backing_up: 2, restoring: 3, stopping: 4, crashed: 5, stopped: 6 };
                return (stateOrder[a.state] ?? 5) - (stateOrder[b.state] ?? 5)
                    || a.name.localeCompare(b.name);
            });

        res.render('status/list', {
            title: 'Server Status',
            description: 'View live status updates for hosted Minecraft servers.',
            navbar: false,
            user: null,
            servers
        });
    } catch (err) {
        log('error', `Status page error: ${err.message}`);
        res.status(500).render('errors/500', {
            title: 'Error', navbar: false, user: null, message: null
        });
    }
});

// GET /status/:id — Individual server status page (accessible to anyone with the link)
router.get('/status/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: false, user: null, message: 'Server not found.'
        });
    }

    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) {
            return res.status(404).render('errors/404', {
                title: '404', navbar: false, user: null, message: 'Server not found.'
            });
        }

        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        const sanitized = sanitizeForPublic(server, proc);

        // Get recent events (state changes only — NEVER crash reasons)
        const events = await getEvents(server.id, {
            limit: 20,
            types: PUBLIC_EVENT_TYPES
        });
        const safeEvents = events.map(e => ({
            type: e.type,
            message: e.type === 'crashed' ? 'Server crashed' : e.message,
            createdAt: e.createdAt
        }));

        // Check if mods folder exists
        const serverDir = path.resolve(server.directory);
        const modsDir = path.join(serverDir, 'mods');
        const hasMods = fs.existsSync(modsDir) && fs.statSync(modsDir).isDirectory();
        let modsCount = 0;
        if (hasMods) {
            try {
                modsCount = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length;
            } catch { /* ignore */ }
        }

        res.render('status/server', {
            title: sanitized.name + ' — Status',
            description: `View live status updates for ${sanitized.name}.`,
            navbar: false,
            user: null,
            server: sanitized,
            events: safeEvents,
            hasMods,
            modsCount
        });
    } catch (err) {
        log('error', `Status page error for ${req.params.id}: ${err.message}`);
        res.status(500).render('errors/500', {
            title: 'Error', navbar: false, user: null, message: null
        });
    }
});

// GET /status/:id/mods — Download mods folder as ZIP
router.get('/status/:id/mods', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        return res.status(404).json({ error: 'Not found.' });
    }

    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        const serverDir = path.resolve(server.directory);
        const modsDir = path.join(serverDir, 'mods');

        if (!fs.existsSync(modsDir) || !fs.statSync(modsDir).isDirectory()) {
            return res.status(404).json({ error: 'No mods folder found.' });
        }

        const safeName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', contentDisposition(`${safeName}_mods.zip`));

        const archive = archiver('zip', { zlib: { level: 5 } });
        archive.on('error', (err) => {
            log('error', `Mods archive error: ${err.message}`);
            if (!res.headersSent) res.status(500).json({ error: 'Archive failed.' });
        });
        archive.pipe(res);
        archive.directory(modsDir, 'mods');
        archive.finalize();
    } catch (err) {
        log('error', `Mods download error: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
    }
});

// GET /status/:id/api — JSON status for external tools/embedding
router.get('/status/:id/api', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        return res.status(404).json({ error: 'Not found.' });
    }

    try {
        const server = await serversDb.get(`server_${req.params.id}`);
        if (!server) return res.status(404).json({ error: 'Server not found.' });

        const serverManager = req.app.get('serverManager');
        const proc = serverManager?.getProcess(server.id);
        const sanitized = sanitizeForPublic(server, proc);

        res.json({ server: sanitized });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch status.' });
    }
});

module.exports = router;
