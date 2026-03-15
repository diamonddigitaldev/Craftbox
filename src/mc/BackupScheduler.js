const { serversDb } = require('../db');
const { log } = require('../utils/log');
const { createBackup, applyRetention } = require('./BackupManager');
const { STATES } = require('./stateMachine');

/**
 * Check if a Minecraft version supports tellraw (added in 1.7.2).
 * Falls back to false for unparseable or missing versions.
 */
function supportsTellraw(version) {
    if (!version || typeof version !== 'string') return false;
    const parts = version.split('.').map(Number);
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;
    if (minor > 7) return true;
    if (minor === 7 && patch >= 2) return true;
    return false;
}

/**
 * Build a chat command for the backup countdown/notification.
 * Uses tellraw with formatting on 1.7.2+, plain say on older versions.
 */
function chatCommand(version, prefix, message, color) {
    if (supportsTellraw(version)) {
        return `tellraw @a [{"text":"${prefix}","color":"gold","bold":true},{"text":"${message}","color":"${color}","bold":false}]`;
    }
    return `say ${prefix}${message}`;
}

class BackupScheduler {
    constructor(serverManager) {
        this.serverManager = serverManager;
        // serverId -> { intervalTimer, countdownTimers[], nextBackupAt }
        this.timers = new Map();
    }

    /**
     * Initialize schedules for all servers that have backupSchedule.enabled.
     * Called once at boot after serverManager.autoStartServers().
     */
    async init() {
        try {
            const all = await serversDb.all();
            for (const row of all) {
                const server = row.value;
                if (server?.backupSchedule?.enabled) {
                    this.startSchedule(server.id);
                }
            }
        } catch (err) {
            log('error', `BackupScheduler init failed: ${err.message}`);
        }
    }

    /**
     * Start the backup schedule for a server.
     */
    async startSchedule(serverId) {
        this.stopSchedule(serverId);

        const server = await serversDb.get(`server_${serverId}`);
        if (!server?.backupSchedule?.enabled) return;

        const intervalMs = (server.backupSchedule.intervalHours || 24) * 60 * 60 * 1000;
        const nextBackupAt = new Date(Date.now() + intervalMs);

        const intervalTimer = setInterval(() => {
            this._triggerScheduledBackup(serverId);
        }, intervalMs);
        intervalTimer.unref();

        this.timers.set(serverId, {
            intervalTimer,
            countdownTimers: [],
            nextBackupAt
        });

        log('info', `Backup schedule started for server ${serverId}: every ${server.backupSchedule.intervalHours}h, next at ${nextBackupAt.toISOString()}`);
    }

    /**
     * Stop the backup schedule for a server.
     */
    stopSchedule(serverId) {
        const entry = this.timers.get(serverId);
        if (!entry) return;

        clearInterval(entry.intervalTimer);
        for (const t of entry.countdownTimers) {
            clearTimeout(t);
        }
        this.timers.delete(serverId);
    }

    /**
     * Restart the schedule (e.g. after settings change).
     */
    async restartSchedule(serverId) {
        this.stopSchedule(serverId);
        await this.startSchedule(serverId);
    }

    /**
     * Get the next scheduled backup time for a server.
     */
    getNextBackupTime(serverId) {
        const entry = this.timers.get(serverId);
        return entry?.nextBackupAt || null;
    }

    /**
     * Trigger a scheduled backup with optional countdown warnings.
     */
    async _triggerScheduledBackup(serverId) {
        try {
            const server = await serversDb.get(`server_${serverId}`);
            if (!server) return;

            const proc = this.serverManager.getProcess(serverId);
            const schedule = server.backupSchedule || {};
            const countdownMinutes = schedule.countdownMinutes || 5;

            // Update next backup time
            const entry = this.timers.get(serverId);
            if (entry) {
                const intervalMs = (schedule.intervalHours || 24) * 60 * 60 * 1000;
                entry.nextBackupAt = new Date(Date.now() + intervalMs);
            }

            // If server is not running, just backup directly
            if (!proc || [STATES.STOPPED, STATES.CRASHED].includes(proc.state)) {
                log('info', `[${server.name}] Scheduled backup: server already stopped, creating backup...`);
                await createBackup(serverId, 'Scheduled Backup', 'scheduled');
                await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);
                return;
            }

            // Server is running — start countdown
            log('info', `[${server.name}] Scheduled backup: starting ${countdownMinutes}m countdown...`);

            // Clear any existing countdown timers
            if (entry) {
                for (const t of entry.countdownTimers) clearTimeout(t);
                entry.countdownTimers = [];
            }

            // Schedule countdown messages
            for (let m = countdownMinutes; m >= 1; m--) {
                const delayMs = (countdownMinutes - m) * 60 * 1000;
                const label = m === 1 ? '1 minute' : `${m} minutes`;
                const timer = setTimeout(() => {
                    const p = this.serverManager.getProcess(serverId);
                    if (p && p.state === STATES.RUNNING) {
                        p.sendCommand(chatCommand(server.version, '[Craftbox] ', `Server backup in ${label}...`, 'yellow'));
                    }
                }, delayMs);
                timer.unref();
                if (entry) entry.countdownTimers.push(timer);
            }

            // After countdown completes: stop, backup, conditionally restart
            const stopDelayMs = countdownMinutes * 60 * 1000;
            const stopTimer = setTimeout(async () => {
                try {
                    const p = this.serverManager.getProcess(serverId);
                    if (!p) {
                        // Process gone, just backup
                        await createBackup(serverId, 'Scheduled Backup', 'scheduled');
                        await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);
                        return;
                    }

                    // Capture current state before stopping to decide whether to restart
                    const stateBeforeStop = p.state;

                    if (p.state === STATES.RUNNING || p.state === STATES.STARTING) {
                        p.sendCommand(chatCommand(server.version, '[Craftbox] ', 'Server stopping for backup...', 'red'));

                        await this.serverManager.stopServer(serverId);
                        await p.waitForState(STATES.STOPPED, 60000);
                    }

                    log('info', `[${server.name}] Scheduled backup: creating backup...`);
                    await createBackup(serverId, 'Scheduled Backup', 'scheduled');
                    await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);

                    // Only restart if the server was running before the backup
                    if (stateBeforeStop === STATES.RUNNING) {
                        log('info', `[${server.name}] Scheduled backup: restarting server...`);
                        await this.serverManager.startServer(serverId);
                    } else {
                        log('info', `[${server.name}] Scheduled backup: server was not running (state: ${stateBeforeStop}), leaving stopped.`);
                    }
                } catch (err) {
                    log('error', `[${server.name}] Scheduled backup failed: ${err.message}`);
                }
            }, stopDelayMs);
            stopTimer.unref();
            if (entry) entry.countdownTimers.push(stopTimer);

        } catch (err) {
            log('error', `Scheduled backup trigger failed for ${serverId}: ${err.message}`);
        }
    }

    /**
     * Stop all timers (called during graceful shutdown).
     */
    stopAll() {
        for (const [serverId] of this.timers) {
            this.stopSchedule(serverId);
        }
        log('info', 'All backup schedules stopped.');
    }
}

module.exports = BackupScheduler;
