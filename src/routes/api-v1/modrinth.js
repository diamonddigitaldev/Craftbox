// Same-origin proxy for the Modrinth API (browser CSP is connect-src 'self')
// plus the install-into-existing-server route. Server creation from a modpack
// lives in servers.js alongside the other create flows.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const modrinth = require('../../services/modrinth');
const { serversDb, SERVERS_DIR } = require('../../db');
const { getContentType } = require('../../utils/contentType');
const { isPathInside } = require('../../utils/pathSafety');
const { isZipFile } = require('../../utils/uploadSafety');
const { downloadToFile } = require('../../utils/httpDownload');
const { logEvent } = require('../../utils/eventLogger');
const { log } = require('../../utils/log');

const MC_VERSION_RE = /^\d+\.\d+(\.\d+)?(-\w+)?$/;
const SEARCH_INDEXES = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const MODPACK_LOADERS = ['fabric', 'forge', 'neoforge'];

// Craftbox server type -> Modrinth loader facets. Plugin platforms accept
// their upstream families (a Bukkit/Spigot plugin runs fine on Paper).
const LOADER_GROUPS = {
    fabric: ['fabric'],
    forge: ['forge'],
    neoforge: ['neoforge'],
    paper: ['paper', 'spigot', 'bukkit'],
    purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
    folia: ['folia']
};

function loaderGroupFor(serverTypeOrLoader) {
    return LOADER_GROUPS[serverTypeOrLoader] || null;
}

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

    try {
        const data = await modrinth.searchProjects({ query, projectType, loaders, gameVersion, index, offset, limit });
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

    // Same gate as uploads — no changing content under a running server
    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    const state = proc ? proc.state : server.state;
    if (!['stopped', 'crashed'].includes(state)) {
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

    const loaders = loaderGroupFor(server.serverType);
    const gameVersions = server.version && server.version !== 'latest' ? [server.version] : undefined;
    const contentDir = path.join(SERVERS_DIR, server.id, contentType.folder);
    const installed = [];
    const seenProjects = new Set();

    // Recursive, cycle-safe, depth-capped. The requested project (depth 0) is
    // strict — incompatibilities are errors. Dependencies degrade gracefully:
    // already-installed or version-less deps are skipped with a log line.
    async function installProject(pid, wantedVersionId, depth) {
        if (depth > 5 || seenProjects.has(pid)) return;
        seenProjects.add(pid);

        const versions = await modrinth.getProjectVersions(pid, { loaders, gameVersions });
        let version;
        if (depth === 0 && wantedVersionId) {
            version = (versions || []).find(v => v.id === wantedVersionId);
        } else {
            // Deps: prefer the pinned version when compatible, else newest compatible
            version = (wantedVersionId && (versions || []).find(v => v.id === wantedVersionId))
                || (versions || [])[0];
        }
        if (!version) {
            if (depth === 0) {
                const e = new Error('No compatible version found for this server.');
                e.httpStatus = 404;
                throw e;
            }
            log('warn', `Modrinth install for ${server.id}: no compatible version of dependency ${pid} — skipped.`);
            return;
        }

        const file = (version.files || []).find(f => f.primary) || (version.files || [])[0];
        if (!file || !/\.jar$/i.test(file.filename || '')) {
            if (depth === 0) {
                const e = new Error('This version has no installable .jar file.');
                e.httpStatus = 400;
                throw e;
            }
            log('warn', `Modrinth install for ${server.id}: dependency ${pid} has no .jar file — skipped.`);
            return;
        }

        const filename = path.basename(file.filename);
        const dest = path.join(contentDir, filename);
        if (!isPathInside(contentDir, dest)) {
            const e = new Error('Invalid file name.');
            e.httpStatus = 400;
            throw e;
        }
        if (fs.existsSync(dest)) {
            if (depth === 0) {
                const e = new Error(`"${filename}" is already installed.`);
                e.httpStatus = 409;
                throw e;
            }
            return; // dependency already present
        }

        await downloadToFile(file.url, dest, {
            maxBytes: 2 * 1024 * 1024 * 1024,
            sha512: file.hashes?.sha512 || null,
            enforceWhitelist: true
        });
        if (!isZipFile(dest)) {
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            throw new Error(`"${filename}" is not a valid jar file.`);
        }
        installed.push({ filename, versionNumber: version.version_number, projectId: pid });

        for (const dep of version.dependencies || []) {
            if (dep.dependency_type === 'required' && dep.project_id) {
                await installProject(dep.project_id, dep.version_id || null, depth + 1);
            }
        }
    }

    try {
        fs.mkdirSync(contentDir, { recursive: true });
        await installProject(projectId, versionId || null, 0);
        const names = installed.map(i => `"${i.filename}"`).join(', ');
        logEvent(server.id, 'action', `Installed ${names} from Modrinth`, { initiatedBy: req.user.username }).catch(() => {});
        log('info', `Installed ${names} from Modrinth into server ${server.id}.`);
        res.json({ success: true, installed });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
        if (err instanceof modrinth.ModrinthApiError) return sendModrinthError(res, err);
        log('error', `Modrinth install failed for server ${server.id}: ${err.message}`);
        res.status(500).json({ error: err.message || 'Install failed.' });
    }
});

module.exports = router;
// Shared with servers.js (from-modpack) — a router is a function, so
// attaching helpers keeps the conventional `router.use(require(...))` intact.
module.exports.loaderGroupFor = loaderGroupFor;
module.exports.MODPACK_LOADERS = MODPACK_LOADERS;
module.exports.sendModrinthError = sendModrinthError;
