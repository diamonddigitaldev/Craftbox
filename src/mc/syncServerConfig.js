const path = require('path');
const { serversDb, SERVERS_DIR } = require('../db');
const { parseServerProperties } = require('./serverProperties');
const { log } = require('../utils/log');

/**
 * Sync mirrored fields from server.properties back into the database.
 * Call this on server startup and after backup restore to ensure the DB
 * reflects the actual server.properties on disk.
 *
 * @param {string} serverId
 * @returns {Promise<object|null>} Updated server object, or null if not found
 */
async function syncServerConfig(serverId) {
    const server = await serversDb.get(`server_${serverId}`);
    if (!server) return null;

    const serverDir = path.join(SERVERS_DIR, serverId);
    const props = parseServerProperties(serverDir);
    if (!props || Object.keys(props).length === 0) return server;

    let changed = false;

    if (props['server-port']) {
        const port = parseInt(props['server-port'], 10);
        if (!isNaN(port) && port !== server.port) {
            log('info', `[${server.name}] Config sync: port ${server.port} → ${port}`);
            server.port = port;
            changed = true;
        }
    }

    if (props['gamemode'] && props['gamemode'] !== server.gamemode) {
        log('info', `[${server.name}] Config sync: gamemode ${server.gamemode} → ${props['gamemode']}`);
        server.gamemode = props['gamemode'];
        changed = true;
    }

    if (props['difficulty'] && props['difficulty'] !== server.difficulty) {
        log('info', `[${server.name}] Config sync: difficulty ${server.difficulty} → ${props['difficulty']}`);
        server.difficulty = props['difficulty'];
        changed = true;
    }

    if (props['level-seed'] !== undefined && props['level-seed'] !== server.seed) {
        log('info', `[${server.name}] Config sync: seed updated`);
        server.seed = props['level-seed'];
        changed = true;
    }

    if (changed) {
        await serversDb.set(`server_${serverId}`, server);
        log('info', `[${server.name}] Config synced from server.properties`);
    }

    return server;
}

module.exports = { syncServerConfig };
