const { serversDb } = require('../db');

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

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
}

module.exports = { getServerWithState, formatSize };
