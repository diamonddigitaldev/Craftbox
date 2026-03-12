const ServerProcess = require('./ServerProcess');
const { serversDb } = require('../db');
const { canPerformAction } = require('./stateMachine');
const { log } = require('../utils/log');

class ServerManager {
    constructor() {
        this.processes = new Map(); // serverId -> ServerProcess
    }

    /**
     * Get or create a ServerProcess for a given server ID.
     */
    getProcess(serverId) {
        return this.processes.get(serverId) || null;
    }

    /**
     * Ensure a ServerProcess instance exists for a server (lazy init).
     */
    async _ensureProcess(serverId) {
        let proc = this.processes.get(serverId);
        if (proc) return proc;

        const config = await serversDb.get(`server_${serverId}`);
        if (!config) throw new Error('Server not found.');

        proc = new ServerProcess(config);
        this.processes.set(serverId, proc);
        return proc;
    }

    /**
     * Start a Minecraft server.
     */
    async startServer(serverId) {
        const proc = await this._ensureProcess(serverId);

        if (!canPerformAction(proc.state, 'start')) {
            throw new Error(`Cannot start server in state: ${proc.state}`);
        }

        await proc.start();
    }

    /**
     * Stop a Minecraft server gracefully.
     */
    async stopServer(serverId) {
        const proc = this.getProcess(serverId);
        if (!proc) throw new Error('Server is not running.');

        if (!canPerformAction(proc.state, 'stop')) {
            throw new Error(`Cannot stop server in state: ${proc.state}`);
        }

        await proc.stop();
    }

    /**
     * Restart a Minecraft server.
     */
    async restartServer(serverId) {
        const proc = this.getProcess(serverId);
        if (!proc) throw new Error('Server is not running.');

        if (!canPerformAction(proc.state, 'restart')) {
            throw new Error(`Cannot restart server in state: ${proc.state}`);
        }

        await proc.restart();
    }

    /**
     * Force kill a Minecraft server.
     */
    async killServer(serverId) {
        const proc = this.getProcess(serverId);
        if (!proc) throw new Error('Server is not running.');

        if (!canPerformAction(proc.state, 'kill')) {
            throw new Error(`Cannot kill server in state: ${proc.state}`);
        }

        await proc.kill();
    }

    /**
     * Remove a ServerProcess from the registry (for server deletion).
     */
    removeProcess(serverId) {
        const proc = this.processes.get(serverId);
        if (proc) {
            proc.destroy();
            this.processes.delete(serverId);
        }
    }

    /**
     * Stop all running servers gracefully (for container shutdown).
     * Returns a promise that resolves when all servers are stopped.
     */
    async stopAll() {
        const running = [];
        for (const [id, proc] of this.processes) {
            if (['running', 'starting'].includes(proc.state)) {
                running.push({ id, proc });
            }
        }

        if (running.length === 0) {
            log('info', 'No running servers to stop.');
            return;
        }

        log('info', `Stopping ${running.length} running server(s)...`);

        const stopPromises = running.map(({ id, proc }) => {
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    log('warn', `[${proc.config.name}] Shutdown timeout, force killing.`);
                    proc._killTree();
                    resolve();
                }, 30000);

                proc.once('stateChange', (state) => {
                    if (['stopped', 'crashed'].includes(state)) {
                        clearTimeout(timeout);
                        resolve();
                    }
                });

                try {
                    proc.stop();
                } catch (err) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        await Promise.all(stopPromises);
        log('info', 'All servers stopped.');
    }

    /**
     * Auto-start servers that have the autoStart flag.
     */
    async autoStartServers() {
        try {
            const all = await serversDb.all();
            const autoStartServers = all.filter(row => row.value?.autoStart);

            for (const row of autoStartServers) {
                const server = row.value;
                log('info', `Auto-starting server "${server.name}" (${server.id})...`);
                try {
                    await this.startServer(server.id);
                } catch (err) {
                    log('error', `Failed to auto-start "${server.name}": ${err.message}`);
                }
            }
        } catch (err) {
            log('error', `Failed to check auto-start servers: ${err.message}`);
        }
    }
}

module.exports = ServerManager;
