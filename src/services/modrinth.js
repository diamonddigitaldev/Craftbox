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
const SEARCH_MAX_LIMIT = 100; // Modrinth's per-request ceiling
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

// Server plugin platforms. Modrinth's search index files their projects under
// project_type:plugin — even though the API reports project_type "mod" on the
// hits themselves — so searching them as "mod" matches next to nothing
// ("essentials" over paper|spigot|bukkit returns 0 hits as a mod, 105 as a
// plugin). The loader group is what tells the two apart.
const PLUGIN_LOADERS = new Set(['paper', 'spigot', 'bukkit', 'purpur', 'folia']);

function projectTypeFacet(projectType, loaders) {
    if (projectType === 'modpack') return 'modpack';
    if (Array.isArray(loaders) && loaders.length && loaders.every(l => PLUGIN_LOADERS.has(l))) {
        return 'plugin';
    }
    return 'mod';
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
    const facets = [[`project_type:${projectTypeFacet(projectType, loaders)}`]];
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

/**
 * Search a whole loader group as one merged list.
 *
 * Modrinth's OR'd loader facet is a sound *filter* but not a sound *union* once
 * a text query is involved: how far it relaxes the query terms depends on the
 * filtered candidate set, so the same query answers differently per filter, in
 * both directions. Searching modpacks for "optimised fps", forge alone returns
 * 13 hits led by a 577k-download pack while fabric|forge|neoforge returns only
 * the 10 fabric ones and drops that pack entirely; searching "all the mods", the
 * OR'd facet finds 166 hits but the per-loader searches together find 153.
 *
 * Neither list contains the other, so this takes the union of both: the OR'd
 * search plus one search per loader. That can only ever add results Modrinth
 * itself would have returned for some slice of the same query.
 *
 * Every list is fetched once at SEARCH_MAX_LIMIT and paged from there, so
 * flipping through pages re-uses the same cached responses.
 */
async function searchProjectsAcrossLoaders({ query, projectType, loaders, gameVersion, index, offset, limit }) {
    const searches = [loaders, ...loaders.map(l => [l])].map(group => searchProjects({
        query, projectType, loaders: group, gameVersion, index, offset: 0, limit: SEARCH_MAX_LIMIT
    }));
    const lists = await Promise.all(searches);

    // Dedupe across lists (a pack listing both Forge and NeoForge is in several),
    // keeping the best rank it reached in any one of them.
    const best = new Map();
    for (const list of lists) {
        (list.hits || []).forEach((hit, rank) => {
            const seen = best.get(hit.project_id);
            if (!seen || rank < seen.rank) best.set(hit.project_id, { hit, rank });
        });
    }

    const merged = [...best.values()].sort(compareBy(index));
    return {
        hits: merged.slice(offset, offset + limit).map(e => e.hit),
        total_hits: merged.length,
        offset,
        limit
    };
}

// Re-impose the requested sort on the merged list. The sorted indexes have a
// field to sort on; relevance has no exposed score, so per-loader rank stands in
// for it (each list is the global relevance order projected onto one loader),
// with downloads breaking ties between loaders at the same rank.
function compareBy(index) {
    const num = (v) => Number(v) || 0;
    const date = (v) => Date.parse(v) || 0;
    switch (index) {
        case 'downloads': return (a, b) => num(b.hit.downloads) - num(a.hit.downloads);
        case 'follows': return (a, b) => num(b.hit.follows) - num(a.hit.follows);
        case 'newest': return (a, b) => date(b.hit.date_created) - date(a.hit.date_created);
        case 'updated': return (a, b) => date(b.hit.date_modified) - date(a.hit.date_modified);
        default: return (a, b) => a.rank - b.rank || num(b.hit.downloads) - num(a.hit.downloads);
    }
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
 *
 * The filters are re-applied locally on the way out: Modrinth honours them for
 * mods, but silently ignores them for *modpacks* — asking a Forge/NeoForge pack
 * for `loaders=["forge"]` returns its NeoForge versions too. Callers must be
 * able to trust that every version they get back matches what they asked for,
 * or a Forge search ends up installing a NeoForge pack.
 */
async function getProjectVersions(idOrSlug, { loaders, gameVersions } = {}) {
    const params = new URLSearchParams();
    if (Array.isArray(loaders) && loaders.length) params.set('loaders', JSON.stringify(loaders));
    if (Array.isArray(gameVersions) && gameVersions.length) params.set('game_versions', JSON.stringify(gameVersions));
    const qs = params.toString();
    const versions = await mrFetch(`/project/${encodeURIComponent(idOrSlug)}/version${qs ? `?${qs}` : ''}`, LOOKUP_TTL_MS);

    const wantLoaders = Array.isArray(loaders) && loaders.length ? loaders : null;
    const wantGameVersions = Array.isArray(gameVersions) && gameVersions.length ? gameVersions : null;
    return (Array.isArray(versions) ? versions : []).filter(v =>
        (!wantLoaders || (v.loaders || []).some(l => wantLoaders.includes(l)))
        && (!wantGameVersions || (v.game_versions || []).some(g => wantGameVersions.includes(g)))
    );
}

module.exports = {
    ModrinthApiError,
    ID_RE,
    SEARCH_MAX_LIMIT,
    searchProjects,
    searchProjectsAcrossLoaders,
    getProject,
    getVersion,
    getProjectVersions,
    getVersionsByHashes,
    isQuiltOnly
};
