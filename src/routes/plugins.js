const express = require('express');
const fs = require('fs');
const path = require('path');
const contentDisposition = require('content-disposition');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, SERVERS_DIR } = require('../db');
const { log } = require('../utils/log');
const { getContentType } = require('../utils/contentType');
const {
    DISABLED_SUFFIX,
    getModEnvMap,
    listModFiles
} = require('../utils/modEnvironment');
const { isPathInside } = require('../utils/pathSafety');

async function getServerWithState(req) {
    const id = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const server = await serversDb.get(`server_${id}`);
    if (!server) return null;
    const serverManager = req.app.get('serverManager');
    if (serverManager) {
        const proc = serverManager.getProcess(id);
        if (proc) server.state = proc.state;
    }
    return server;
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
}

// GET /servers/:id/plugins — Plugins/Mods page (view only; mutations live on /api/v1)
router.get('/servers/:id/plugins', ensureAuth, async (req, res) => {
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

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);

    fs.mkdirSync(contentDir, { recursive: true });

    const isMods = contentType.label === 'Mods';
    const modFiles = listModFiles(contentDir);

    let envMap = {};
    if (isMods) {
        envMap = await getModEnvMap(server.id);
    }

    const files = modFiles.map(entry => {
        let environment = 'both';
        if (isMods) {
            if (entry.isDisabled) {
                environment = 'client';
            } else {
                environment = envMap[entry.displayName] || 'both';
            }
        }
        return {
            name: entry.displayName,
            size: entry.size,
            sizeFormatted: formatSize(entry.size),
            modified: entry.modified,
            modifiedISO: entry.modified.toISOString(),
            environment
        };
    });

    res.render('servers/plugins', {
        title: server.name + ' ' + contentType.label,
        description: `View and manage installed ${contentType.label.toLowerCase()} for ${server.name}.`,
        server,
        contentType,
        files,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// GET /servers/:id/plugins/download — Download a single plugin/mod JAR (binary)
router.get('/servers/:id/plugins/download', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) return res.status(400).json({ error: 'Not supported.' });

    const filename = req.query.file;
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'No filename specified.' });
    }

    const safeName = path.basename(filename);
    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);
    const targetPath = path.resolve(contentDir, safeName);

    if (!isPathInside(contentDir, targetPath)) {
        return res.status(403).json({ error: 'Access denied.' });
    }

    const disabledPath = targetPath + DISABLED_SUFFIX;
    let sourcePath = null;
    if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
        sourcePath = targetPath;
    } else if (fs.existsSync(disabledPath) && !fs.statSync(disabledPath).isDirectory()) {
        sourcePath = disabledPath;
    }

    if (!sourcePath) {
        return res.status(404).json({ error: 'File not found.' });
    }

    res.setHeader('Content-Disposition', contentDisposition(safeName));
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = fs.createReadStream(sourcePath);
    stream.on('error', (err) => {
        if (!res.headersSent) {
            if (err.code === 'EBUSY') {
                res.status(409).json({ error: 'File is currently in use.' });
            } else {
                res.status(500).json({ error: 'Failed to download file.' });
            }
        }
    });
    stream.pipe(res);
});

// GET /servers/:id/plugins/download-all — Download all plugins/mods as ZIP (binary)
router.get('/servers/:id/plugins/download-all', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) return res.status(400).json({ error: 'Not supported.' });

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);

    if (!fs.existsSync(contentDir) || !fs.statSync(contentDir).isDirectory()) {
        return res.status(404).json({ error: `No ${contentType.folder} folder found.` });
    }

    const archiver = require('archiver');
    const safeName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${safeName}_${contentType.folder}.zip`));

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
        log('error', `Archive error for ${server.name} ${contentType.folder}: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Archive failed.' });
    });
    archive.pipe(res);
    archive.directory(contentDir, contentType.folder);
    archive.finalize();
});

module.exports = router;
