const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const contentDisposition = require('content-disposition');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, SERVERS_DIR } = require('../db');
const { log } = require('../utils/log');
const { getContentType } = require('../utils/contentType');
const {
    VALID_ENVS,
    DISABLED_SUFFIX,
    getModEnvMap,
    setModEnv,
    clearModEnv,
    clearAllModEnv,
    listModFiles
} = require('../utils/modEnvironment');

/**
 * Load server with live state from ServerManager.
 */
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

// Multer config — temp directory, .jar only, 500 MB limit
const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.jar')) {
            cb(null, true);
        } else {
            cb(new Error('Only .jar files are allowed.'));
        }
    }
});

/**
 * Clean up multer temp files on error.
 */
function cleanupTempFiles(files) {
    if (!files) return;
    for (const file of files) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
}

// ── GET /servers/:id/plugins — Plugins/Mods management page ──

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

    // Ensure the directory exists
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

// ── POST /servers/:id/plugins/upload — Upload JAR file(s) ──

router.post('/servers/:id/plugins/upload', ensureAuth, function (req, res, next) {
    // Run multer manually to catch MulterErrors and return JSON
    upload.any()(req, res, function (err) {
        if (err) {
            return res.status(400).json({ error: err.message || 'Upload failed.' });
        }
        next();
    });
}, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        cleanupTempFiles(req.files);
        return res.status(404).json({ error: 'Server not found.' });
    }

    const contentType = getContentType(server.serverType);
    if (!contentType) {
        cleanupTempFiles(req.files);
        return res.status(400).json({ error: 'This server type does not support plugins or mods.' });
    }

    // Must be stopped or crashed to modify
    if (!['stopped', 'crashed'].includes(server.state)) {
        cleanupTempFiles(req.files);
        return res.status(400).json({ error: `Stop the server before uploading ${contentType.label.toLowerCase()}.` });
    }

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
    }

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);
    fs.mkdirSync(contentDir, { recursive: true });

    const uploaded = [];
    try {
        for (const file of req.files) {
            // Sanitize filename — strip path separators, keep only basename
            const safeName = path.basename(file.originalname).replace(/[/\\]/g, '');
            if (!safeName.toLowerCase().endsWith('.jar')) continue;

            const destPath = path.join(contentDir, safeName);

            // Security: ensure destination stays within content directory
            if (!path.resolve(destPath).startsWith(path.resolve(contentDir))) {
                continue;
            }

            fs.copyFileSync(file.path, destPath);
            uploaded.push(safeName);
        }
    } finally {
        cleanupTempFiles(req.files);
    }

    log('info', `Uploaded ${uploaded.length} ${contentType.label.toLowerCase()} to server ${server.name} (${server.id}): ${uploaded.join(', ')}`);
    res.json({ success: true, count: uploaded.length, files: uploaded });
});

// ── POST /servers/:id/plugins/delete — Delete a plugin/mod JAR ──

