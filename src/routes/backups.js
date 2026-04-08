const express = require('express');
const fs = require('fs');
const contentDisposition = require('content-disposition');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, backupsDb } = require('../db');
const { log } = require('../utils/log');
const { logEvent } = require('../utils/eventLogger');
const {
    createBackup,
    restoreBackup,
    deleteBackup,
    listBackups,
    applyRetention,
    formatSize,
    resolveBackupPath
} = require('../mc/BackupManager');
const { STATES } = require('../mc/stateMachine');
const { syncServerConfig } = require('../mc/syncServerConfig');

/**
 * Format a Date as YYYY-MM-DD HH:MM:SS (24-hour, local time).
 */
function formatTimestamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── GET /servers/:id/backups — Backups page ──

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
        sizeFormatted: formatSize(b.size),
        createdFormatted: formatTimestamp(new Date(b.createdAt))
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
        nextBackupAt: nextBackupAt ? formatTimestamp(nextBackupAt) : null,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// ── POST /servers/:id/backups/create — Create a manual backup ──

router.post('/servers/:id/backups/create', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    const stopFirst = req.body.stopFirst === 'true' || req.body.stopFirst === true;
    const startAfter = req.body.startAfter === 'true' || req.body.startAfter === true;
    let backupName = (req.body.name && req.body.name.trim()) || 'Manual Backup';
    if (backupName.length > 50 || !/^[A-Za-z0-9 _\-]+$/.test(backupName)) {
        backupName = 'Manual Backup';
    }

    try {
        // If server is running and user requested stop-first
        if (proc && ![STATES.STOPPED, STATES.CRASHED].includes(proc.state)) {
            if (!stopFirst) {
                req.session.flash = { error: 'Server must be stopped to create a backup.' };
                return res.redirect(`/servers/${server.id}/backups`);
            }

            // Stop the server and wait
            if (proc.state === STATES.RUNNING || proc.state === STATES.STARTING) {
                await serverManager.stopServer(server.id, { initiatedBy: req.user.username });
                await proc.waitForState(STATES.STOPPED, 60000);
            }
        }

        await serverManager.setOperationalState(server.id, STATES.BACKING_UP);
        try {
            const backup = await createBackup(server.id, backupName, 'manual');

            // Apply retention policy after backup
            const schedule = server.backupSchedule || {};
            await applyRetention(server.id, schedule.retentionCount || 0, schedule.retentionDays || 0);

            logEvent(server.id, 'backup_create', `Manual backup created (${formatSize(backup.size)})`, { initiatedBy: req.user.username }).catch(() => {});
            req.session.flash = { success: `Backup created: ${formatSize(backup.size)}` };
        } finally {
            await serverManager.setOperationalState(server.id, STATES.STOPPED);
        }

        // Start server after backup if requested
        if (startAfter) {
            try {
                await serverManager.startServer(server.id, { initiatedBy: req.user.username });
            } catch (err) {
                log('error', `Failed to start server after backup: ${err.message}`);
                req.session.flash = { warning: 'Backup created, but server failed to start: ' + err.message };
            }
        }
    } catch (err) {
        log('error', `Backup creation failed for ${server.name}: ${err.message}`);
        logEvent(server.id, 'backup_create_fail', `Manual backup failed: ${err.message}`, { initiatedBy: req.user.username }).catch(() => {});
        req.session.flash = { error: `Backup failed: ${err.message}` };
    }

    return res.redirect(`/servers/${server.id}/backups`);
});

// ── POST /servers/:id/backups/:backupId/restore — Restore a backup ──

router.post('/servers/:id/backups/:backupId/restore', ensureAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.backupId)) {
        return res.status(400).redirect('/dashboard');
    }
    const server = await getServerWithState(req);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    const startAfter = req.body.startAfter === 'true' || req.body.startAfter === true;

    try {
        // Stop server if running
        if (proc && ![STATES.STOPPED, STATES.CRASHED].includes(proc.state)) {
            if (proc.state === STATES.RUNNING || proc.state === STATES.STARTING) {
                await serverManager.stopServer(server.id, { initiatedBy: req.user.username });
                await proc.waitForState(STATES.STOPPED, 60000);
            }
        }

        await serverManager.setOperationalState(server.id, STATES.RESTORING);
        try {
            const backup = await backupsDb.get(`backup_${req.params.backupId}`);
            await restoreBackup(server.id, req.params.backupId);

            // Sync DB fields from the restored server.properties
            await syncServerConfig(server.id);

            const restoreDetail = backup?.createdAt
                ? `Restored from backup (${formatTimestamp(new Date(backup.createdAt))})`
                : 'Restored from backup';
            logEvent(server.id, 'backup_restore', restoreDetail, { initiatedBy: req.user.username }).catch(() => {});
            req.session.flash = { success: 'Backup restored successfully.' };
        } finally {
            await serverManager.setOperationalState(server.id, STATES.STOPPED);
        }

        // Start server after restore if requested
        if (startAfter) {
            try {
                await serverManager.startServer(server.id, { initiatedBy: req.user.username });
            } catch (err) {
                log('error', `Failed to start server after restore: ${err.message}`);
                req.session.flash = { warning: 'Backup restored, but server failed to start: ' + err.message };
            }
        }
    } catch (err) {
        log('error', `Restore failed for ${server.name}: ${err.message}`);
        logEvent(server.id, 'backup_restore_fail', `Backup restore failed: ${err.message}`, { initiatedBy: req.user.username }).catch(() => {});
        req.session.flash = { error: `Restore failed: ${err.message}` };
    }

    return res.redirect(`/servers/${server.id}/backups`);
});

// ── GET /servers/:id/backups/:backupId/download — Download a backup ZIP ──

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

// ── POST /servers/:id/backups/:backupId/delete — Delete a backup ──

router.post('/servers/:id/backups/:backupId/delete', ensureAuth, async (req, res) => {
    if (!UUID_RE.test(req.params.backupId)) {
        return res.status(400).redirect('/dashboard');
    }
    const server = await getServerWithState(req);
    if (!server) {
        req.session.flash = { error: 'Server not found.' };
        return res.redirect('/dashboard');
    }

    try {
        await deleteBackup(server.id, req.params.backupId);
        logEvent(server.id, 'backup_delete', 'Backup deleted', { initiatedBy: req.user.username }).catch(() => {});
        req.session.flash = { success: 'Backup deleted.' };
    } catch (err) {
        log('error', `Backup delete failed: ${err.message}`);
        req.session.flash = { error: `Delete failed: ${err.message}` };
    }

    return res.redirect(`/servers/${server.id}/backups`);
});

module.exports = router;
