const { serversDb } = require('../db');
const { getProcessMemory, getProcessCpu, getUptime, formatUptime, formatSize } = require('./resourceStats');
const { saveStats } = require('./statsHistory');
const { log } = require('./log');

const POLL_INTERVAL = 10 * 1000; // 10 seconds

/**
 * Background stats collector that polls resource usage for all running servers.
 * Runs on a 10-second interval, persists data points to statsHistory (5-minute window).
 */
class StatsCollector {
    constructor(serverManager) {
        this.serverManager = serverManager;
        this._timer = null;
        // In-memory cache of latest stats per server for instant API reads
        this.latestStats = new Map();
    }

    /**
     * Start the background polling loop.
     */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this._poll(), POLL_INTERVAL);
        this._timer.unref();
        log('info', 'StatsCollector started (polling every 10s).');
    }

    /**
     * Stop the background polling loop.
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this.latestStats.clear();
        log('info', 'StatsCollector stopped.');
    }

    /**
     * Get the latest cached stats for a server (no I/O).
     */
    getLatestStats(serverId) {
        return this.latestStats.get(serverId) || null;
    }

    /**
     * Poll all running servers and record stats.
     */
    async _poll() {
        try {
            const all = await serversDb.all();

            for (const row of all) {
                const server = row.value;
                if (!server?.id) continue;

                const proc = this.serverManager.getProcess(server.id);
                if (!proc || proc.state !== 'running') {
                    // Clear cached stats for non-running servers
                    if (this.latestStats.has(server.id)) {
                        this.latestStats.delete(server.id);
                    }
                    continue;
                }

                try {
                    await this._collectServerStats(server, proc);
                } catch (err) {
                    // Don't let one server failure stop the others
                }
            }
        } catch (err) {
            // Silently ignore poll-level errors
        }
    }

    /**
     * Collect and persist stats for a single running server.
     */
    async _collectServerStats(server, proc) {
        const stats = {
            state: proc.state,
            uptime: getUptime(server.lastStarted),
            uptimeFormatted: formatUptime(getUptime(server.lastStarted)),
            cpuPercent: null,
            memoryBytes: null,
            memoryFormatted: null,
            memoryAllocatedMb: server.memory || 2048,
            diskBytes: null,
            diskFormatted: null,
            playerCount: proc.players.size,
            players: Array.from(proc.players)
        };

        if (proc.child?.pid) {
            stats.memoryBytes = getProcessMemory(proc.child.pid);
            if (stats.memoryBytes) {
                stats.memoryFormatted = formatSize(stats.memoryBytes);
            }
            stats.cpuPercent = getProcessCpu(proc.child.pid);
            if (stats.cpuPercent !== null) {
                stats.cpuPercent = Math.round(stats.cpuPercent * 10) / 10;
            }
        }

        // Cache the latest stats in memory
        this.latestStats.set(server.id, stats);

        // Persist to stats history
        const memAllocBytes = (server.memory || 2048) * 1024 * 1024;
        await saveStats(server.id, {
            timestamp: Date.now(),
            cpuPercent: stats.cpuPercent,
            memoryPercent: stats.memoryBytes && memAllocBytes > 0
                ? Math.round((stats.memoryBytes / memAllocBytes) * 1000) / 10
                : 0,
            memoryBytes: stats.memoryBytes || 0
        });
    }
}

module.exports = StatsCollector;
