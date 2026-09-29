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
const apiKeysDb = db.table('api_keys');
const groupsDb = db.table('groups');

async function markAllServersStopped({ reason } = {}) {
    const safeReason = reason ? String(reason) : null;

    // States that imply incomplete on-disk artifacts when interrupted — these
    // map to `crashed` with an explanatory reason so the user can delete/retry
    // rather than silently continuing as if all is well.
    const INCOMPLETE_STATES = {
        provisioning: 'Provisioning interrupted by restart',
        upgrading_jar: 'Jar upgrade interrupted by restart'
    };

    try {
        const rows = await serversDb.all();
        let updated = 0;

        for (const row of rows) {
            const server = row?.value;
            if (!server || typeof server !== 'object') continue;
            // Only states a restart makes untrue are reset. A crash stays one,
            // with its reason and exit code: resetting it to `stopped` lost the
            // banner, and left a failed duplicate or import looking whole.
            if (server.state === 'stopped' || server.state === 'crashed') continue;

            const incompleteReason = INCOMPLETE_STATES[server.state];
            if (incompleteReason) {
                server.state = 'crashed';
                server.crashReason = incompleteReason;
            } else {
                server.state = 'stopped';
            }
            const key = server.id ? `server_${server.id}` : row.id;
            await serversDb.set(key, server);
            updated++;
        }

        if (updated > 0) {
            log('info', `Reset ${updated} server state(s)${safeReason ? ` (${safeReason})` : ''}.`);
        }

        return { updated, total: rows.length };
    } catch (err) {
        log('warn', `Failed to reset server states${safeReason ? ` (${safeReason})` : ''}: ${err.message}`);
        return { updated: 0, total: 0, error: err };
    }
}

// A server whose provisioning failed is flagged (provisionFailed) and
// auto-removed by the API layer after a short grace period. If the panel
// restarts inside that window the in-memory timer is lost, so sweep them here
// at boot too — they are useless half-built state with no recoverable data.
async function purgeFailedProvisions() {
    try {
        const rows = await serversDb.all();
        const failed = rows
            .map(row => row?.value)
            .filter(s => s && typeof s === 'object' && s.provisionFailed && s.id);
        if (failed.length === 0) return { purged: 0 };

        // Lazily required to avoid a load-order cycle (serverCleanup → db).
        const { cleanupServerData } = require('./utils/serverCleanup');
        for (const s of failed) {
            try {
                await serversDb.delete(`server_${s.id}`);
                await cleanupServerData(s.id, s.group);
            } catch (err) {
                log('warn', `Failed to purge incomplete server ${s.id}: ${err.message}`);
            }
        }
        log('info', `Purged ${failed.length} failed-provision server(s) at startup.`);
        return { purged: failed.length };
    } catch (err) {
        log('warn', `Failed to sweep incomplete provisions: ${err.message}`);
        return { purged: 0, error: err };
    }
}

// Before 1.2.1, NeoForge's year-based builds (Minecraft 26.x) were listed as
// Minecraft "1.26.x". Give servers and templates saved with such a label the
// version they actually run, so the version picker, jar upgrades and the Java
// lookup all see a real one.
async function relabelNeoForgeVersions() {
    try {
        // Lazily required, like serverCleanup above.
        const { relabelLegacyVersion } = require('./mc/serverTypes/neoforge');
        let updated = 0;
        for (const [table, prefix] of [[serversDb, 'server_'], [templatesDb, 'template_']]) {
            for (const row of await table.all()) {
                const record = row?.value;
                if (!record || record.serverType !== 'neoforge' || !record.id) continue;
                const version = relabelLegacyVersion(record.version, record.build);
                if (version === record.version) continue;
                log('info', `NeoForge ${prefix.slice(0, -1)} "${record.name}": version ${record.version} → ${version}.`);
                record.version = version;
                await table.set(`${prefix}${record.id}`, record);
                updated++;
            }
        }
        return { updated };
    } catch (err) {
        log('warn', `Failed to relabel NeoForge versions: ${err.message}`);
        return { updated: 0, error: err };
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
    await apiKeysDb.init();
    await groupsDb.init();

    // Any persisted "running/starting/stopping" state becomes invalid across app restarts.
    // Ensure the DB doesn't keep servers locked in RUNNING forever after a crash.
    await markAllServersStopped({ reason: 'startup' });

    // Remove servers whose provisioning was interrupted before it completed.
    await purgeFailedProvisions();

    await relabelNeoForgeVersions();

    // Clear stale resource stats from any previous session
    await statsDb.deleteAll();
}

module.exports = { db, usersDb, serversDb, configDb, backupsDb, eventsDb, templatesDb, sessionsDb, statsDb, modMetadataDb, apiKeysDb, groupsDb, initDb, markAllServersStopped, purgeFailedProvisions, DATA_DIR, SERVERS_DIR, BACKUPS_DIR };
