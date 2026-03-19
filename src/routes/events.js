const express = require('express');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb } = require('../db');
const { getEvents, deleteServerEvents } = require('../utils/eventLogger');

/**
 * Load server with live state from ServerManager.
 */
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

// ── GET /servers/:id/events — Event Log page ──

router.get('/servers/:id/events', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const typeFilter = req.query.type || null;
    const events = await getEvents(server.id, { limit: 500, types: typeFilter ? [typeFilter] : null });

    res.render('servers/events', {
        title: server.name + ' — Events',
        navbar: true,
        user: req.user,
        server,
        events,
        typeFilter,
        csrfToken: res.locals.csrfToken
    });
});

// ── POST /servers/:id/events/clear — Clear all events ──

router.post('/servers/:id/events/clear', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    await deleteServerEvents(server.id);
    res.redirect(`/servers/${server.id}/events`);
});

module.exports = router;
