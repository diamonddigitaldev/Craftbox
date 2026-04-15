const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, templatesDb } = require('../db');
const { log } = require('../utils/log');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── GET /templates — Templates list page ──

router.get('/templates', ensureAuth, async (req, res) => {
    const rows = await templatesDb.all();
    const templates = rows
        .map(r => r.value)
        .filter(t => t && typeof t === 'object')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.render('templates', {
        title: 'Templates',
        description: 'View and manage server templates.',
        navbar: true,
        user: req.user,
        templates,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// ── POST /templates/create — Save a template from a server's config ──

router.post('/templates/create', ensureAuth, async (req, res) => {
    const { serverId, name } = req.body;

    if (!serverId || !UUID_RE.test(serverId)) {
        req.session.flash = { error: 'Invalid server ID.' };
        return res.redirect('/templates');
    }

    const server = await serversDb.get(`server_${serverId}`);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/templates');
    }

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(serverId);
    const stopFirst = req.body.stopFirst === 'true' || req.body.stopFirst === true;
    const startAfter = req.body.startAfter === 'true' || req.body.startAfter === true;

    // Server must be stopped (or user chose to stop it)
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        if (!stopFirst) {
            req.session.flash = { error: 'Stop the server before saving a template.' };
            return res.redirect(`/servers/${serverId}/edit`);
        }
        try {
            if (proc.state === 'running' || proc.state === 'starting') {
                await serverManager.stopServer(serverId);
                await proc.waitForState('stopped', 60000);
            }
        } catch (err) {
            log('error', `Failed to stop server before saving template: ${err.message}`);
            req.session.flash = { error: `Failed to stop server: ${err.message}` };
            return res.redirect(`/servers/${serverId}/edit`);
        }
    }

    // Validate template name
    const trimmedName = String(name || '').trim();
    if (trimmedName.length < 1 || trimmedName.length > 50 || !/^[a-zA-Z0-9 _\-]+$/.test(trimmedName)) {
        req.session.flash = { error: 'Template name must be 1-50 characters (letters, numbers, spaces, hyphens, underscores).' };
        return res.redirect(`/servers/${serverId}/edit`);
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

        // Restart server if requested
        if (startAfter && stopFirst) {
            try {
                await serverManager.startServer(serverId);
            } catch (err) {
                log('error', `Failed to restart server after saving template: ${err.message}`);
                req.session.flash = { warning: `Template "${trimmedName}" saved, but server failed to restart: ${err.message}` };
                return res.redirect('/templates');
            }
        }

        req.session.flash = { success: `Template "${trimmedName}" saved.` };
        res.redirect('/templates');
    } catch (err) {
        log('error', `Failed to save template: ${err.message}`);
        req.session.flash = { error: `Failed to save template: ${err.message}` };
        res.redirect(`/servers/${serverId}/edit`);
    }
});

// ── DELETE /api/templates/:id — Delete a template ──

router.delete('/api/templates/:id', ensureAuth, async (req, res) => {
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

// ── GET /api/templates — JSON list of all templates ──

router.get('/api/templates', ensureAuth, async (req, res) => {
    const rows = await templatesDb.all();
    const templates = rows
        .map(r => r.value)
        .filter(t => t && typeof t === 'object')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ templates });
});

// ── GET /api/templates/:id — JSON single template ──

router.get('/api/templates/:id', ensureAuth, async (req, res) => {
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

module.exports = router;
