const express = require('express');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb } = require('../db');

// GET / — Redirect to dashboard
router.get('/', ensureAuth, (req, res) => {
    res.redirect('/dashboard');
});

// GET /dashboard — Server list
router.get('/dashboard', ensureAuth, async (req, res) => {
    let servers = [];
    try {
        const all = await serversDb.all();
        servers = all.map(row => row.value).sort((a, b) => {
            // Sort running servers first, then by name
            const stateOrder = { running: 0, starting: 1, backing_up: 2, restoring: 3, stopping: 4, crashed: 5, stopped: 6 };
            const aOrder = stateOrder[a.state] ?? 5;
            const bOrder = stateOrder[b.state] ?? 5;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.name.localeCompare(b.name);
        });

        // Enrich with live state from ServerManager if available
        const serverManager = req.app.get('serverManager');
        if (serverManager) {
            servers = servers.map(s => {
                const proc = serverManager.getProcess(s.id);
                if (proc) {
                    s.state = proc.state;
                }
                return s;
            });
        }
    } catch (err) {
        // Continue with empty servers array
    }

    // Partition into named groups (alphabetical) and ungrouped servers,
    // preserving the state-priority sort within each section.
    const groupMap = new Map();
    const ungrouped = [];
    for (const server of servers) {
        const group = typeof server.group === 'string' && server.group.trim() ? server.group.trim() : null;
        if (!group) {
            ungrouped.push(server);
        } else {
            if (!groupMap.has(group)) groupMap.set(group, []);
            groupMap.get(group).push(server);
        }
    }
    const serverGroups = [...groupMap.entries()]
        .map(([name, groupServers]) => ({ name, servers: groupServers }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const groupNames = serverGroups.map(g => g.name);

    res.render('dashboard', {
        title: 'Dashboard',
        navbar: true,
        user: req.user,
        servers,
        serverGroups,
        ungrouped,
        groupNames,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

module.exports = router;
