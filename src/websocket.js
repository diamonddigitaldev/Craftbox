const WebSocket = require('ws');
const { log } = require('./utils/log');

/**
 * Initialize WebSocket server on the given HTTP server.
 * @param {http.Server} httpServer
 * @param {Function} sessionMiddleware - Express session middleware for auth
 * @param {ServerManager} serverManager
 */
function initWebSocket(httpServer, sessionMiddleware, serverManager) {
    const wss = new WebSocket.Server({ noServer: true });

    // Authenticate WebSocket connections via session cookie
    httpServer.on('upgrade', (request, socket, head) => {
        // Fake response object for session middleware
        const res = {
            setHeader: () => {},
            getHeader: () => {},
            writeHead: () => {},
            end: () => {}
        };

        sessionMiddleware(request, res, () => {
            const userId = request.session?.passport?.user;
            if (!userId) {
                log('warn', 'WebSocket connection rejected: not authenticated.');
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.userId = userId;
                wss.emit('connection', ws, request);
            });
        });
    });

    wss.on('connection', (ws, request) => {
        const userId = ws.userId;
        ws.isAlive = true;
        ws.subscribedServers = new Set();

        log('debug', `WebSocket connected (user: ${userId})`);

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON.' }));
                return;
            }

            handleMessage(ws, msg, serverManager);
        });

        ws.on('close', () => {
            // Unsubscribe from all servers on disconnect
            for (const serverId of ws.subscribedServers) {
                const proc = serverManager.getProcess(serverId);
                if (proc) proc.unsubscribe(ws);
            }
            ws.subscribedServers.clear();
        });
    });

    // Heartbeat to detect dead connections
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) {
                for (const serverId of (ws.subscribedServers || new Set())) {
                    const proc = serverManager.getProcess(serverId);
                    if (proc) proc.unsubscribe(ws);
                }
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('close', () => {
        clearInterval(heartbeat);
    });

    return wss;
}

function handleMessage(ws, msg, serverManager) {
    switch (msg.type) {
        case 'subscribe': {
            const serverId = msg.serverId;
            if (!serverId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Missing serverId.' }));
                return;
            }

            const proc = serverManager.getProcess(serverId);
            if (proc) {
                proc.subscribe(ws);
            } else {
                // Server exists but no process yet — send current state
                ws.send(JSON.stringify({
                    type: 'subscribed',
                    serverId,
                    state: 'stopped',
                    history: []
                }));
            }
            ws.subscribedServers.add(serverId);
            break;
        }

        case 'unsubscribe': {
            const serverId = msg.serverId;
            if (serverId) {
                const proc = serverManager.getProcess(serverId);
                if (proc) proc.unsubscribe(ws);
                ws.subscribedServers.delete(serverId);
            }
            break;
        }

        case 'command': {
            const serverId = msg.serverId;
            const line = msg.line;
            if (!serverId || typeof line !== 'string') {
                ws.send(JSON.stringify({ type: 'error', message: 'Missing serverId or line.' }));
                return;
            }

            const proc = serverManager.getProcess(serverId);
            if (!proc || proc.state !== 'running') {
                ws.send(JSON.stringify({ type: 'error', message: 'Server is not running.' }));
                return;
            }

            // Limit command length
            const trimmedLine = line.trim().slice(0, 1000);
            if (trimmedLine.length > 0) {
                proc.sendCommand(trimmedLine);
            }
            break;
        }

        case 'ping': {
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        }

        default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
}

module.exports = { initWebSocket };
