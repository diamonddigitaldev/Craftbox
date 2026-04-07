const { serversDb } = require('../db');
const { log } = require('../utils/log');
const { logEvent } = require('../utils/eventLogger');
const { createBackup, applyRetention, listBackups, formatSize } = require('./BackupManager');
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
        // serverId -> { backupTimer, countdownTimers[], nextBackupAt }
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

                await this.serverManager.setOperationalState(server.id, STATES.BACKING_UP);
                try {
                    const backup = await createBackup(server.id, 'Scheduled Backup (Catch-up)', 'scheduled');
                    await applyRetention(server.id, schedule.retentionCount || 0, schedule.retentionDays || 0);
                    logEvent(server.id, 'backup_create', `Scheduled backup created (${formatSize(backup.size)})`, { initiatedBy: 'Backup Scheduler' }).catch(() => {});
                    log('info', `[${server.name}] Catch-up backup completed.`);
                } catch (err) {
                    log('error', `[${server.name}] Catch-up backup failed: ${err.message}`);
                    logEvent(server.id, 'backup_create', `Scheduled backup failed: ${err.message}`, { initiatedBy: 'Backup Scheduler' }).catch(() => {});
                } finally {
                    await this.serverManager.setOperationalState(server.id, STATES.STOPPED);
                }

                // Restart if it was running before
                if (wasRunning) {
                    log('info', `[${server.name}] Restarting server after catch-up backup...`);
                    await this.serverManager.startServer(server.id, { initiatedBy: 'Backup Scheduler' });
                }
            }
        } catch (err) {
            log('error', `[${server.name}] Catch-up backup check failed: ${err.message}`);
        }
    }

    /**
     * Start the backup schedule for a server.
     *
     * Uses setTimeout chains so backups always fire exactly on the interval
     * boundary. The countdown is a pre-phase that ends when the backup starts.
     *
     * Timeline for 1h interval, 5m countdown:
     *   T+55m — countdown starts: "backup in 5 min", "4 min", ...
     *   T+60m — backup executes (stop, zip, restart)
     *   T+115m — next countdown starts
     *   T+120m — next backup executes
     */
    async startSchedule(serverId) {
        this.stopSchedule(serverId);

        const server = await serversDb.get(`server_${serverId}`);
        if (!server?.backupSchedule?.enabled) return;

        const schedule = server.backupSchedule;
        const intervalMs = (schedule.intervalHours || 24) * 60 * 60 * 1000;
        const countdownMs = (schedule.countdownMinutes || 5) * 60 * 1000;

        this.timers.set(serverId, {
            backupTimer: null,
            countdownTimers: [],
            nextBackupAt: null
        });

        this._scheduleCycle(serverId, intervalMs, countdownMs);

        log('info', `Backup schedule started for server ${serverId}: every ${schedule.intervalHours}h, next at ${this.timers.get(serverId).nextBackupAt.toISOString()}`);
    }

    /**
     * Schedule one backup cycle: countdown timer + backup timer.
     * Called on start and after each backup completes to chain the next cycle.
     */
    _scheduleCycle(serverId, intervalMs, countdownMs) {
        const entry = this.timers.get(serverId);
        if (!entry) return;

        const nextBackupAt = new Date(Date.now() + intervalMs);
        entry.nextBackupAt = nextBackupAt;

        // Schedule countdown to start at (interval - countdown) before backup
        const countdownDelay = Math.max(intervalMs - countdownMs, 0);
        const countdownTimer = setTimeout(() => {
            this._startCountdown(serverId);
        }, countdownDelay);
        countdownTimer.unref();
        entry.countdownTimers.push(countdownTimer);

        // Schedule backup at exactly the interval boundary
        const backupTimer = setTimeout(async () => {
            // Cancel any remaining countdown chat timers
            for (const t of entry.countdownTimers) clearTimeout(t);
            entry.countdownTimers = [];

            try {
                await this._executeBackup(serverId);
            } catch (err) {
                log('error', `Scheduled backup failed for ${serverId}: ${err.message}`);
            }

            // Chain the next cycle
            if (this.timers.has(serverId)) {
                this._scheduleCycle(serverId, intervalMs, countdownMs);
            }
        }, intervalMs);
        backupTimer.unref();
        entry.backupTimer = backupTimer;
    }

    /**
     * Stop the backup schedule for a server.
     */
    stopSchedule(serverId) {
        const entry = this.timers.get(serverId);
        if (!entry) return;

        if (entry.backupTimer) clearTimeout(entry.backupTimer);
        for (const t of entry.countdownTimers) {
            clearTimeout(t);
        }
        this.timers.delete(serverId);
        log('info', `Backup schedule stopped for server ${serverId}`);
    }

    /**
     * Restart the schedule (e.g. after settings change).
     */
    async restartSchedule(serverId) {
        log('info', `Restarting backup schedule for server ${serverId}...`);
        this.stopSchedule(serverId);
        await this.startSchedule(serverId);
        log('info', `Backup schedule restarted for server ${serverId}`);
    }

    /**
     * Get the next scheduled backup time for a server.
     */
    getNextBackupTime(serverId) {
        const entry = this.timers.get(serverId);
        return entry?.nextBackupAt || null;
    }

    /**
     * Send countdown chat messages to the server. Only sends if the server is
     * running — the backup itself fires on its own timer regardless.
     */
    async _startCountdown(serverId) {
        try {
            const server = await serversDb.get(`server_${serverId}`);
            if (!server) return;

            const proc = this.serverManager.getProcess(serverId);
            const schedule = server.backupSchedule || {};
            const countdownMinutes = schedule.countdownMinutes || 5;
            const entry = this.timers.get(serverId);

            // Only send chat messages if server is running
            if (!proc || proc.state !== STATES.RUNNING) return;

            log('info', `[${server.name}] Scheduled backup: starting ${countdownMinutes}m countdown...`);

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
        } catch (err) {
            log('error', `Backup countdown failed for ${serverId}: ${err.message}`);
        }
    }

    /**
     * Execute the actual backup: stop the server if running, create backup,
     * apply retention, and restart if the server was running before.
     */
    async _executeBackup(serverId) {
        const server = await serversDb.get(`server_${serverId}`);
        if (!server) return;

        const schedule = server.backupSchedule || {};
        const p = this.serverManager.getProcess(serverId);

        if (!p || [STATES.STOPPED, STATES.CRASHED].includes(p.state)) {
            // Server not running — just backup directly
            log('info', `[${server.name}] Scheduled backup: server already stopped, creating backup...`);
            await this.serverManager.setOperationalState(serverId, STATES.BACKING_UP);
            try {
                const backup = await createBackup(serverId, 'Scheduled Backup', 'scheduled');
                await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);
                logEvent(serverId, 'backup_create', `Scheduled backup created (${formatSize(backup.size)})`, { initiatedBy: 'Backup Scheduler' }).catch(() => {});
            } catch (err) {
                log('error', `[${server.name}] Scheduled backup failed: ${err.message}`);
                logEvent(serverId, 'backup_create', `Scheduled backup failed: ${err.message}`, { initiatedBy: 'Backup Scheduler' }).catch(() => {});
            } finally {
                await this.serverManager.setOperationalState(serverId, STATES.STOPPED);
            }
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
        await this.serverManager.setOperationalState(serverId, STATES.BACKING_UP);
        try {
            const backup = await createBackup(serverId, 'Scheduled Backup', 'scheduled');
            await applyRetention(serverId, schedule.retentionCount || 0, schedule.retentionDays || 0);
            logEvent(serverId, 'backup_create', `Scheduled backup created (${formatSize(backup.size)})`, { initiatedBy: 'Backup Scheduler' }).catch(() => {});
        } catch (err) {
            log('error', `[${server.name}] Scheduled backup failed: ${err.message}`);
            logEvent(serverId, 'backup_create', `Scheduled backup failed: ${err.message}`, { initiatedBy: 'Backup Scheduler' }).catch(() => {});
        } finally {
            await this.serverManager.setOperationalState(serverId, STATES.STOPPED);
        }

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
