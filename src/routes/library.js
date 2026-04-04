const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { SERVERS_DIR } = require('../db');
const { log } = require('../utils/log');
const { getContentType } = require('../utils/contentType');
const { getServerWithState, formatSize } = require('../utils/serverHelper');
const modrinth = require('../utils/modrinth');

function formatDownloads(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

// Browse / search page
router.get('/servers/:id/plugins/browse', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const contentType = getContentType(server.serverType);
    if (!contentType) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user,
            message: 'This server type does not support plugins or mods.'
        });
    }

    const query = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const sort = req.query.sort || 'relevance';
    const category = req.query.category || '';
    const limit = 40;
    const offset = (page - 1) * limit;

    const gameVersions = server.version ? [server.version] : [];
    const categories = category ? [category] : [];

    let results = null;
    let error = null;
    let availableCategories = [];

    try {
        [results, availableCategories] = await Promise.all([
            modrinth.searchProjects(query, contentType.loaders, gameVersions, {
                offset, limit, sort, categories
            }),
            modrinth.getCategories(contentType.projectType)
        ]);
    } catch (err) {
        log('error', `Library search failed: ${err.message}`);
        error = err.message;
    }

    const totalPages = results ? Math.ceil(results.total_hits / limit) : 0;

    res.render('servers/library', {
        title: server.name + ' ' + contentType.label + ' Library',
        server,
        contentType,
        results: results ? results.hits : [],
        totalHits: results ? results.total_hits : 0,
        query,
        page,
        totalPages,
        sort,
        category,
        categories: availableCategories,
        error,
        formatDownloads,
        user: req.user,
        csrfToken: res.locals.csrfToken
    });
});

// Project detail page
router.get('/servers/:id/plugins/browse/project/:slug', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const contentType = getContentType(server.serverType);
    if (!contentType) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user,
            message: 'This server type does not support plugins or mods.'
        });
    }

    const gameVersions = server.version ? [server.version] : [];

    // Read installed filenames for "already installed" detection
    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);
    let installedFiles = new Set();
    try {
        const entries = fs.readdirSync(contentDir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory() && e.name.toLowerCase().endsWith('.jar')) {
                installedFiles.add(e.name.toLowerCase());
            }
        }
    } catch { /* folder may not exist yet */ }

    let project = null;
    let versions = [];
    let error = null;

    try {
        [project, versions] = await Promise.all([
            modrinth.getProject(req.params.slug),
            modrinth.getProjectVersions(req.params.slug, contentType.loaders, gameVersions)
        ]);
    } catch (err) {
        log('error', `Library project fetch failed: ${err.message}`);
        if (err.status === 404) {
            return res.status(404).render('errors/404', {
                title: '404', navbar: true, user: req.user,
                message: 'Project not found on Modrinth.'
            });
        }
        error = err.message;
    }

    res.render('servers/libraryProject', {
        title: (project ? project.title : 'Project') + ' — ' + server.name,
        server,
        contentType,
        project,
        versions,
        installedFiles,
        error,
        formatDownloads,
        formatSize,
        user: req.user,
        csrfToken: res.locals.csrfToken
    });
});

// Version list (JSON)

router.get('/servers/:id/plugins/browse/api/versions/:projectId', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) return res.status(400).json({ error: 'Not supported.' });

    const gameVersions = server.version ? [server.version] : [];

    try {
        const versions = await modrinth.getProjectVersions(
            req.params.projectId, contentType.loaders, gameVersions
        );
        const mapped = versions.map(v => {
            const primaryFile = v.files.find(f => f.primary) || v.files[0];
            return {
                id: v.id,
                versionNumber: v.version_number,
                name: v.name,
                gameVersions: v.game_versions,
                loaders: v.loaders,
                channel: v.version_type,
                downloads: v.downloads,
                fileName: primaryFile ? primaryFile.filename : null,
                fileSize: primaryFile ? primaryFile.size : null,
                fileSizeFormatted: primaryFile ? formatSize(primaryFile.size) : null,
                fileUrl: primaryFile ? primaryFile.url : null,
                dependencies: v.dependencies || [],
                datePublished: v.date_published
            };
        });
        res.json(mapped);
    } catch (err) {
        log('error', `Library version fetch failed: ${err.message}`);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// Download & install from Modrinth
router.post('/servers/:id/plugins/browse/api/install', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) return res.status(400).json({ error: 'Not supported.' });

    if (!['stopped', 'crashed'].includes(server.state)) {
        return res.status(400).json({
            error: `Stop the server before installing ${contentType.label.toLowerCase()}.`
        });
    }

    const { fileUrl, fileName, otherFiles } = req.body;
    if (!fileUrl || typeof fileUrl !== 'string') {
        return res.status(400).json({ error: 'No file URL specified.' });
    }
    if (!fileName || typeof fileName !== 'string') {
        return res.status(400).json({ error: 'No file name specified.' });
    }

    // Security: only allow Modrinth CDN downloads
    if (!fileUrl.startsWith('https://cdn.modrinth.com/')) {
        return res.status(400).json({ error: 'Invalid download URL.' });
    }

    // Sanitize filename
    const safeName = path.basename(fileName).replace(/[/\\]/g, '');
    if (!safeName.toLowerCase().endsWith('.jar')) {
        return res.status(400).json({ error: 'Only .jar files can be installed.' });
    }

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);
    fs.mkdirSync(contentDir, { recursive: true });

    const destPath = path.join(contentDir, safeName);

    // Security: ensure destination stays within content directory
    if (!path.resolve(destPath).startsWith(path.resolve(contentDir))) {
        return res.status(403).json({ error: 'Access denied.' });
    }

    // Remove other versions of the same project before installing
    if (Array.isArray(otherFiles)) {
        for (const other of otherFiles) {
            if (typeof other !== 'string') continue;
            const otherSafe = path.basename(other).replace(/[/\\]/g, '');
            if (otherSafe.toLowerCase() === safeName.toLowerCase()) continue; // skip the one we're about to install
            const otherPath = path.resolve(contentDir, otherSafe);
            if (!otherPath.startsWith(path.resolve(contentDir))) continue;
            try { fs.unlinkSync(otherPath); } catch { /* may not exist */ }
        }
    }

    // Download to temp file first, then move
    const tmpPath = path.join(os.tmpdir(), `craftbox-dl-${Date.now()}-${safeName}`);
    try {
        await modrinth.downloadFile(fileUrl, tmpPath);
        fs.copyFileSync(tmpPath, destPath);
        log('info', `Installed "${safeName}" from Modrinth to server ${server.name} (${server.id})`);
        res.json({ success: true, fileName: safeName });
    } catch (err) {
        log('error', `Library install failed for ${server.name}: ${err.message}`);
        res.status(500).json({ error: 'Download failed: ' + err.message });
    } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
});

module.exports = router;
