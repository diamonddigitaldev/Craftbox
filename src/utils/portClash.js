const path = require('path');
const { serversDb, SERVERS_DIR } = require('../db');
const { parseServerProperties } = require('../mc/serverProperties');
const { log } = require('./log');

// Two Minecraft servers can't listen on the same port at the same address.
// server-ip is blank unless someone sets it, and blank means every address,
// so a shared port only works when both servers are bound to different
// specific addresses.
function addressesOverlap(ipA, ipB) {
    const a = String(ipA || '').trim();
    const b = String(ipB || '').trim();
    return !a || !b || a === b;
}

/** The address a server's server.properties binds it to ('' for every one). */
function serverIpOf(serverId) {
    return parseServerProperties(path.join(SERVERS_DIR, serverId))['server-ip'] || '';
}

/**
 * The other servers saved with `port` at an address overlapping `serverIp`,
 * whatever state they're in.
 * @param {number|string} port
 * @param {{ excludeId?: string|null, serverIp?: string }} [opts]
 */
async function serversSharingPort(port, { excludeId = null, serverIp = '' } = {}) {
    const rows = await serversDb.all();
    return rows
        .map(row => row?.value)
        .filter(s => s && s.id && s.id !== excludeId && Number(s.port) === Number(port))
        .filter(s => !serverIp || addressesOverlap(serverIp, serverIpOf(s.id)));
}

/**
 * Every server's port, for a form to warn about a shared one as it's typed
 * (public/js/app.js watchPortClash). Servers bound to an address that can't
 * overlap `serverIp` are left out, as they are from the warnings.
 * @returns {Promise<Array<{id: string, name: string, port: number}>>}
 */
async function portsInUse({ serverIp = '' } = {}) {
    try {
        const rows = await serversDb.all();
        return rows
            .map(row => row?.value)
            .filter(s => s && s.id && Number.isInteger(Number(s.port)))
            .filter(s => !serverIp || addressesOverlap(serverIp, serverIpOf(s.id)))
            .map(s => ({ id: s.id, name: s.name, port: Number(s.port) }));
    } catch (err) {
        log('warn', `Listing ports in use failed: ${err.message}`);
        return [];
    }
}

// Each name once: an import or a copy can share its source's name
function listNames(servers) {
    const names = [...new Set(servers.map(s => `"${s.name}"`))];
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The warnings to return when a server is saved (created, edited, duplicated,
 * imported) with a port other servers use too. Sharing one isn't refused: only
 * one of them can run at a time, which is a fair way to keep a copy of a
 * server beside it. Starting one while another holds the port is what's
 * refused (ServerManager.startServer). A warning never fails the save it
 * comes with, so a failure to work one out is logged and nothing is returned.
 * @returns {Promise<string[]>}
 */
async function portClashWarnings(port, opts) {
    try {
        const others = await serversSharingPort(port, opts);
        if (others.length === 0) return [];
        return [`Port ${port} is also used by ${listNames(others)}. Only one of them can run at a time.`];
    } catch (err) {
        log('warn', `Port clash check failed: ${err.message}`);
        return [];
    }
}

module.exports = { addressesOverlap, serverIpOf, serversSharingPort, portClashWarnings, portsInUse };
