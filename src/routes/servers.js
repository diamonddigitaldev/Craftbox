const express = require('express');
const fs = require('fs');
const path = require('path');
const contentDisposition = require('content-disposition');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { serversDb, SERVERS_DIR } = require('../db');
const { parseServerProperties } = require('../mc/serverProperties');
const { PROPERTY_META, GROUPS } = require('../mc/propertyMeta');
const { log } = require('../utils/log');
const { hasIcon } = require('../utils/serverIcon');

// GET /servers/create — Server creation form
router.get('/servers/create', ensureAuth, (req, res) => {
    res.render('servers/create', {
        title: 'Create Server',
        description: 'Set up a new Minecraft server instance.',
        navbar: true,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// GET /servers/:id — Server detail page
router.get('/servers/:id', ensureAuth, async (req, res) => {
    const id = req.params.id;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Invalid server ID.'
        });
    }

    const server = await serversDb.get(`server_${id}`);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const serverManager = req.app.get('serverManager');
    if (serverManager) {
        const proc = serverManager.getProcess(id);
        if (proc) {
            server.state = proc.state;
        }
    }

    res.render('servers/view', {
        title: server.name,
        description: `View live logs and resource metrics for ${server.name}.`,
        navbar: true,
        fluid: true,
        user: req.user,
        server,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// ── Helper: load server with live state ──
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

// ── Helper: format file size ──
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
}

// ═══════════════════════════════════════════
// Edit Server Settings (view only — mutations in /api/v1)
// ═══════════════════════════════════════════

router.get('/servers/:id/edit', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const serverDir = path.join(SERVERS_DIR, server.id);
    const props = parseServerProperties(serverDir);
    const currentMotd = props.motd || 'A Minecraft Server';

    res.render('servers/edit', {
        title: server.name + ' Settings',
        description: `Configure basic server and runtime settings for ${server.name}.`,
        server,
        currentMotd,
        hasIcon: hasIcon(server.id),
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// ═══════════════════════════════════════════
// Server Properties Editor (view only — mutations in /api/v1)
// ═══════════════════════════════════════════

router.get('/servers/:id/properties', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const serverDir = path.join(SERVERS_DIR, server.id);
    const properties = parseServerProperties(serverDir);

    res.render('servers/properties', {
        title: server.name + ' Properties',
        description: `Edit server properties for ${server.name}.`,
        server,
        properties,
        propertyMeta: PROPERTY_META,
        groups: GROUPS,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// ═══════════════════════════════════════════
// File Browser & Editor (views + binary downloads — mutations in /api/v1)
// ═══════════════════════════════════════════

const TEXT_EXTENSIONS = new Set([
    '.txt', '.log', '.properties', '.json', '.yml', '.yaml', '.xml',
    '.cfg', '.conf', '.ini', '.toml', '.csv', '.md', '.sh', '.bat',
    '.cmd', '.ps1', '.js', '.ts', '.py', '.java', '.html', '.css',
    '.mcmeta', '.lang', '.sk', '.nbt'
]);

function isTextFile(filename) {
    return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

async function handleFiles(req, res, subpath) {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, subpath || '');

    if (!targetPath.startsWith(serverDir)) {
        return res.status(403).render('errors/403', {
            title: 'Forbidden', navbar: true, user: req.user, message: 'Access denied.'
        });
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Directory not found.'
        });
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files = entries.map(entry => {
        const entryPath = path.join(targetPath, entry.name);
        let stat;
        try { stat = fs.statSync(entryPath); } catch { return null; }
        return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stat.size,
            sizeFormatted: formatSize(stat.size),
            modified: stat.mtime,
            modifiedISO: stat.mtime.toISOString(),
            editable: !entry.isDirectory() && isTextFile(entry.name)
        };
    }).filter(Boolean).sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    const breadcrumbs = subpath ? subpath.split('/').filter(Boolean) : [];
    const parentPath = breadcrumbs.length > 1 ? breadcrumbs.slice(0, -1).join('/') : '';

    res.render('servers/files', {
        title: server.name + ' Files',
        description: `Browse and manage files for ${server.name}.`,
        server,
        files,
        breadcrumbs,
        currentPath: subpath || '',
        parentPath,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
}

router.get('/servers/:id/files', ensureAuth, (req, res) => handleFiles(req, res, ''));
router.get('/servers/:id/files/*subpath', ensureAuth, (req, res) => {
    const sub = Array.isArray(req.params.subpath) ? req.params.subpath.join('/') : req.params.subpath;
    handleFiles(req, res, sub);
});

// Individual file download (binary — stays here, browser-driven)
router.get('/servers/:id/download', ensureAuth, async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Not found' });

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        req.session.flash = { error: 'Stop the server before downloading files.' };
        return res.redirect(`/servers/${server.id}/files`);
    }

    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'No path specified' });

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, filePath);

    if (!targetPath.startsWith(serverDir)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        return res.status(404).json({ error: 'File not found' });
    }

    const fileName = path.basename(targetPath);
    res.setHeader('Content-Disposition', contentDisposition(fileName));
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = fs.createReadStream(targetPath);
    stream.on('error', (err) => {
        if (!res.headersSent) {
            if (err.code === 'EBUSY') {
                res.status(409).json({ error: 'File is currently in use by the server. Try again later or stop the server first.' });
            } else {
                res.status(500).json({ error: 'Failed to download file.' });
            }
        }
    });
    stream.pipe(res);
});

// Full server directory download as .zip (binary — stays here)
router.get('/servers/:id/download-zip', ensureAuth, async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Not found' });

    const serverManager = req.app.get('serverManager');
    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        req.session.flash = { error: 'Stop the server before downloading.' };
        return res.redirect(`/servers/${server.id}/files`);
    }

    const serverDir = path.join(SERVERS_DIR, server.id);
    if (!fs.existsSync(serverDir)) return res.status(404).json({ error: 'Directory not found' });

    const archiver = require('archiver');
    const safeName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${safeName}.zip`));

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
        log('error', `Archive error for ${server.name}: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Archive failed' });
    });
    archive.pipe(res);
    archive.directory(serverDir, false);
    archive.finalize();
});

router.get('/servers/:id/edit-file', ensureAuth, async (req, res) => {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const filePath = req.query.path;
    if (!filePath) return res.redirect(`/servers/${server.id}/files`);

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, filePath);

    if (!targetPath.startsWith(serverDir)) {
        return res.status(403).render('errors/403', {
            title: 'Forbidden', navbar: true, user: req.user, message: 'Access denied.'
        });
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'File not found.'
        });
    }

    if (!isTextFile(path.basename(targetPath))) {
        return res.status(400).render('errors/404', {
            title: 'Not Editable', navbar: true, user: req.user, message: 'This file type cannot be edited.'
        });
    }

    let content;
    try {
        content = fs.readFileSync(targetPath, 'utf8');
    } catch (err) {
        req.session.flash = { error: 'Could not read file: ' + err.message };
        return res.redirect(`/servers/${server.id}/files`);
    }

    const breadcrumbs = filePath.split('/').filter(Boolean);
    const fileName = breadcrumbs[breadcrumbs.length - 1];

    res.render('servers/fileEdit', {
        title: server.name + ' | Edit ' + fileName,
        description: `Edit ${fileName} for ${server.name}.`,
        server,
        filePath,
        fileName,
        content,
        breadcrumbs,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

module.exports = router;
