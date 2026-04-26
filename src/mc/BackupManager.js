const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { backupsDb, serversDb, BACKUPS_DIR, SERVERS_DIR } = require('../db');
const { log } = require('../utils/log');

// Prevent concurrent backups for the same server
const activeLocks = new Map();

/**
 * Whether a backup is currently in progress for this server.
 */
function isBackupInProgress(serverId) {
    return activeLocks.has(serverId);
}

/**
 * Ensure the backup directory for a server exists.
 */
function ensureBackupDir(serverId) {
    const dir = path.join(BACKUPS_DIR, serverId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Resolve and validate a backup zip path stays within the expected directory.
 */
function resolveBackupPath(serverId, filename) {
    const expectedBase = path.resolve(BACKUPS_DIR, serverId);
    const zipPath = path.resolve(BACKUPS_DIR, serverId, filename);
    if (!zipPath.startsWith(expectedBase + path.sep) && zipPath !== expectedBase) {
        throw new Error('Invalid backup filename.');
    }
    return zipPath;
}

/**
 * Generate a safe filename from an ISO timestamp.
 * Replaces colons with hyphens for Windows compatibility.
 */
function safeTimestamp() {
    return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

/**
 * Create a backup of the full server directory.
 * @param {string} serverId
 * @param {string} name - Human-readable label
 * @param {'manual'|'scheduled'} type
 * @returns {Promise<object>} The backup record
 */
async function createBackup(serverId, name, type = 'manual') {
    // Prevent concurrent backups for the same server
    if (isBackupInProgress(serverId)) {
        throw new Error('A backup is already in progress for this server.');
    }

    const promise = _doCreateBackup(serverId, name, type);
    activeLocks.set(serverId, promise);
    try {
        return await promise;
    } finally {
        activeLocks.delete(serverId);
    }
}

async function _doCreateBackup(serverId, name, type) {
    const server = await serversDb.get(`server_${serverId}`);
    if (!server) throw new Error('Server not found.');

    const serverDir = path.join(SERVERS_DIR, serverId);
    if (!fs.existsSync(serverDir)) throw new Error('Server directory not found.');

    const backupDir = ensureBackupDir(serverId);
    const timestamp = safeTimestamp();
    const filename = `${timestamp}_${type}.zip`;
    const zipPath = path.join(backupDir, filename);

    log('info', `[${server.name}] Creating ${type} backup: ${filename}`);

    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 5 } });

        output.on('close', resolve);
        archive.on('error', (err) => {
            // Clean up partial file on error
            try { fs.unlinkSync(zipPath); } catch {}
            reject(err);
        });

        archive.pipe(output);
        archive.directory(serverDir, false);

        // Embed server DB config so restores are exact
        archive.append(JSON.stringify(server, null, 2), { name: 'craftbox-config.json' });

        archive.finalize();
    });

    const stat = fs.statSync(zipPath);
    const id = uuidv4();

    const backup = {
        id,
        serverId,
        name: name || (type === 'manual' ? 'Manual Backup' : 'Scheduled Backup'),
        filename,
        size: stat.size,
        createdAt: new Date().toISOString(),
        type
    };

    await backupsDb.set(`backup_${id}`, backup);

    log('info', `[${server.name}] Backup created: ${filename} (${formatSize(stat.size)})`);
    return backup;
}

/**
 * Restore a backup over the server directory.
 * The server MUST be stopped before calling this.
 * @param {string} serverId
 * @param {string} backupId
 */
