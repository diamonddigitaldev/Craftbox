// Same-origin proxy for the Modrinth API (browser CSP is connect-src 'self')
// plus the routes that install and update an existing server's mods and
// plugins. Server creation from a modpack lives in servers.js alongside the
// other create flows.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const modrinth = require('../../services/modrinth');
const { loaderGroupFor, scanInstalled, describeRow, installProject, updateContent } = require('../../services/modrinthContent');
const { serversDb, SERVERS_DIR } = require('../../db');
const { getContentType } = require('../../utils/contentType');
const { logEvent } = require('../../utils/eventLogger');
const { log } = require('../../utils/log');
const { notifyContentChanged } = require('../../utils/liveUpdates');
// Shared with the server routes — accepts snapshot/pre-release ids so
// browsing plugins/mods still works on snapshot servers.
const { MC_VERSION_RE } = require('../../utils/mcVersion');
const SEARCH_INDEXES = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const MODPACK_LOADERS = ['fabric', 'forge', 'neoforge'];

function sendModrinthError(res, err) {
    if (err instanceof modrinth.ModrinthApiError) {
        if (err.status === 404) return res.status(404).json({ error: 'Not found on Modrinth.' });
        if (err.status === 429) return res.status(429).json({ error: 'Modrinth rate limit reached. Try again shortly.' });
        log('warn', `Modrinth API error: ${err.message}`);
        return res.status(502).json({ error: 'Modrinth is unavailable right now.' });
    }
    log('error', `Modrinth proxy error: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong talking to Modrinth.' });
}

function mapHit(h) {
    return {
        projectId: h.project_id,
        slug: h.slug,
        title: h.title,
        description: h.description,
        iconUrl: h.icon_url || null,
        author: h.author,
        downloads: h.downloads,
        categories: h.display_categories || h.categories || [],
        serverSide: h.server_side,
        clientSide: h.client_side,
        dateModified: h.date_modified
    };
}

function mapVersion(v) {
    return {
        id: v.id,
        name: v.name,
        versionNumber: v.version_number,
        gameVersions: v.game_versions || [],
        loaders: v.loaders || [],
        datePublished: v.date_published,
        files: (v.files || []).map(f => ({ filename: f.filename, size: f.size, primary: !!f.primary }))
    };
}

// GET /modrinth/search — proxied project search
router.get('/modrinth/search', async (req, res) => {
    const projectType = req.query.projectType || 'modpack';
    if (projectType !== 'modpack' && projectType !== 'mod') {
        return res.status(400).json({ error: 'Invalid project type.' });
    }

    const query = typeof req.query.query === 'string' ? req.query.query.trim().slice(0, 256) : '';

    let loaders;
    if (req.query.loader) {
        loaders = loaderGroupFor(req.query.loader);
        if (!loaders) return res.status(400).json({ error: 'Invalid loader.' });
        if (projectType === 'modpack' && !MODPACK_LOADERS.includes(req.query.loader)) {
            return res.status(400).json({ error: 'Invalid loader.' });
        }
    } else if (projectType === 'modpack') {
        // Default facet group doubles as the Quilt filter: a quilt-only pack
        // carries none of these categories, so Modrinth excludes it for us.
        loaders = MODPACK_LOADERS;
    } else {
        return res.status(400).json({ error: 'A loader is required when searching mods.' });
    }

    const gameVersion = req.query.gameVersion || null;
    if (gameVersion && !MC_VERSION_RE.test(gameVersion)) {
        return res.status(400).json({ error: 'Invalid Minecraft version.' });
    }

    const index = req.query.index || 'relevance';
    if (!SEARCH_INDEXES.includes(index)) return res.status(400).json({ error: 'Invalid sort option.' });

    const offset = parseInt(req.query.offset, 10) || 0;
    if (offset < 0 || offset > 10000) return res.status(400).json({ error: 'Invalid offset.' });
    let limit = parseInt(req.query.limit, 10) || 20;
    if (limit < 1 || limit > 50) limit = 20;

    // Modrinth's OR'd loader facet drops whole loaders' results for some text
    // queries (see searchProjectsAcrossLoaders), so a search that spans more than
    // one loader is unioned here instead. Without a query the facet is a plain
    // filter and behaves, so browsing stays a single request and pages as deep as
    // Modrinth allows.
    const search = (query && loaders.length > 1)
        ? modrinth.searchProjectsAcrossLoaders
        : modrinth.searchProjects;

    try {
        const data = await search({ query, projectType, loaders, gameVersion, index, offset, limit });
        res.json({
            hits: (data.hits || []).map(mapHit),
            totalHits: data.total_hits || 0,
            offset: data.offset || 0,
            limit: data.limit || limit
        });
    } catch (err) {
        sendModrinthError(res, err);
    }
});

// GET /modrinth/projects/:idOrSlug — proxied project lookup
router.get('/modrinth/projects/:idOrSlug', async (req, res) => {
    const idOrSlug = req.params.idOrSlug;
    if (!modrinth.ID_RE.test(idOrSlug)) return res.status(400).json({ error: 'Invalid project id.' });

    try {
        const p = await modrinth.getProject(idOrSlug);
        res.json({
            project: {
                projectId: p.id,
                slug: p.slug,
                title: p.title,
                description: p.description,
                iconUrl: p.icon_url || null,
                categories: p.categories || [],
                serverSide: p.server_side,
                clientSide: p.client_side,
                downloads: p.downloads,
                projectType: p.project_type
            }
        });
    } catch (err) {
        sendModrinthError(res, err);
    }
});

// GET /modrinth/projects/:idOrSlug/versions — proxied version list
router.get('/modrinth/projects/:idOrSlug/versions', async (req, res) => {
    const idOrSlug = req.params.idOrSlug;
    if (!modrinth.ID_RE.test(idOrSlug)) return res.status(400).json({ error: 'Invalid project id.' });

    let loaders = MODPACK_LOADERS;
    if (req.query.loader) {
        loaders = loaderGroupFor(req.query.loader);
        if (!loaders) return res.status(400).json({ error: 'Invalid loader.' });
    }
    const gameVersion = req.query.gameVersion || null;
    if (gameVersion && !MC_VERSION_RE.test(gameVersion)) {
        return res.status(400).json({ error: 'Invalid Minecraft version.' });
    }

    try {
        const versions = await modrinth.getProjectVersions(idOrSlug, {
            loaders,
            gameVersions: gameVersion ? [gameVersion] : undefined
        });
        res.json({
            versions: (versions || [])
                .filter(v => !modrinth.isQuiltOnly(v.loaders))
                .map(mapVersion)
        });
    } catch (err) {
        sendModrinthError(res, err);
    }
});

// GET /servers/:id/modrinth-installed — which Modrinth projects are already
// present in the server's content folder, matched by file hash the way
// launchers do it, and which of them have a newer version for the server.
// Locally-built or modified jars simply won't match — the 409 on install
// remains the fallback for those.
router.get('/servers/:id/modrinth-installed', async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    if (!getContentType(server.serverType)) {
        return res.status(400).json({ error: 'This server type does not support plugins or mods.' });
    }

    try {
        const rows = await scanInstalled(server);
        const projects = {};
        const updates = {};
        for (const row of rows) {
            projects[row.projectId] = row.filename;
            if (row.updateAvailable) updates[row.projectId] = describeRow(row);
        }
        res.json({ projects, updates, files: rows.map(describeRow) });
    } catch (err) {
        sendModrinthError(res, err);
    }
});

// Same gate as uploads — no changing content under a running server
function contentLocked(req, server) {
    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    const state = proc ? proc.state : server.state;
    return !['stopped', 'crashed'].includes(state);
}

// POST /servers/:id/modrinth-install — install a mod/plugin (and its required
// dependencies, Modrinth-style "also installs Fabric API") from Modrinth into
// an existing server's content folder. Single-jar downloads are quick, so this
// runs synchronously within the request like a plugin upload.
router.post('/servers/:id/modrinth-install', async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) {
        return res.status(400).json({ error: 'This server type does not support plugins or mods.' });
    }
    if (contentLocked(req, server)) {
        return res.status(400).json({ error: `The server must be stopped before installing ${contentType.label.toLowerCase()}.` });
    }

    const { projectId, versionId } = req.body || {};
    if (typeof projectId !== 'string' || !modrinth.ID_RE.test(projectId)) {
        return res.status(400).json({ error: 'Invalid project id.' });
    }
    if (versionId !== undefined && versionId !== null
        && (typeof versionId !== 'string' || !modrinth.ID_RE.test(versionId))) {
        return res.status(400).json({ error: 'Invalid version id.' });
    }

    const installed = [];
    try {
        fs.mkdirSync(path.join(SERVERS_DIR, server.id, contentType.folder), { recursive: true });
        await installProject({ server, installed, seenProjects: new Set() }, projectId, versionId || null, 0);
        const names = installed.map(i => `"${i.filename}"`).join(', ');
        logEvent(server.id, 'action', `Installed ${names} from Modrinth`, { initiatedBy: req.user.username }).catch(() => {});
        log('info', `Installed ${names} from Modrinth into server ${server.id}.`);
        res.json({ success: true, installed });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
        if (err instanceof modrinth.ModrinthApiError) return sendModrinthError(res, err);
        log('error', `Modrinth install failed for server ${server.id}: ${err.message}`);
        res.status(500).json({ error: err.message || 'Install failed.' });
    } finally {
        // A dependency that failed part-way still left the earlier files on
        // disk, so the listing moved either way.
        if (installed.length > 0) notifyContentChanged(req, server.id, 'plugins');
    }
});

// POST /servers/:id/modrinth-update — update installed Modrinth mods/plugins
// to the newest version for the server's loader and Minecraft version. Body
// {filenames?}: the listed files only, or every file with an update when
// omitted. Synchronous, like an install.
router.post('/servers/:id/modrinth-update', async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) {
        return res.status(400).json({ error: 'This server type does not support plugins or mods.' });
    }
    if (contentLocked(req, server)) {
        return res.status(400).json({ error: `The server must be stopped before updating ${contentType.label.toLowerCase()}.` });
    }

    let filenames;
    const body = req.body || {};
    if (body.filenames !== undefined && body.filenames !== null) {
        if (!Array.isArray(body.filenames) || body.filenames.length === 0 || body.filenames.length > 1000
            || !body.filenames.every(f => typeof f === 'string' && f && f === path.basename(f))) {
            return res.status(400).json({ error: 'filenames must be a list of file names.' });
        }
        filenames = body.filenames;
    }

    let result;
    try {
        result = await updateContent(server, { filenames });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
        if (err instanceof modrinth.ModrinthApiError) return sendModrinthError(res, err);
        log('error', `Modrinth update failed for server ${server.id}: ${err.message}`);
        return res.status(500).json({ error: err.message || 'Update failed.' });
    }

    if (result.updated.length > 0 || result.installed.length > 0) {
        const names = result.updated.map(u => `"${u.newFilename}"`)
            .concat(result.installed.map(i => `"${i.filename}"`)).join(', ');
        logEvent(server.id, 'action', `Updated ${names} from Modrinth`, { initiatedBy: req.user.username }).catch(() => {});
        log('info', `Updated ${names} from Modrinth on server ${server.id}.`);
        notifyContentChanged(req, server.id, 'plugins');
    }
    res.json({ success: true, ...result });
});

module.exports = router;
// Shared with servers.js (from-modpack) — a router is a function, so
// attaching helpers keeps the conventional `router.use(require(...))` intact.
module.exports.loaderGroupFor = loaderGroupFor;
module.exports.MODPACK_LOADERS = MODPACK_LOADERS;
module.exports.sendModrinthError = sendModrinthError;
