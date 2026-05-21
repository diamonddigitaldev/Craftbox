const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const router = express.Router();
const { serversDb, SERVERS_DIR } = require('../../db');
const { log } = require('../../utils/log');
const { getContentType } = require('../../utils/contentType');
const {
    VALID_ENVS,
    DISABLED_SUFFIX,
    setModEnv,
    clearModEnv,
    clearAllModEnv
} = require('../../utils/modEnvironment');
const { isPathInside } = require('../../utils/pathSafety');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getServerWithState(req) {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return null;
    const server = await serversDb.get(`server_${id}`);
    if (!server) return null;
    const serverManager = req.app.get('serverManager');
    if (serverManager) {
        const proc = serverManager.getProcess(id);
        if (proc) server.state = proc.state;
    }
    return server;
}

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

function cleanupTempFiles(files) {
    if (!files) return;
    for (const file of files) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
}

// JARs are ZIP archives; every valid one starts with one of these 4-byte
// magic numbers. Filename suffix alone is not enough — multer accepts
// anything the client labels `.jar`.
function isZipFile(filepath) {
    let fd;
    try {
        fd = fs.openSync(filepath, 'r');
        const buf = Buffer.alloc(4);
        const n = fs.readSync(fd, buf, 0, 4, 0);
        if (n < 4) return false;
        if (buf[0] !== 0x50 || buf[1] !== 0x4B) return false;
        return (buf[2] === 0x03 && buf[3] === 0x04)
            || (buf[2] === 0x05 && buf[3] === 0x06)
            || (buf[2] === 0x07 && buf[3] === 0x08);
    } catch {
        return false;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
}

// POST /servers/:id/plugins/upload — Upload JAR file(s)
router.post('/servers/:id/plugins/upload', function (req, res, next) {
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
    const rejected = [];
    try {
        for (const file of req.files) {
            const safeName = path.basename(file.originalname).replace(/[/\\]/g, '');
            if (!safeName.toLowerCase().endsWith('.jar')) {
                rejected.push({ name: file.originalname, reason: 'not a .jar file' });
                continue;
            }

            const destPath = path.join(contentDir, safeName);
            if (!isPathInside(contentDir, destPath)) {
                rejected.push({ name: safeName, reason: 'invalid path' });
                continue;
            }

            if (!isZipFile(file.path)) {
                rejected.push({ name: safeName, reason: 'not a valid JAR file' });
                continue;
            }

            fs.copyFileSync(file.path, destPath);
            uploaded.push(safeName);
        }
    } finally {
        cleanupTempFiles(req.files);
    }

    if (uploaded.length > 0) {
        log('info', `Uploaded ${uploaded.length} ${contentType.label.toLowerCase()} to server ${server.name} (${server.id}): ${uploaded.join(', ')}`);
    }
    if (rejected.length > 0) {
        log('warn', `Rejected ${rejected.length} upload(s) to server ${server.name} (${server.id}): ${rejected.map(r => `${r.name} (${r.reason})`).join(', ')}`);
    }
    res.json({ success: true, count: uploaded.length, uploaded, rejected });
});

// POST /servers/:id/plugins/delete — Delete a single plugin/mod
router.post('/servers/:id/plugins/delete', async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) return res.status(400).json({ error: 'This server type does not support plugins or mods.' });

    if (!['stopped', 'crashed'].includes(server.state)) {
        return res.status(400).json({ error: `Stop the server before deleting ${contentType.label.toLowerCase()}.` });
    }

    const { filename } = req.body;
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

// POST /servers/:id/plugins/delete-all — Delete all plugins/mods
router.post('/servers/:id/plugins/delete-all', async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    const contentType = getContentType(server.serverType);
    if (!contentType) return res.status(400).json({ error: 'This server type does not support plugins or mods.' });

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

// POST /servers/:id/plugins/environment — Set a mod's environment tag
router.post('/servers/:id/plugins/environment', async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

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
    if (!isPathInside(contentDir, enabledPath)) {
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
