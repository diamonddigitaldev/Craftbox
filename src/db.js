const path = require('path');
const fs = require('fs');
const { QuickDB } = require('quick.db');
const { log } = require('./utils/log');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Ensure data directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SERVERS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const db = new QuickDB({ filePath: path.join(DATA_DIR, 'craftbox.sqlite') });
const usersDb = db.table('users');
const serversDb = db.table('servers');
const configDb = db.table('config');
const backupsDb = db.table('backups');
const eventsDb = db.table('events');
const templatesDb = db.table('templates');
const sessionsDb = db.table('sessions');
const statsDb = db.table('stats');
const modMetadataDb = db.table('mod_metadata');

async function markAllServersStopped({ reason } = {}) {
    const safeReason = reason ? String(reason) : null;

    try {
        const rows = await serversDb.all();
        let updated = 0;

        for (const row of rows) {
            const server = row?.value;
            if (!server || typeof server !== 'object') continue;
            if (server.state === 'stopped') continue;

            server.state = 'stopped';
            const key = server.id ? `server_${server.id}` : row.id;
            await serversDb.set(key, server);
            updated++;
        }

        if (updated > 0) {
            log('info', `Reset ${updated} server state(s) to stopped${safeReason ? ` (${safeReason})` : ''}.`);
        }

        return { updated, total: rows.length };
    } catch (err) {
        log('warn', `Failed to reset server states${safeReason ? ` (${safeReason})` : ''}: ${err.message}`);
        return { updated: 0, total: 0, error: err };
    }
}

async function initDb() {
    await db.init();
    await usersDb.init();
    await serversDb.init();
    await configDb.init();
    await backupsDb.init();
    await eventsDb.init();
    await templatesDb.init();
    await sessionsDb.init();
    await statsDb.init();
    await modMetadataDb.init();

    // Any persisted "running/starting/stopping" state becomes invalid across app restarts.
    // Ensure the DB doesn't keep servers locked in RUNNING forever after a crash.
    await markAllServersStopped({ reason: 'startup' });

    // Clear stale resource stats from any previous session
    await statsDb.deleteAll();
}

module.exports = { db, usersDb, serversDb, configDb, backupsDb, eventsDb, templatesDb, sessionsDb, statsDb, modMetadataDb, initDb, markAllServersStopped, DATA_DIR, SERVERS_DIR, BACKUPS_DIR };
