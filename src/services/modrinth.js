// Modrinth API client (server-side only). The browser never talks to Modrinth
// directly — CSP connect-src is 'self' — so everything goes through the
// /api/v1/modrinth proxy routes, which call this module.
//
// Modrinth asks for a descriptive User-Agent and allows ~300 requests/minute;
// a small TTL cache keeps repeated searches and project lookups off the wire.
const { log } = require('../utils/log');
const { USER_AGENT } = require('../utils/httpDownload');

const BASE = 'https://api.modrinth.com/v2';
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_TTL_MS = 60 * 1000;
const LOOKUP_TTL_MS = 300 * 1000;
const CACHE_MAX_ENTRIES = 200;

// Slugs are user-chosen (letters, digits and a small punctuation set); project
// and version IDs are base62. No spaces or slashes — safe to interpolate into
// a URL path once encodeURIComponent'd.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9!@$()`.+,_'-]{0,63}$/;

class ModrinthApiError extends Error {
    constructor(message, status, retryAfter) {
        super(message);
        this.name = 'ModrinthApiError';
        this.status = status;
        if (retryAfter) this.retryAfter = retryAfter;
    }
}

const cache = new Map(); // url -> { expires, data }

function getCached(url) {
    const hit = cache.get(url);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
        cache.delete(url);
        return undefined;
    }
    return hit.data;
}

function setCached(url, data, ttlMs) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        // Insertion order ≈ oldest first; dropping the first entry is enough.
        cache.delete(cache.keys().next().value);
    }
    cache.set(url, { expires: Date.now() + ttlMs, data });
}

async function mrRequest(pathAndQuery, options) {
    let res;
    try {
        res = await fetch(BASE + pathAndQuery, {
            ...options,
            headers: { 'User-Agent': USER_AGENT, ...(options && options.headers) },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (err) {
        const reason = err && err.name === 'TimeoutError' ? 'request timed out' : (err.message || String(err));
        throw new ModrinthApiError(`Modrinth request failed: ${reason}`, 0);
    }
    if (res.status === 404) throw new ModrinthApiError('Not found on Modrinth.', 404);
    if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after'), 10) || null;
        throw new ModrinthApiError('Modrinth rate limit reached.', 429, retryAfter);
    }
    if (!res.ok) throw new ModrinthApiError(`Modrinth returned HTTP ${res.status}.`, res.status);

    try {
        return await res.json();
    } catch {
        throw new ModrinthApiError('Modrinth returned an invalid response.', 502);
    }
}

async function mrFetch(pathAndQuery, ttlMs) {
    const url = BASE + pathAndQuery;
    const cached = getCached(url);
    if (cached !== undefined) return cached;

    const data = await mrRequest(pathAndQuery);
    setCached(url, data, ttlMs);
    return data;
}

/** True when a loaders array is Quilt-only (unsupported by Craftbox). */
function isQuiltOnly(loaders) {
    return Array.isArray(loaders)
        && loaders.length > 0
        && loaders.every(l => l === 'quilt');
}

/**
 * Search Modrinth projects. Facets are built server-side — the client never
 * supplies raw facet strings.
 * @param {object} p
 * @param {string} [p.query]
 * @param {string} p.projectType - 'modpack' | 'mod' | 'plugin'
 * @param {string[]} [p.loaders] - OR'd category facets (fabric, forge, paper, ...)
 * @param {string} [p.gameVersion]
 * @param {string} [p.index] - relevance|downloads|follows|newest|updated
 * @param {number} [p.offset]
 * @param {number} [p.limit]
 */
async function searchProjects({ query, projectType, loaders, gameVersion, index, offset, limit }) {
    const facets = [[`project_type:${projectType === 'modpack' ? 'modpack' : 'mod'}`]];
    if (Array.isArray(loaders) && loaders.length) {
        facets.push(loaders.map(l => `categories:${l}`));
    }
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (projectType === 'modpack') {
        // A server can't run a client-only pack; hide them up front.
        facets.push(['server_side:required', 'server_side:optional']);
    }

    const params = new URLSearchParams();
    if (query) params.set('query', query);
    params.set('facets', JSON.stringify(facets));
    params.set('index', index || 'relevance');
    params.set('offset', String(offset || 0));
    params.set('limit', String(limit || 20));
    return mrFetch(`/search?${params}`, SEARCH_TTL_MS);
}

async function getProject(idOrSlug) {
    return mrFetch(`/project/${encodeURIComponent(idOrSlug)}`, LOOKUP_TTL_MS);
}

async function getVersion(versionId) {
    return mrFetch(`/version/${encodeURIComponent(versionId)}`, LOOKUP_TTL_MS);
}

/**
 * Look up which known Modrinth versions a set of file hashes correspond to
 * (how launchers detect installed mods). Returns a map keyed by hash — only
 * matched hashes are present; each value is a full version object with
 * `project_id`. Not cached: the file set changes with every install.
 * @param {string[]} hashes - hex digests
 * @param {'sha512'|'sha1'} algorithm
 */
async function getVersionsByHashes(hashes, algorithm) {
    if (!hashes.length) return {};
    return mrRequest('/version_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes, algorithm })
    });
}

/**
 * List a project's versions, optionally filtered by loader / game version
 * (Modrinth expects both filters as JSON-encoded arrays).
 */
async function getProjectVersions(idOrSlug, { loaders, gameVersions } = {}) {
    const params = new URLSearchParams();
    if (Array.isArray(loaders) && loaders.length) params.set('loaders', JSON.stringify(loaders));
    if (Array.isArray(gameVersions) && gameVersions.length) params.set('game_versions', JSON.stringify(gameVersions));
    const qs = params.toString();
    return mrFetch(`/project/${encodeURIComponent(idOrSlug)}/version${qs ? `?${qs}` : ''}`, LOOKUP_TTL_MS);
}

module.exports = {
    ModrinthApiError,
    ID_RE,
    searchProjects,
    getProject,
    getVersion,
    getProjectVersions,
    getVersionsByHashes,
    isQuiltOnly
};
