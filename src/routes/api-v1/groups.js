const express = require('express');
const router = express.Router();
const {
    normalizeGroupName,
    getGroupsWithMeta,
    setGroupColor,
    getGroupColor,
    renameGroup,
    GROUP_NAME_ERROR,
    GROUP_COLOR_REGEX
} = require('../../utils/serverGroups');
const { log } = require('../../utils/log');

// Notify all open dashboard/group pages of a grouping change so they refresh.
function notifyDashboard(req) {
    req.app.get('serverManager')?.broadcastGlobal?.({
        type: 'dashboard-changed',
        origin: req.get('x-client-id') || null
    });
}

// GET /groups — All server groups with color and server count
router.get('/groups', async (req, res) => {
    try {
        const groups = await getGroupsWithMeta();
        res.json({ groups });
    } catch (err) {
        log('error', `Failed to fetch groups: ${err.message}`);
        res.status(500).json({ error: 'Failed to fetch groups.' });
    }
});

// POST /groups/:name — Update a group's color
router.post('/groups/:name', async (req, res) => {
    try {
        const { valid, value: name } = normalizeGroupName(req.params.name);
        if (!valid || !name) {
            return res.status(400).json({ error: GROUP_NAME_ERROR });
        }

        const groups = await getGroupsWithMeta();
        if (!groups.some(g => g.name === name)) {
            return res.status(404).json({ error: 'Group not found.' });
        }

        const color = String(req.body.color || '').trim();
        if (!GROUP_COLOR_REGEX.test(color)) {
            return res.status(400).json({ error: 'Color must be a hex value like #4caf50.' });
        }

        await setGroupColor(name, color);
        log('info', `Group "${name}" color set to ${color}`);
        notifyDashboard(req);
        res.json({ name, color });
    } catch (err) {
        log('error', `Failed to update group "${req.params.name}": ${err.message}`);
        res.status(500).json({ error: 'Failed to update group.' });
    }
});

// POST /groups/:name/rename — Rename a group (moves every member server + its color)
router.post('/groups/:name/rename', async (req, res) => {
    try {
        const { valid: oldValid, value: oldName } = normalizeGroupName(req.params.name);
        if (!oldValid || !oldName) {
            return res.status(400).json({ error: GROUP_NAME_ERROR });
        }

        const { valid: newValid, value: newName } = normalizeGroupName(req.body.name);
        if (!newValid || !newName) {
            return res.status(400).json({ error: GROUP_NAME_ERROR });
        }

        const groups = await getGroupsWithMeta();
        if (!groups.some(g => g.name === oldName)) {
            return res.status(404).json({ error: 'Group not found.' });
        }
        if (newName !== oldName && groups.some(g => g.name === newName)) {
            return res.status(409).json({ error: `A group named "${newName}" already exists.` });
        }

        const affectedIds = await renameGroup(oldName, newName);

        const serverManager = req.app.get('serverManager');
        if (serverManager) {
            for (const id of affectedIds) {
                const proc = serverManager.getProcess(id);
                if (proc) proc.config.group = newName;
            }
        }

        const color = await getGroupColor(newName);
        log('info', `Group "${oldName}" renamed to "${newName}" (${affectedIds.length} server${affectedIds.length === 1 ? '' : 's'} moved)`);
        notifyDashboard(req);
        res.json({ name: newName, color });
    } catch (err) {
        log('error', `Failed to rename group "${req.params.name}": ${err.message}`);
        res.status(500).json({ error: 'Failed to rename group.' });
    }
});

module.exports = router;
