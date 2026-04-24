const express = require('express');
const router = express.Router();
const { serversDb } = require('../../db');
const { deleteServerEvents } = require('../../utils/eventLogger');

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

// POST /servers/:id/events/clear — Clear all events for a server
router.post('/servers/:id/events/clear', async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    await deleteServerEvents(server.id);

    const wss = req.app.get('wss');
    if (wss) {
        const msg = JSON.stringify({ type: 'events_cleared', serverId: server.id });
        for (const client of wss.clients) {
            if (client.readyState === 1 && client.subscribedServers && client.subscribedServers.has(server.id)) {
                client.send(msg);
            }
        }
    }

    res.json({ success: true });
});

module.exports = router;
