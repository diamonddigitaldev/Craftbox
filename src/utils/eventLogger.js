const { v4: uuidv4 } = require('uuid');
const { eventsDb } = require('../db');
const { log } = require('./log');

// Set once at boot by src/server.js. Kept as an injected function rather than a
// direct ServerManager import so this module stays free of the process layer
// (which requires this one — importing both ways would be circular).
let broadcaster = null;

/**
 * Register the sink that pushes newly logged events to WebSocket subscribers.
 * @param {(serverId: string, event: object) => void} fn
 */
function setEventBroadcaster(fn) {
    broadcaster = fn;
}

/**
 * Log a structured event for a server, then push it to anyone watching.
 *
 * Broadcasting from here rather than from each call site is what makes the
 * event log live for *every* event type — backups, jar upgrades and user
 * actions are all logged through this function, and previously none of them
 * reached a socket.
 */
async function logEvent(serverId, type, message, extra = {}) {
    const event = {
        id: uuidv4(),
        serverId,
        type,
        message,
        createdAt: new Date().toISOString(),
        ...extra
    };
    try {
        await eventsDb.set(`event_${event.id}`, event);
    } catch (err) {
        log('error', `Failed to log event: ${err.message}`);
    }

    // After the write, so a client that reacts by refetching sees this event.
    if (broadcaster) {
        try {
            broadcaster(serverId, event);
        } catch (err) {
            log('warn', `Failed to broadcast event: ${err.message}`);
        }
    }
    return event;
}

/**
 * Get events for a server, newest first.
 */
async function getEvents(serverId, { limit = 50, types = null } = {}) {
    const all = await eventsDb.all();
    let events = all
        .map(row => row.value)
        .filter(e => e.serverId === serverId);

    if (types) {
        events = events.filter(e => types.includes(e.type));
    }

    events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return events.slice(0, limit);
}

/**
 * Prune old events for a server, keeping only the most recent maxCount.
 */
async function pruneEvents(serverId, maxCount = 500) {
    try {
        const all = await eventsDb.all();
        const serverEvents = all
            .filter(row => row.value.serverId === serverId)
            .sort((a, b) => new Date(b.value.createdAt) - new Date(a.value.createdAt));

        if (serverEvents.length > maxCount) {
            const toDelete = serverEvents.slice(maxCount);
            for (const row of toDelete) {
                await eventsDb.delete(row.id);
            }
        }
    } catch (err) {
        log('error', `Failed to prune events: ${err.message}`);
    }
}

/**
 * Delete all events for a server (used when server is deleted).
 */
async function deleteServerEvents(serverId) {
    try {
        const all = await eventsDb.all();
        for (const row of all) {
            if (row.value.serverId === serverId) {
                await eventsDb.delete(row.id);
            }
        }
    } catch (err) {
        log('error', `Failed to delete server events: ${err.message}`);
    }
}

module.exports = { logEvent, setEventBroadcaster, getEvents, pruneEvents, deleteServerEvents };
