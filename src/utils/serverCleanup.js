const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const { SERVERS_DIR } = require('../db');
const { deleteServerEvents } = require('./eventLogger');
const { clearStatsHistory } = require('./statsHistory');
const { clearAllModEnv } = require('./modEnvironment');
const { pruneGroupMetaIfEmpty } = require('./serverGroups');

// Full data cleanup for a server whose DB record is being removed: backups,
// events, stats, mod metadata, group prune, and the server directory. The
// record itself is deleted by the caller. Each step is isolated so one failure
// (e.g. a locked file on Windows) can't skip the rest.
//
// Shared by the DELETE route, the failed-provision auto-purge timer, and the
// boot-time sweep of servers whose provisioning was interrupted — so all three
// remove exactly the same data.
async function cleanupServerData(id, group) {
    const step = async (label, fn) => {
        try {
            await fn();
        } catch (err) {
            log('error', `Cleanup step "${label}" failed for ${id}: ${err.message}`);
        }
    };
    // Lazily required — BackupManager pulls in the scheduler graph, and this
    // module is loaded during DB init before that graph is ready.
    const { deleteAllBackups } = require('../mc/BackupManager');
    await step('backups', () => deleteAllBackups(id));
    await step('events', () => deleteServerEvents(id));
    await step('stats', () => clearStatsHistory(id));
    await step('mod metadata', () => clearAllModEnv(id));
    if (group) await step('group', () => pruneGroupMetaIfEmpty(group));
    await step('files', () => fs.promises.rm(path.join(SERVERS_DIR, id), { recursive: true, force: true }));
}

module.exports = { cleanupServerData };
