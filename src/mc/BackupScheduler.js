const { serversDb } = require('../db');
const { log } = require('../utils/log');
const { createBackup, applyRetention, listBackups } = require('./BackupManager');
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
     * Called once at boot BEFORE serverManager.autoStartServers().
     * Also checks for missed backups while Craftbox was offline.
     */
    async init() {
        try {
            const all = await serversDb.all();
            for (const row of all) {
                const server = row.value;
                if (server?.backupSchedule?.enabled) {
                    this.startSchedule(server.id);
                    await this._catchUpIfMissed(server);
                }
            }
        } catch (err) {
            log('error', `BackupScheduler init failed: ${err.message}`);
        }
    }

    /**
     * If a scheduled backup was missed while Craftbox was offline, run one now.
     * A backup is "missed" when the last scheduled backup is older than the interval.
     */
    async _catchUpIfMissed(server) {
        try {
            const schedule = server.backupSchedule;
            const intervalMs = (schedule.intervalHours || 24) * 60 * 60 * 1000;

            const backups = await listBackups(server.id);
            const lastScheduled = backups.find(b => b.type === 'scheduled');

            if (!lastScheduled) {
                // No scheduled backup has ever been made — don't force one on first boot
                return;
            }

            const timeSinceLast = Date.now() - new Date(lastScheduled.createdAt).getTime();
            if (timeSinceLast > intervalMs) {
                log('info', `[${server.name}] Missed scheduled backup detected (last: ${lastScheduled.createdAt}). Creating catch-up backup...`);

                // Stop server if running before creating backup
                const proc = this.serverManager.getProcess(server.id);
                const wasRunning = proc && proc.state === STATES.RUNNING;
                if (wasRunning) {
                    log('info', `[${server.name}] Stopping server for catch-up backup...`);
                    await this.serverManager.stopServer(server.id, { initiatedBy: 'Backup Scheduler' });
                    await proc.waitForState(STATES.STOPPED, 60000);
                }

                await createBackup(server.id, 'Scheduled Backup (Catch-up)', 'scheduled');
                await applyRetention(server.id, schedule.retentionCount || 0, schedule.retentionDays || 0);
                log('info', `[${server.name}] Catch-up backup completed.`);

                // Restart if it was running before
                if (wasRunning) {
                    log('info', `[${server.name}] Restarting server after catch-up backup...`);
                    await this.serverManager.startServer(server.id, { initiatedBy: 'Backup Scheduler' });
                }
            }
        } catch (err) {
            log('error', `[${server.name}] Catch-up backup failed: ${err.message}`);
        }
    }

    /**
     * Start the backup schedule for a server.
     *
     * The countdown phase runs BEFORE the scheduled time so the actual backup
     * lands exactly on the interval boundary. For a 1h interval with a 5m
     * countdown: countdown starts at T+55m, backup executes at T+60m.
     */
    async startSchedule(serverId) {
        this.stopSchedule(serverId);

        const server = await serversDb.get(`server_${serverId}`);
        if (!server?.backupSchedule?.enabled) return;

        const intervalMs = (server.backupSchedule.intervalHours || 24) * 60 * 60 * 1000;
        const nextBackupAt = new Date(Date.now() + intervalMs);

        const intervalTimer = setInterval(() => {
            this._startCountdownOrBackup(serverId);
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
     * Called by setInterval at the START of each cycle.
     *
     * If the server is running, the countdown begins immediately and the actual
     * backup fires countdownMinutes later — i.e. the countdown is a pre-phase
     * that finishes exactly when the next interval tick would land.
     *
     * Timeline for 1 h interval, 5 min countdown:
     *   T+0m   — setInterval fires → countdown starts, chat: "backup in 5 min"
     *   T+1m–4m — chat warnings
     *   T+5m   — server stops, backup created, server restarts
     *   T+60m  — next setInterval fires → countdown starts again
     *
     * Because the countdown (5 min) is much shorter than the interval (≥1 h),
     * the overlap is negligible and backups stay on cadence.
     */
    async _startCountdownOrBackup(serverId) {
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

            // If server is not running, just backup directly (no stop/restart needed)
            if (!proc || [STATES.STOPPED, STATES.CRASHED].includes(proc.state)) {
                log('info', `[${server.name}] Scheduled backup: server already stopped, creating backup...`);
                await createBackup(serverId, 'Scheduled Backup', 'scheduled');
                await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);
                return;
            }

            // Server is running — start countdown before backup
            log('info', `[${server.name}] Scheduled backup: starting ${countdownMinutes}m countdown...`);

            // Clear any existing countdown timers
            if (entry) {
                for (const t of entry.countdownTimers) clearTimeout(t);
                entry.countdownTimers = [];
            }

            // Track whether the backup has already been triggered (e.g. by early server stop)
            let backupDone = false;

            // Listen for the server stopping during countdown so we can backup immediately
            const onStateChange = async (newState) => {
                if (backupDone) return;
                if (![STATES.STOPPED, STATES.CRASHED].includes(newState)) return;

                backupDone = true;
                proc.removeListener('stateChange', onStateChange);

                // Cancel remaining countdown timers
                if (entry) {
                    for (const t of entry.countdownTimers) clearTimeout(t);
                    entry.countdownTimers = [];
                }

                log('info', `[${server.name}] Server stopped during backup countdown, creating backup now...`);
                try {
                    await createBackup(serverId, 'Scheduled Backup', 'scheduled');
                    await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);
                } catch (err) {
                    log('error', `[${server.name}] Scheduled backup failed after early stop: ${err.message}`);
                }
            };
            proc.on('stateChange', onStateChange);

            // Schedule countdown messages (5, 4, 3, 2, 1 minutes before backup)
            for (let m = countdownMinutes; m >= 1; m--) {
                const delayMs = (countdownMinutes - m) * 60 * 1000;
                const label = m === 1 ? '1 minute' : `${m} minutes`;
                const timer = setTimeout(() => {
                    if (backupDone) return;
                    const p = this.serverManager.getProcess(serverId);
                    if (p && p.state === STATES.RUNNING) {
                        p.sendCommand(chatCommand(server.version, '[Craftbox] ', `Server backup in ${label}...`, 'yellow'));
                    }
                }, delayMs);
                timer.unref();
                if (entry) entry.countdownTimers.push(timer);
            }

            // After countdown completes: stop, backup, conditionally restart
            const countdownMs = countdownMinutes * 60 * 1000;
            const stopTimer = setTimeout(async () => {
                // If server stopped during countdown, backup already happened
                if (backupDone) return;
                backupDone = true;
                proc.removeListener('stateChange', onStateChange);

                try {
                    await this._executeBackup(serverId, server, schedule);
                } catch (err) {
                    log('error', `[${server.name}] Scheduled backup failed: ${err.message}`);
                }
            }, countdownMs);
            stopTimer.unref();
            if (entry) entry.countdownTimers.push(stopTimer);

        } catch (err) {
            log('error', `Scheduled backup trigger failed for ${serverId}: ${err.message}`);
        }
    }

    /**
     * Execute the actual backup: stop the server if running, create backup,
     * apply retention, and restart if the server was running before.
     */
    async _executeBackup(serverId, server, schedule) {
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
            // Wait a few seconds for the message to go through before stopping
            await new Promise(res => setTimeout(res, 3000));
            await this.serverManager.stopServer(serverId, { initiatedBy: 'Backup Scheduler' });
            await p.waitForState(STATES.STOPPED, 60000);
        }

        log('info', `[${server.name}] Scheduled backup: creating backup...`);
        await createBackup(serverId, 'Scheduled Backup', 'scheduled');
        await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);

        // Only restart if the server was running before the backup
        if (stateBeforeStop === STATES.RUNNING) {
            log('info', `[${server.name}] Scheduled backup: restarting server...`);
            await this.serverManager.startServer(serverId, { initiatedBy: 'Backup Scheduler' });
        } else {
            log('info', `[${server.name}] Scheduled backup: server was not running (state: ${stateBeforeStop}), leaving stopped.`);
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
