const express = require('express');
const fs = require('fs');
const contentDisposition = require('content-disposition');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, backupsDb } = require('../db');
const { log } = require('../utils/log');
const {
    listBackups,
    formatSize,
    resolveBackupPath
} = require('../mc/BackupManager');

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
router.get('/servers/:id/backups', ensureAuth, async (req, res) => {
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

// GET /servers/:id/backups/:backupId/download — Download a backup ZIP (binary)
router.get('/servers/:id/backups/:backupId/download', ensureAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.backupId)) {
        return res.status(400).json({ error: 'Invalid backup ID.' });
    }
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const backup = await backupsDb.get(`backup_${req.params.backupId}`);
    if (!backup || backup.serverId !== server.id) {
        req.session.flash = { error: 'Backup not found.' };
        return res.redirect(`/servers/${server.id}/backups`);
    }

    const zipPath = resolveBackupPath(server.id, backup.filename);
    if (!fs.existsSync(zipPath)) {
        req.session.flash = { error: 'Backup file not found on disk.' };
        return res.redirect(`/servers/${server.id}/backups`);
    }

    const safeName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeFilename = backup.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const downloadName = `${safeName}_backup_${safeFilename}`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(downloadName));
    res.setHeader('Content-Length', backup.size);

    const stream = fs.createReadStream(zipPath);
    stream.on('error', (err) => {
        log('error', `Backup download error: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Download failed.' });
        }
    });
    stream.pipe(res);
});

module.exports = router;
