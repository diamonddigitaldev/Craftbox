const express = require('express');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb } = require('../db');
const { normalizeGroupName, getGroupsWithMeta, getGroupColor } = require('../utils/serverGroups');

// Sort running servers first, then by name
function sortByStateThenName(servers) {
    const stateOrder = { running: 0, starting: 1, backing_up: 2, restoring: 3, stopping: 4, crashed: 5, stopped: 6 };
    return servers.sort((a, b) => {
        const aOrder = stateOrder[a.state] ?? 5;
        const bOrder = stateOrder[b.state] ?? 5;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.name.localeCompare(b.name);
    });
}

// Enrich with live state from ServerManager if available
function enrichLiveState(req, servers) {
    const serverManager = req.app.get('serverManager');
    if (!serverManager) return servers;
    return servers.map(s => {
        const proc = serverManager.getProcess(s.id);
        if (proc) {
            s.state = proc.state;
        }
        return s;
    });
}

// GET / — Redirect to dashboard
router.get('/', ensureAuth, (req, res) => {
    res.redirect('/dashboard');
});

// GET /dashboard — Group tiles + ungrouped server list
router.get('/dashboard', ensureAuth, async (req, res) => {
    let servers = [];
    let serverGroups = [];
    let ungrouped = [];
    try {
        const all = await serversDb.all();
        servers = sortByStateThenName(all.map(row => row.value));
        servers = enrichLiveState(req, servers);

        ungrouped = servers.filter(s => !(typeof s.group === 'string' && s.group.trim()));
        serverGroups = await getGroupsWithMeta();
    } catch (err) {
        // Continue with empty servers array
    }

    res.render('dashboard', {
        title: 'Dashboard',
        navbar: true,
        user: req.user,
        servers,
        serverGroups,
        ungrouped,
        groupNames: serverGroups.map(g => g.name),
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// GET /dashboard/groups/:name — Servers belonging to one group
router.get('/dashboard/groups/:name', ensureAuth, async (req, res) => {
    const { valid, value: groupName } = normalizeGroupName(req.params.name);
    if (!valid || !groupName) {
        return res.redirect('/dashboard');
    }

    let servers = [];
    try {
        const all = await serversDb.all();
        servers = sortByStateThenName(all.map(row => row.value).filter(s => s.group === groupName));
        servers = enrichLiveState(req, servers);
    } catch (err) {
        // Continue with empty servers array
    }

    // Implicit groups: an empty group does not exist.
    if (servers.length === 0) {
        req.session.flash = { error: `Group "${groupName}" no longer exists.` };
        return res.redirect('/dashboard');
    }

    const groups = await getGroupsWithMeta().catch(() => []);

    res.render('groups/view', {
        title: groupName,
        navbar: true,
        fluid: true,
        user: req.user,
        groupName,
        groupColor: await getGroupColor(groupName).catch(() => '#4caf50'),
        servers,
        groupNames: groups.map(g => g.name),
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

module.exports = router;
