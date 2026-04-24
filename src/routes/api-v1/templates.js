const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { serversDb, templatesDb } = require('../../db');
const { log } = require('../../utils/log');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /templates — JSON list of all templates
router.get('/templates', async (req, res) => {
    const rows = await templatesDb.all();
    const templates = rows
        .map(r => r.value)
        .filter(t => t && typeof t === 'object')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ templates });
});

// GET /templates/:id — JSON single template
router.get('/templates/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
        return res.status(400).json({ error: 'Invalid template ID.' });
    }

    const template = await templatesDb.get(`template_${id}`);
    if (!template) {
        return res.status(404).json({ error: 'Template not found.' });
    }

    res.json({ template });
});

// POST /templates — Create a template from a server's config
router.post('/templates', async (req, res) => {
    const { serverId, name, stopFirst: stopFirstRaw, startAfter: startAfterRaw } = req.body || {};

    if (!serverId || !UUID_RE.test(serverId)) {
        return res.status(400).json({ error: 'Invalid server ID.' });
    }

    const server = await serversDb.get(`server_${serverId}`);
    if (!server) {
        return res.status(404).json({ error: 'Server not found.' });
    }

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(serverId);
    const stopFirst = stopFirstRaw === true || stopFirstRaw === 'true';
    const startAfter = startAfterRaw === true || startAfterRaw === 'true';

    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        if (!stopFirst) {
            return res.status(409).json({ error: 'Stop the server before saving a template.' });
        }
        try {
            if (proc.state === 'running' || proc.state === 'starting') {
                await serverManager.stopServer(serverId);
                await proc.waitForState('stopped', 60000);
            }
        } catch (err) {
            log('error', `Failed to stop server before saving template: ${err.message}`);
            return res.status(500).json({ error: `Failed to stop server: ${err.message}` });
        }
    }

    const trimmedName = String(name || '').trim();
    if (trimmedName.length < 1 || trimmedName.length > 50 || !/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        return res.status(400).json({ error: 'Template name must be 1-50 characters (letters, numbers, spaces, hyphens, underscores).' });
    }

    try {
        const id = uuidv4();
        const template = {
            id,
            name: trimmedName,
            serverType: server.serverType || 'vanilla',
            version: server.version || '',
            customJarUrl: server.customJarUrl || null,
            build: server.build || null,
            memory: server.memory || 2048,
            javaArgs: server.javaArgs || '',
            gamemode: server.gamemode || 'survival',
            difficulty: server.difficulty || 'easy',
            port: server.port || 25565,
            autoRestart: !!server.autoRestart,
            autoStart: !!server.autoStart,
            createdAt: new Date().toISOString()
        };

        await templatesDb.set(`template_${id}`, template);
        log('info', `Template "${trimmedName}" (${id}) saved from server "${server.name}".`);

        let warning = null;
        if (startAfter && stopFirst) {
            try {
                await serverManager.startServer(serverId);
            } catch (err) {
                log('error', `Failed to restart server after saving template: ${err.message}`);
                warning = `Template saved, but server failed to restart: ${err.message}`;
            }
        }

        res.status(201).json({ success: true, template, warning });
    } catch (err) {
        log('error', `Failed to save template: ${err.message}`);
        res.status(500).json({ error: `Failed to save template: ${err.message}` });
    }
});

// DELETE /templates/:id — Delete a template
router.delete('/templates/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
        return res.status(400).json({ error: 'Invalid template ID.' });
    }

    const template = await templatesDb.get(`template_${id}`);
    if (!template) {
        return res.status(404).json({ error: 'Template not found.' });
    }

    try {
        await templatesDb.delete(`template_${id}`);
        log('info', `Template "${template.name}" (${id}) deleted.`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to delete template ${id}: ${err.message}`);
        res.status(500).json({ error: 'Failed to delete template.' });
    }
});

module.exports = router;