async function restoreBackup(serverId, backupId) {
    const backup = await backupsDb.get(`backup_${backupId}`);
    if (!backup || backup.serverId !== serverId) throw new Error('Backup not found.');

    const server = await serversDb.get(`server_${serverId}`);
    if (!server) throw new Error('Server not found.');

    const zipPath = resolveBackupPath(serverId, backup.filename);
    if (!fs.existsSync(zipPath)) throw new Error('Backup file not found on disk.');

    const serverDir = path.join(SERVERS_DIR, serverId);

    log('info', `[${server.name}] Restoring backup: ${backup.filename}`);

    // Clear server directory contents (preserve logs/ folder)
    const entries = fs.readdirSync(serverDir);
    for (const entry of entries) {
        if (entry === 'logs') continue;
        const entryPath = path.join(serverDir, entry);
        fs.rmSync(entryPath, { recursive: true, force: true });
    }

    // Extract backup with zip-slip protection
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    const resolvedServerDir = path.resolve(serverDir) + path.sep;
    for (const entry of zipEntries) {
        const target = path.resolve(serverDir, entry.entryName);
        if (!target.startsWith(resolvedServerDir)) {
            throw new Error(`Zip entry escapes target directory: ${entry.entryName}`);
        }
    }
    zip.extractAllTo(serverDir, true);

    // Restore server DB config from backup if present
    const configEntry = zip.getEntry('craftbox-config.json');
    if (configEntry) {
        try {
            const savedConfig = JSON.parse(configEntry.getData().toString('utf8'));
            // Fields that must NOT be overwritten (runtime/identity)
            const preserve = ['id', 'directory', 'jarFile', 'state', 'exitCode',
                'crashReason', 'crashDetected', 'lastStarted', 'createdAt'];
            for (const key of Object.keys(savedConfig)) {
                if (!preserve.includes(key)) {
                    server[key] = savedConfig[key];
                }
            }
            await serversDb.set(`server_${serverId}`, server);
            log('info', `[${server.name}] Server configuration restored from backup.`);
        } catch (err) {
            log('warn', `[${server.name}] Failed to restore config from backup: ${err.message}`);
        }
    }

    // Remove craftbox-config.json from the server directory (it's metadata, not a server file)
    const configOnDisk = path.join(serverDir, 'craftbox-config.json');
    try { if (fs.existsSync(configOnDisk)) fs.unlinkSync(configOnDisk); } catch {}

    log('info', `[${server.name}] Backup restored successfully.`);
}

/**
 * Delete a backup (file + DB record).
 * @param {string} serverId
 * @param {string} backupId
 */
async function deleteBackup(serverId, backupId) {
    const backup = await backupsDb.get(`backup_${backupId}`);
    if (!backup || backup.serverId !== serverId) throw new Error('Backup not found.');

    const zipPath = resolveBackupPath(serverId, backup.filename);
    if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
    }

    await backupsDb.delete(`backup_${backupId}`);
    log('info', `Deleted backup: ${backup.filename}`);
}

/**
 * List all backups for a server, sorted by createdAt descending.
 * @param {string} serverId
 * @returns {Promise<object[]>}
 */
async function listBackups(serverId) {
    const all = await backupsDb.all();
    return all
        .map(entry => entry.value)
        .filter(b => b.serverId === serverId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Apply retention policy — delete backups that exceed count or age limits.
 * @param {string} serverId
 * @param {number} retentionCount - Keep last N (0 = unlimited)
 * @param {number} retentionDays - Keep from last N days (0 = unlimited, takes priority if both set)
 */
async function applyRetention(serverId, retentionCount, retentionDays) {
    if (!retentionCount && !retentionDays) return;

    const backups = await listBackups(serverId); // Already sorted desc by date

    const toDeleteIds = new Set();
    const toDelete = [];

    // Age-based: delete backups older than N days
    if (retentionDays > 0) {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        for (const b of backups) {
            if (new Date(b.createdAt) < cutoff) {
                toDeleteIds.add(b.id);
            }
        }
    }

    // Count-based: keep only the newest N backups
    if (retentionCount > 0 && backups.length > retentionCount) {
        for (const b of backups.slice(retentionCount)) {
            toDeleteIds.add(b.id);
        }
    }

    for (const b of backups) {
        if (toDeleteIds.has(b.id)) toDelete.push(b);
    }

    for (const b of toDelete) {
        try {
            await deleteBackup(serverId, b.id);
        } catch (err) {
            log('error', `Failed to delete backup ${b.id} during retention: ${err.message}`);
        }
    }

    if (toDelete.length > 0) {
        log('info', `Retention policy: deleted ${toDelete.length} backup(s) for server ${serverId}`);
    }
}

/**
 * Delete all backups for a server (used when deleting a server).
 * @param {string} serverId
 */
async function deleteAllBackups(serverId) {
    const backups = await listBackups(serverId);
    for (const b of backups) {
        try {
            await backupsDb.delete(`backup_${b.id}`);
        } catch {}
    }

    // Remove the entire backup directory
    const dir = path.join(BACKUPS_DIR, serverId);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    log('info', `Deleted all backups for server ${serverId}`);
}

/**
 * Format bytes to human-readable string.
 */
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

module.exports = {
    createBackup,
    restoreBackup,
    deleteBackup,
    listBackups,
    applyRetention,
    deleteAllBackups,
    ensureBackupDir,
    resolveBackupPath,
    formatSize,
    isBackupInProgress
};
