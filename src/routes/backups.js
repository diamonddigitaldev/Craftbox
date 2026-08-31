const express = require('express');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const blockWhileProvisioning = require('../middleware/blockWhileProvisioning');
const { serversDb } = require('../db');
const { listBackups, formatSize } = require('../mc/BackupManager');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getServerWithState(req) {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return null;
    const server = await serversDb.get(`server_${id}`);
    if (!server) return null;
    const serverManager = req.app.get('serverManager');
    if (serverManager) {
        const proc = serverManager.getProcess(id);
        if (proc) server.state = proc.state;
    }
    return server;
}

// GET /servers/:id/backups — Backups page (view only; mutations live on /api/v1)
router.get('/servers/:id/backups', ensureAuth, blockWhileProvisioning, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const backups = await listBackups(server.id);
    const backupsFormatted = backups.map(b => ({
        ...b,
        sizeFormatted: formatSize(b.size)
    }));

    const schedule = server.backupSchedule || {
        enabled: false,
        intervalHours: 24,
        countdownMinutes: 5,
        retentionCount: 5,
        retentionDays: 0
    };

    const backupScheduler = req.app.get('backupScheduler');
    const nextBackupAt = backupScheduler?.getNextBackupTime(server.id);

    res.render('servers/backups', {
        title: server.name + ' — Backups',
        description: `Manage backups for ${server.name}.`,
        navbar: true,
        user: req.user,
        server,
        backups: backupsFormatted,
        schedule,
        nextBackupAt: nextBackupAt ? nextBackupAt.toISOString() : null,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

module.exports = router;
