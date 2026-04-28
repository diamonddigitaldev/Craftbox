const express = require('express');
const router = express.Router();
const { serversDb, backupsDb } = require('../../db');
const { log } = require('../../utils/log');
const { logEvent } = require('../../utils/eventLogger');
const {
    runBackupJob,
    restoreBackup,
    deleteBackup,
    listBackups,
    applyRetention,
    formatSize,
    tryAcquireBackupLock,
    releaseBackupLock
} = require('../../mc/BackupManager');
const { STATES } = require('../../mc/stateMachine');
const { syncServerConfig } = require('../../mc/syncServerConfig');

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

// GET /servers/:id/backups — List backups
router.get('/servers/:id/backups', async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const backups = await listBackups(server.id);
    const backupsFormatted = backups.map(b => ({
        ...b,
        sizeFormatted: formatSize(b.size)
    }));

    res.json({ backups: backupsFormatted });
});

// POST /servers/:id/backups — Kick off a manual backup. Returns 202 immediately;
// completion (or failure) is reported via the per-server WebSocket as
// { type: 'operation', operation: 'backup', status: 'complete'|'failed', ... }.
router.post('/servers/:id/backups', async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    const stopFirst = req.body?.stopFirst === 'true' || req.body?.stopFirst === true;
    const startAfter = req.body?.startAfter === 'true' || req.body?.startAfter === true;
    const initiatedBy = req.user.username;
    let backupName = (req.body?.name && String(req.body.name).trim()) || 'Manual Backup';
    if (backupName.length > 50 || !/^[A-Za-z0-9 _\-]+$/.test(backupName)) {
        backupName = 'Manual Backup';
    }

    if (proc && ![STATES.STOPPED, STATES.CRASHED].includes(proc.state) && !stopFirst) {
        return res.status(409).json({ error: 'Server must be stopped to create a backup.' });
    }

    // Atomically claim the backup lock so a concurrent request cannot also start.
    if (!tryAcquireBackupLock(server.id)) {
        return res.status(409).json({ error: 'A backup is already in progress for this server.' });
    }

    let lockOwnedByRoute = true;
    try {
        if (proc && (proc.state === STATES.RUNNING || proc.state === STATES.STARTING)) {
            await serverManager.stopServer(server.id, { initiatedBy });
            await proc.waitForState(STATES.STOPPED, 60000);
        }

        await serverManager.setOperationalState(server.id, STATES.BACKING_UP);
        lockOwnedByRoute = false; // hand off to IIFE
        res.status(202).json({ success: true, status: 'started' });

        // Fire-and-forget: long backup work runs after the response is sent.
        (async () => {
            try {
                const backup = await runBackupJob(server.id, backupName, 'manual');

                const schedule = server.backupSchedule || {};
                await applyRetention(server.id, schedule.retentionCount || 0, schedule.retentionDays || 0);

                logEvent(server.id, 'backup_create', `Manual backup created (${formatSize(backup.size)})`, { initiatedBy }).catch(() => {});

                let warning = null;
                if (startAfter) {
                    try {
                        await serverManager.setOperationalState(server.id, STATES.STOPPED);
                        await serverManager.startServer(server.id, { initiatedBy });
                    } catch (err) {
                        log('error', `Failed to start server after backup: ${err.message}`);
                        warning = 'Backup created, but server failed to start: ' + err.message;
                    }
                } else {
                    await serverManager.setOperationalState(server.id, STATES.STOPPED);
                }

                serverManager.broadcastOperation(server.id, 'backup', 'complete', {
                    backup: { ...backup, sizeFormatted: formatSize(backup.size) },
                    warning
                });
            } catch (err) {
                log('error', `Backup creation failed for ${server.name}: ${err.message}`);
                logEvent(server.id, 'backup_create_fail', `Manual backup failed: ${err.message}`, { initiatedBy }).catch(() => {});
                try {
                    await serverManager.setOperationalState(server.id, STATES.STOPPED);
                } catch (_) {}
                serverManager.broadcastOperation(server.id, 'backup', 'failed', err.message);
            }
        })();
    } catch (err) {
        if (lockOwnedByRoute) releaseBackupLock(server.id);
        log('error', `Backup setup failed for ${server.name}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Backup failed: ${err.message}` });
        }
    }
});

// POST /servers/:id/backups/:backupId/restore — Kick off a backup restore. Returns
// 202 immediately; completion is reported via the per-server WebSocket as
// { type: 'operation', operation: 'restore', status: 'complete'|'failed', ... }.
router.post('/servers/:id/backups/:backupId/restore', async (req, res) => {
    if (!UUID_RE.test(req.params.backupId)) {
        return res.status(400).json({ error: 'Invalid backup ID.' });
    }
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    const startAfter = req.body?.startAfter === 'true' || req.body?.startAfter === true;
    const initiatedBy = req.user.username;
    const backupId = req.params.backupId;

    try {
        if (proc && (proc.state === STATES.RUNNING || proc.state === STATES.STARTING)) {
            await serverManager.stopServer(server.id, { initiatedBy });
            await proc.waitForState(STATES.STOPPED, 60000);
        }

        await serverManager.setOperationalState(server.id, STATES.RESTORING);
        res.status(202).json({ success: true, status: 'started' });

        (async () => {
            try {
                const backup = await backupsDb.get(`backup_${backupId}`);
                await restoreBackup(server.id, backupId);
                await syncServerConfig(server.id);

                const restoreDetail = backup?.createdAt
                    ? `Restored from backup (${backup.createdAt})`
                    : 'Restored from backup';
                logEvent(server.id, 'backup_restore', restoreDetail, { initiatedBy }).catch(() => {});

                let warning = null;
                if (startAfter) {
                    try {
                        await serverManager.setOperationalState(server.id, STATES.STOPPED);
                        await serverManager.startServer(server.id, { initiatedBy });
                    } catch (err) {
                        log('error', `Failed to start server after restore: ${err.message}`);
                        warning = 'Backup restored, but server failed to start: ' + err.message;
                    }
                } else {
                    await serverManager.setOperationalState(server.id, STATES.STOPPED);
                }

                serverManager.broadcastOperation(server.id, 'restore', 'complete', { warning });
            } catch (err) {
                log('error', `Restore failed for ${server.name}: ${err.message}`);
                logEvent(server.id, 'backup_restore_fail', `Backup restore failed: ${err.message}`, { initiatedBy }).catch(() => {});
                try {
                    await serverManager.setOperationalState(server.id, STATES.STOPPED);
                } catch (_) {}
                serverManager.broadcastOperation(server.id, 'restore', 'failed', err.message);
            }
        })();
    } catch (err) {
        log('error', `Restore setup failed for ${server.name}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: `Restore failed: ${err.message}` });
        }
    }
});

// DELETE /servers/:id/backups/:backupId — Delete a backup
router.delete('/servers/:id/backups/:backupId', async (req, res) => {
    if (!UUID_RE.test(req.params.backupId)) {
        return res.status(400).json({ error: 'Invalid backup ID.' });
    }
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    try {
        await deleteBackup(server.id, req.params.backupId);
        logEvent(server.id, 'backup_delete', 'Backup deleted', { initiatedBy: req.user.username }).catch(() => {});
        res.json({ success: true });
    } catch (err) {
        log('error', `Backup delete failed: ${err.message}`);
        res.status(500).json({ error: `Delete failed: ${err.message}` });
    }
});

module.exports = router;
