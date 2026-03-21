const { statsDb } = require('../db');

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Append a stats data point for a server and prune entries older than 5 minutes.
 */
async function saveStats(serverId, dataPoint) {
    const key = `stats_${serverId}`;
    const history = (await statsDb.get(key)) || [];
    history.push(dataPoint);

    // Prune entries older than 5 minutes
    const cutoff = Date.now() - MAX_AGE_MS;
    const pruned = history.filter(p => p.timestamp >= cutoff);

    await statsDb.set(key, pruned);
}

/**
 * Get stats history for a server (up to 5 minutes).
 */
async function getStatsHistory(serverId) {
    const key = `stats_${serverId}`;
    const history = (await statsDb.get(key)) || [];

    // Filter out anything older than 5 minutes (in case of stale data)
    const cutoff = Date.now() - MAX_AGE_MS;
    return history.filter(p => p.timestamp >= cutoff);
}

/**
 * Clear stats history for a specific server.
 */
async function clearStatsHistory(serverId) {
    const key = `stats_${serverId}`;
    await statsDb.delete(key);
}

module.exports = { saveStats, getStatsHistory, clearStatsHistory };