router.post('/servers/:id/plugins/delete', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).json({ error: 'Server not found.' });
    }

    const contentType = getContentType(server.serverType);
    if (!contentType) {
        return res.status(400).json({ error: 'This server type does not support plugins or mods.' });
    }

    // Must be stopped or crashed to modify
    if (!['stopped', 'crashed'].includes(server.state)) {
        return res.status(400).json({ error: `Stop the server before deleting ${contentType.label.toLowerCase()}.` });
    }

    const { filename } = req.body;
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'No filename specified.' });
    }

    // Security: strip path separators from filename
    const safeName = path.basename(filename);
    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);
    const targetPath = path.resolve(contentDir, safeName);

    // Prevent directory traversal
    if (!targetPath.startsWith(path.resolve(contentDir))) {
        return res.status(403).json({ error: 'Access denied.' });
    }

    const disabledPath = targetPath + DISABLED_SUFFIX;
    const existingPath = fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()
        ? targetPath
        : (fs.existsSync(disabledPath) && !fs.statSync(disabledPath).isDirectory() ? disabledPath : null);

    if (!existingPath) {
        return res.status(404).json({ error: 'File not found.' });
    }

    try {
        fs.unlinkSync(existingPath);
        if (contentType.label === 'Mods') {
            await clearModEnv(server.id, safeName);
        }
        log('info', `Deleted ${contentType.label.toLowerCase().slice(0, -1)} "${safeName}" from server ${server.name} (${server.id})`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to delete ${safeName}: ${err.message}`);
        res.status(500).json({ error: 'Failed to delete file.' });
    }
});

// ── POST /servers/:id/plugins/delete-all — Delete all plugins/mods ──

router.post('/servers/:id/plugins/delete-all', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).json({ error: 'Server not found.' });
    }

    const contentType = getContentType(server.serverType);
    if (!contentType) {
        return res.status(400).json({ error: 'This server type does not support plugins or mods.' });
    }

    if (!['stopped', 'crashed'].includes(server.state)) {
        return res.status(400).json({ error: `Stop the server before deleting ${contentType.label.toLowerCase()}.` });
    }

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);

    if (!fs.existsSync(contentDir)) {
        return res.json({ success: true, count: 0 });
    }

    let deleted = 0;
    try {
        const entries = fs.readdirSync(contentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) continue;
            const lower = entry.name.toLowerCase();
            if (lower.endsWith('.jar') || lower.endsWith('.jar' + DISABLED_SUFFIX)) {
                fs.unlinkSync(path.join(contentDir, entry.name));
                deleted++;
            }
        }
    } catch (err) {
        log('error', `Failed to delete all ${contentType.label.toLowerCase()}: ${err.message}`);
        return res.status(500).json({ error: 'Failed to delete some files.' });
    }

    if (contentType.label === 'Mods') {
        await clearAllModEnv(server.id);
    }

    log('info', `Deleted all ${deleted} ${contentType.label.toLowerCase()} from server ${server.name} (${server.id})`);
    res.json({ success: true, count: deleted });
});

// ── GET /servers/:id/plugins/download — Download a single plugin/mod JAR ──

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

    if (!targetPath.startsWith(path.resolve(contentDir))) {
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

// ── GET /servers/:id/plugins/download-all — Download all plugins/mods as ZIP ──

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

// ── POST /servers/:id/plugins/environment — Set a mod's environment tag ──

router.post('/servers/:id/plugins/environment', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).json({ error: 'Server not found.' });
    }

    const contentType = getContentType(server.serverType);
    if (!contentType || contentType.label !== 'Mods') {
        return res.status(400).json({ error: 'This server type does not support mod environments.' });
    }

    if (!['stopped', 'crashed'].includes(server.state)) {
        return res.status(400).json({ error: 'Stop the server before changing mod environments.' });
    }

    const { filename, environment } = req.body || {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'No filename specified.' });
    }
    if (!VALID_ENVS.includes(environment)) {
        return res.status(400).json({ error: 'Invalid environment value.' });
    }

    const safeName = path.basename(filename);
    if (!safeName.toLowerCase().endsWith('.jar')) {
        return res.status(400).json({ error: 'Invalid filename.' });
    }

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const contentDir = path.join(serverDir, contentType.folder);

    const enabledPath = path.resolve(contentDir, safeName);
    if (!enabledPath.startsWith(path.resolve(contentDir))) {
        return res.status(403).json({ error: 'Access denied.' });
    }
    const disabledPath = enabledPath + DISABLED_SUFFIX;
    if (!fs.existsSync(enabledPath) && !fs.existsSync(disabledPath)) {
        return res.status(404).json({ error: 'File not found.' });
    }

    try {
        await setModEnv(server.id, safeName, environment, contentDir);
        log('info', `Set mod "${safeName}" environment to ${environment} on server ${server.name} (${server.id})`);
        res.json({ success: true });
    } catch (err) {
        log('error', `Failed to set mod environment for ${safeName}: ${err.message}`);
        res.status(500).json({ error: 'Failed to update environment.' });
    }
});

module.exports = router;
