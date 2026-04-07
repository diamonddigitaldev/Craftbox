const ServerProcess = require('./ServerProcess');
const { serversDb } = require('../db');
const { canPerformAction } = require('./stateMachine');
const { syncServerConfig } = require('./syncServerConfig');
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
     * If the cached process is stopped/crashed, rebuild it from current DB
     * state so that restored or edited config values (memory, javaArgs,
     * version, serverType, etc.) take effect on the next start.
     */
    async _ensureProcess(serverId) {
        let proc = this.processes.get(serverId);

        if (proc && ['stopped', 'crashed'].includes(proc.state)) {
            // Refresh config from DB + server.properties
            const config = await syncServerConfig(serverId);
            if (!config) throw new Error('Server not found.');

            const oldProc = proc;
            proc = new ServerProcess(config);

            // Migrate WebSocket subscribers so dashboard clients stay connected
            for (const ws of oldProc.subscribers) {
                proc.subscribers.add(ws);
            }
            oldProc.subscribers.clear();
            oldProc.removeAllListeners();

            this.processes.set(serverId, proc);
            return proc;
        }

        if (proc) return proc;

        // Sync DB from server.properties before creating the process
        const config = await syncServerConfig(serverId);
        if (!config) throw new Error('Server not found.');

        proc = new ServerProcess(config);
        this.processes.set(serverId, proc);
        return proc;
    }

    /**
     * Start a Minecraft server.
     * @param {string} serverId
     * @param {{ initiatedBy?: string }} [opts]
     */
    async startServer(serverId, opts = {}) {
        const proc = await this._ensureProcess(serverId);

        if (!canPerformAction(proc.state, 'start')) {
            throw new Error(`Cannot start server in state: ${proc.state}`);
        }

        if (opts.initiatedBy) proc._initiatedBy = opts.initiatedBy;
        await proc.start();
    }

    /**
     * Stop a Minecraft server gracefully.
     * @param {string} serverId
     * @param {{ initiatedBy?: string }} [opts]
     */
    async stopServer(serverId, opts = {}) {
        const proc = this.getProcess(serverId);
        if (!proc) throw new Error('Server is not running.');

        if (!canPerformAction(proc.state, 'stop')) {
            throw new Error(`Cannot stop server in state: ${proc.state}`);
        }

        if (opts.initiatedBy) proc._initiatedBy = opts.initiatedBy;
        await proc.stop();
    }

    /**
     * Restart a Minecraft server.
     * @param {string} serverId
     * @param {{ initiatedBy?: string }} [opts]
     */
    async restartServer(serverId, opts = {}) {
        const proc = this.getProcess(serverId);
        if (!proc) throw new Error('Server is not running.');

        if (!canPerformAction(proc.state, 'restart')) {
            throw new Error(`Cannot restart server in state: ${proc.state}`);
        }

        if (opts.initiatedBy) proc._initiatedBy = opts.initiatedBy;
        await proc.restart();
    }

    /**
     * Force kill a Minecraft server.
     * @param {string} serverId
     * @param {{ initiatedBy?: string }} [opts]
     */
    async killServer(serverId, opts = {}) {
        const proc = this.getProcess(serverId);
        if (!proc) throw new Error('Server is not running.');

        if (!canPerformAction(proc.state, 'kill')) {
            throw new Error(`Cannot kill server in state: ${proc.state}`);
        }

        if (opts.initiatedBy) proc._initiatedBy = opts.initiatedBy;
        await proc.kill();
    }

    /**
     * Set an operational state (backing_up, restoring) that exists outside the
     * normal process lifecycle. Persists to DB and broadcasts via WebSocket.
     * @param {string} serverId
     * @param {'backing_up'|'restoring'|'stopped'} newState
     */
    async setOperationalState(serverId, newState) {
        const { STATES } = require('./stateMachine');
        const allowed = [STATES.BACKING_UP, STATES.RESTORING, STATES.STOPPED];
        if (!allowed.includes(newState)) {
            throw new Error(`Invalid operational state: ${newState}`);
        }

        const server = await serversDb.get(`server_${serverId}`);
        if (!server) throw new Error('Server not found.');

        server.state = newState;
        await serversDb.set(`server_${serverId}`, server);

        const proc = this.getProcess(serverId);
        if (proc) {
            proc.state = newState;
            proc.broadcast({
                type: 'state',
                serverId,
                state: newState,
                exitCode: null,
                crashReason: null
            });
        }
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
                const onStateChange = (state) => {
                    if (['stopped', 'crashed'].includes(state)) {
                        clearTimeout(timeout);
                        proc.removeListener('stateChange', onStateChange);
                        resolve();
                    }
                };

                const timeout = setTimeout(() => {
                    log('warn', `[${proc.config.name}] Shutdown timeout, force killing.`);
                    proc.removeListener('stateChange', onStateChange);
                    proc._killTree();
                    resolve();
                }, 30000);

                proc.on('stateChange', onStateChange);

                proc.stop().catch((err) => {
                    log('warn', `[${proc.config.name}] stop() failed: ${err.message}`);
                    clearTimeout(timeout);
                    proc.removeListener('stateChange', onStateChange);
                    resolve();
                });
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
                    await this.startServer(server.id, { initiatedBy: 'Auto Start' });
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
