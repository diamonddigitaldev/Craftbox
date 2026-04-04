const { version } = require('../../package.json');

const BASE_URL = 'https://api.modrinth.com/v2/';
const USER_AGENT = `Craftbox/${version} (https://github.com/diamonddigitaldev/Craftbox)`;

// In-memory TTL cache
const cache = new Map();
const TTL = {
    search: 2 * 60 * 1000,      // 2 minutes
    project: 5 * 60 * 1000,     // 5 minutes
    versions: 5 * 60 * 1000,    // 5 minutes
    categories: 60 * 60 * 1000  // 1 hour
};

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { cache.delete(key); return null; }
    return entry.data;
}

function cacheSet(key, data, ttl) {
    cache.set(key, { data, expires: Date.now() + ttl });
}

// HTTP helper
async function modrinthFetch(endpoint, params = {}) {
    const url = new URL(endpoint.replace(/^\//, ''), BASE_URL);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT }
    });
    if (res.status === 429) {
        const err = new Error('Modrinth API rate limit reached. Please try again in a moment.');
        err.status = 429;
        throw err;
    }
    if (!res.ok) {
        const err = new Error(`Modrinth API error: ${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

// Public API

/**
 * Search for projects on Modrinth.
 * @param {string} query        Search text (empty string for browse)
 * @param {string[]} loaders    e.g. ['paper', 'spigot', 'bukkit']
 * @param {string[]} gameVersions  e.g. ['1.21.1']
 * @param {object} options      { offset, limit, sort, categories }
 */
async function searchProjects(query, loaders, gameVersions, options = {}) {
    const { offset = 0, limit = 20, sort = 'relevance', categories = [] } = options;

    // Build facets: loaders OR'd together, versions AND'd, categories AND'd
    const facets = [];
    if (loaders.length) facets.push(loaders.map(l => `categories:${l}`));
    if (gameVersions.length) facets.push(gameVersions.map(v => `versions:${v}`));
    for (const cat of categories) facets.push([`categories:${cat}`]);

    const cacheKey = `search:${JSON.stringify({ query, facets, offset, limit, sort })}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const data = await modrinthFetch('/search', {
        query: query || undefined,
        facets: JSON.stringify(facets),
        offset,
        limit,
        index: sort
    });
    cacheSet(cacheKey, data, TTL.search);
    return data;
}

/**
 * Get full project details.
 * @param {string} idOrSlug  Project ID or slug
 */
async function getProject(idOrSlug) {
    const cacheKey = `project:${idOrSlug}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const data = await modrinthFetch(`/project/${encodeURIComponent(idOrSlug)}`);
    cacheSet(cacheKey, data, TTL.project);
    return data;
}

/**
 * Get versions for a project, filtered by loader and game version.
 * @param {string} projectId
 * @param {string[]} loaders
 * @param {string[]} gameVersions
 */
async function getProjectVersions(projectId, loaders, gameVersions) {
    const cacheKey = `versions:${projectId}:${JSON.stringify({ loaders, gameVersions })}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const data = await modrinthFetch(`/project/${encodeURIComponent(projectId)}/version`, {
        loaders: JSON.stringify(loaders),
        game_versions: JSON.stringify(gameVersions)
    });
    cacheSet(cacheKey, data, TTL.versions);
    return data;
}

/**
 * Get Modrinth categories for a given project type.
 * @param {string} projectType  'plugin' or 'mod'
 */
async function getCategories(projectType) {
    const cacheKey = `categories:${projectType}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const all = await modrinthFetch('/tag/category');
    // Filter to categories relevant to the project type and the "categories" header
    const filtered = all.filter(c => c.project_type === projectType && c.header === 'categories');
    cacheSet(cacheKey, filtered, TTL.categories);
    return filtered;
}

/**
 * Download a file from Modrinth CDN to a local path.
 * @param {string} fileUrl   Must start with https://cdn.modrinth.com/
 * @param {string} destPath  Absolute path to write the file
 */
async function downloadFile(fileUrl, destPath) {
    if (!fileUrl.startsWith('https://cdn.modrinth.com/')) {
        throw new Error('Invalid download URL: must be from cdn.modrinth.com');
    }
    const res = await fetch(fileUrl, {
        headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) {
        throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }
    const fs = require('fs');
    const fileStream = fs.createWriteStream(destPath);
    // Pipe the response body (ReadableStream) to a file
    const reader = res.body.getReader();
    return new Promise((resolve, reject) => {
        fileStream.on('error', reject);
        fileStream.on('finish', resolve);
        (async function pump() {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { fileStream.end(); break; }
                    if (!fileStream.write(value)) {
                        await new Promise(r => fileStream.once('drain', r));
                    }
                }
            } catch (err) { fileStream.destroy(err); reject(err); }
        })();
    });
}

module.exports = {
    searchProjects,
    getProject,
    getProjectVersions,
    getCategories,
    downloadFile
};
