const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { DownloadReporter, sendFileDownload, sendArchiveDownload } = require('../utils/download');
const ensureAuth = require('../middleware/ensureAuth');
const blockWhileProvisioning = require('../middleware/blockWhileProvisioning');
const { isEditableFile, listDirectory, MAX_TEXT_BYTES } = require('../utils/fileBrowser');
const { formatSize, getDirectorySize } = require('../utils/resourceStats');
const { serversDb, SERVERS_DIR } = require('../db');
const { parseServerProperties } = require('../mc/serverProperties');
const { PROPERTY_META, GROUPS } = require('../mc/propertyMeta');
const { log } = require('../utils/log');
const { hasIcon } = require('../utils/serverIcon');
const { isPathInside } = require('../utils/pathSafety');
const { getDistinctGroups } = require('../utils/serverGroups');

// GET /servers/create — Server creation form
router.get('/servers/create', ensureAuth, async (req, res) => {
    res.render('servers/create', {
        title: 'Create Server',
        description: 'Set up a new Minecraft server instance.',
        navbar: true,
        user: req.user,
        groupNames: await getDistinctGroups().catch(() => []),
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

// ═══════════════════════════════════════════
// Edit Server Settings (view only — mutations in /api/v1)
// ═══════════════════════════════════════════

router.get('/servers/:id/edit', ensureAuth, blockWhileProvisioning, async (req, res) => {
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
        groupNames: await getDistinctGroups().catch(() => []),
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// ═══════════════════════════════════════════
// Server Properties Editor (view only — mutations in /api/v1)
// ═══════════════════════════════════════════

router.get('/servers/:id/properties', ensureAuth, blockWhileProvisioning, async (req, res) => {
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

async function handleFiles(req, res, subpath) {
    const server = await getServerWithState(req);
    if (!server) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Server not found.'
        });
    }

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, subpath || '');

    if (!isPathInside(serverDir, targetPath)) {
        return res.status(403).render('errors/403', {
            title: 'Forbidden', navbar: true, user: req.user, message: 'Access denied.'
        });
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'Directory not found.'
        });
    }

    const files = listDirectory(targetPath);

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

router.get('/servers/:id/files', ensureAuth, blockWhileProvisioning, (req, res) => handleFiles(req, res, ''));
router.get('/servers/:id/files/*subpath', ensureAuth, blockWhileProvisioning, (req, res) => {
    const sub = Array.isArray(req.params.subpath) ? req.params.subpath.join('/') : req.params.subpath;
    handleFiles(req, res, sub);
});

// Individual file download (binary — stays here, browser-driven)
router.get('/servers/:id/download', ensureAuth, blockWhileProvisioning, async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Not found' });

    const serverManager = req.app.get('serverManager');
    const filePath = req.query.path;
    const reporter = new DownloadReporter({
        req,
        serverManager,
        serverId: server.id,
        label: filePath ? path.basename(String(filePath)) : 'File'
    });
    const reject = (status, error) => {
        reporter.failed(error);
        res.status(status).json({ error });
    };

    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        // The panel starts this in a hidden iframe, so a redirect-and-flash
        // never surfaces; the reporter is what the user actually sees.
        return reject(409, 'Stop the server before downloading files.');
    }

    if (!filePath) return reject(400, 'No path specified');

    const serverDir = path.resolve(SERVERS_DIR, server.id);
    const targetPath = path.resolve(serverDir, filePath);

    if (!isPathInside(serverDir, targetPath)) return reject(403, 'Access denied');
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        return reject(404, 'File not found');
    }

    sendFileDownload(res, targetPath, {
        filename: path.basename(targetPath),
        reporter,
        onError: (err) => {
            if (err.code === 'EBUSY') {
                reject(409, 'File is currently in use by the server. Try again later or stop the server first.');
            } else {
                reject(500, 'Failed to download file.');
            }
        }
    });
});

// Full server directory download as .zip (binary — stays here)
router.get('/servers/:id/download-zip', ensureAuth, blockWhileProvisioning, async (req, res) => {
    const server = await serversDb.get(`server_${req.params.id}`);
    if (!server) return res.status(404).json({ error: 'Not found' });

    const serverManager = req.app.get('serverManager');
    const reporter = new DownloadReporter({
        req, serverManager, serverId: server.id, label: 'Server files'
    });
    const reject = (status, error) => {
        reporter.failed(error);
        res.status(status).json({ error });
    };

    const proc = serverManager?.getProcess(server.id);
    if (proc && !['stopped', 'crashed'].includes(proc.state)) {
        return reject(409, 'Stop the server before downloading.');
    }

    const serverDir = path.join(SERVERS_DIR, server.id);
    if (!fs.existsSync(serverDir)) return reject(404, 'Directory not found');

    const safeName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    try {
        await sendArchiveDownload(req, res, {
            filename: `${safeName}.zip`,
            estimatedBytes: getDirectorySize(serverDir),
            reporter,
            describe: `Files download of "${server.name}" (${server.id})`,
            build: (archive) => archive.directory(serverDir, false)
        });
    } catch (err) {
        log('error', `Archive error for ${server.name}: ${err.message}`);
        reporter.failed(err.message);
        if (!res.headersSent) {
            res.status(err.status || 500).json({ error: err.status === 507 ? err.message : 'Archive failed' });
        }
    }
});

router.get('/servers/:id/edit-file', ensureAuth, blockWhileProvisioning, async (req, res) => {
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

    if (!isPathInside(serverDir, targetPath)) {
        return res.status(403).render('errors/403', {
            title: 'Forbidden', navbar: true, user: req.user, message: 'Access denied.'
        });
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        return res.status(404).render('errors/404', {
            title: '404', navbar: true, user: req.user, message: 'File not found.'
        });
    }

    if (!isEditableFile(targetPath)) {
        return res.status(400).render('errors/404', {
            title: 'Not Editable', navbar: true, user: req.user, message: 'This file is not text and cannot be edited.'
        });
    }

    // The editor posts back the whole textarea, so it must never open a partial
    // file — saving one would truncate the rest away. Oversized files are
    // refused here and read in windows through the API instead.
    const size = fs.statSync(targetPath).size;
    if (size > MAX_TEXT_BYTES) {
        return res.status(413).render('errors/404', {
            title: 'Too Large',
            navbar: true,
            user: req.user,
            message: `This file is ${formatSize(size)}, over the ${formatSize(MAX_TEXT_BYTES)} editor limit. Download it to read the whole thing.`
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
