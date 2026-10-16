// A server's mods and plugins as Modrinth sees them: which of the jars in its
// content folder are Modrinth files, which have a newer version for the
// server's loader and Minecraft version, and installing or updating them.
// Shared by the Modrinth routes and the jar upgrade, which can update a
// server's mods for the version it has just moved to.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const modrinth = require('./modrinth');
const { SERVERS_DIR } = require('../db');
const { getContentType } = require('../utils/contentType');
const { isPathInside } = require('../utils/pathSafety');
const { isZipFile } = require('../utils/uploadSafety');
const { DISABLED_SUFFIX, listModFiles, renameModEnv } = require('../utils/modEnvironment');
const { downloadToFile } = require('../utils/httpDownload');
const { log } = require('../utils/log');

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

const MAX_JAR_BYTES = 2 * 1024 * 1024 * 1024;
const UPDATE_CONCURRENCY = 4;

// Per-file digest memo — hashing a large modpack's mods folder every time the
// page asks would be wasteful. Keyed by path+size+mtime so an edited or
// replaced jar re-hashes.
const jarHashCache = new Map();
const JAR_HASH_CACHE_MAX = 5000;

function sha512File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha512');
        fs.createReadStream(filePath)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

async function hashJarCached(filePath) {
    const stat = await fs.promises.stat(filePath);
    const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
    if (jarHashCache.has(key)) return jarHashCache.get(key);
    const digest = await sha512File(filePath);
    if (jarHashCache.size >= JAR_HASH_CACHE_MAX) jarHashCache.clear();
    jarHashCache.set(key, digest);
    return digest;
}

function contentDirFor(server) {
    const contentType = getContentType(server.serverType);
    return contentType ? path.join(SERVERS_DIR, server.id, contentType.folder) : null;
}

// The filters a version must match to run on this server. A server records
// the concrete version it runs; 'latest' is only ever a request value, so it
// means no Minecraft filter rather than a guess.
function compatibilityFor(server) {
    return {
        loaders: loaderGroupFor(server.serverType),
        gameVersions: server.version && server.version !== 'latest' ? [server.version] : undefined
    };
}

function primaryJar(version) {
    const file = (version.files || []).find(f => f.primary) || (version.files || [])[0];
    return file && /\.jar$/i.test(file.filename || '') ? file : null;
}

function isCompatible(version, { loaders, gameVersions }) {
    return (!loaders || (version.loaders || []).some(l => loaders.includes(l)))
        && (!gameVersions || (version.game_versions || []).some(g => gameVersions.includes(g)));
}

// The listed files of the server's content folder, keyed by SHA-512
async function hashContent(server) {
    const byHash = new Map();
    const contentDir = contentDirFor(server);
    if (!contentDir) return byHash;
    for (const file of listModFiles(contentDir)) {
        try {
            byHash.set(await hashJarCached(path.join(contentDir, file.onDiskName)), file);
        } catch { /* unreadable file — skip it */ }
    }
    return byHash;
}

/**
 * The ids of the Modrinth projects already in the server's content folder,
 * whichever versions they are.
 */
async function installedProjectIds(server) {
    const hashes = [...(await hashContent(server)).keys()];
    const current = hashes.length ? await modrinth.getVersionsByHashes(hashes, 'sha512') : {};
    return new Set(Object.values(current || {}).map(v => v && v.project_id).filter(Boolean));
}

/**
 * The server's content folder matched against Modrinth by file hash, the way
 * launchers do it. Locally built or modified jars simply don't match. One row
 * per listed mod (a jar and its `.disabled` twin are one), for the ones
 * Modrinth knows:
 *   { filename, onDiskName, disabled, hash, projectId, version, latest, updateAvailable }
 * `version` is the installed Modrinth version, `latest` the newest version of
 * the same project for the server's loader and Minecraft version, or null
 * when there is none. Disabled jars count: a modpack's client-only mods land
 * disabled and still want updating.
 */
async function scanInstalled(server) {
    const byHash = await hashContent(server);
    if (byHash.size === 0) return [];
    const hashes = [...byHash.keys()];
    const compat = compatibilityFor(server);
    const [current, latest] = await Promise.all([
        modrinth.getVersionsByHashes(hashes, 'sha512'),
        modrinth.getLatestVersionsByHashes(hashes, 'sha512', compat)
    ]);

    const rows = [];
    for (const [hash, file] of byHash) {
        const version = current && current[hash];
        if (!version || !version.project_id) continue;
        let newest = (latest && latest[hash]) || null;
        if (newest && newest.project_id !== version.project_id) newest = null;
        // Newest for this server, so it is the update unless it is the file
        // already installed — or an older release than one that already runs
        // here, which only a hand-placed beta could be.
        const updateAvailable = !!newest && newest.id !== version.id && !!primaryJar(newest)
            && !(isCompatible(version, compat)
                && Date.parse(version.date_published) >= Date.parse(newest.date_published));
        rows.push({
            filename: file.displayName,
            onDiskName: file.onDiskName,
            disabled: file.isDisabled,
            hash,
            projectId: version.project_id,
            version,
            latest: newest,
            updateAvailable
        });
    }
    return rows.sort((a, b) => a.filename.localeCompare(b.filename));
}

// The public face of a scan row, as the API returns it.
function describeRow(row) {
    const latestFile = row.latest ? primaryJar(row.latest) : null;
    return {
        filename: row.filename,
        projectId: row.projectId,
        versionId: row.version.id,
        versionNumber: row.version.version_number,
        latest: row.latest ? {
            versionId: row.latest.id,
            versionNumber: row.latest.version_number,
            filename: latestFile ? path.basename(latestFile.filename) : null
        } : null,
        updateAvailable: row.updateAvailable
    };
}

/**
 * Install a project from Modrinth, and its required dependencies, into the
 * server's content folder. Recursive, cycle-safe, depth-capped. The requested
 * project (depth 0) is strict — incompatibilities are errors carrying an
 * httpStatus. Dependencies degrade gracefully: already-installed or
 * version-less ones are skipped with a log line.
 * @param {object} ctx - { server, installed: [], seenProjects: Set } —
 *   seenProjects starts with the projects already on the server (see
 *   installedProjectIds), so a dependency present in another version, under
 *   another file name, isn't installed a second time beside it.
 */
async function installProject(ctx, pid, wantedVersionId, depth) {
    const { server, installed, seenProjects } = ctx;
    if (depth > 5 || (depth > 0 && seenProjects.has(pid))) return;
    seenProjects.add(pid);

    const contentDir = contentDirFor(server);
    const versions = await modrinth.getProjectVersions(pid, compatibilityFor(server));
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

    const file = primaryJar(version);
    if (!file) {
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
    // A disabled twin is still an install — re-downloading it would leave two
    // copies of the same mod, and reconcile would delete the enabled one on
    // the next start anyway (client-only mods from a modpack are disabled).
    if (fs.existsSync(dest) || fs.existsSync(dest + DISABLED_SUFFIX)) {
        if (depth === 0) {
            const e = new Error(`"${filename}" is already installed.`);
            e.httpStatus = 409;
            throw e;
        }
        return; // dependency already present
    }

    await downloadToFile(file.url, dest, {
        maxBytes: MAX_JAR_BYTES,
        sha512: file.hashes?.sha512 || null,
        enforceWhitelist: true
    });
    if (!isZipFile(dest)) {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        throw new Error(`"${filename}" is not a valid jar file.`);
    }
    // The project's id, whether it was asked for by id or by slug
    installed.push({ filename, versionNumber: version.version_number, projectId: version.project_id || pid });

    for (const dep of version.dependencies || []) {
        if (dep.dependency_type === 'required' && dep.project_id) {
            await installProject(ctx, dep.project_id, dep.version_id || null, depth + 1);
        }
    }
}

// Swap one scanned file for its project's newest version. The new jar is
// downloaded beside the old one and verified before the old one goes, so a
// failed download leaves the mod as it was. A disabled (client-only) mod
// stays disabled, and its environment tag follows it to the new file name.
async function replaceWithLatest(server, contentDir, row) {
    const file = primaryJar(row.latest);
    const newName = path.basename(file.filename);
    const dest = path.join(contentDir, newName);
    if (!isPathInside(contentDir, dest)) throw new Error('Invalid file name.');

    const temp = path.join(contentDir, `.craftbox-update-${crypto.randomUUID()}.tmp`);
    try {
        await downloadToFile(file.url, temp, {
            maxBytes: MAX_JAR_BYTES,
            sha512: file.hashes?.sha512 || null,
            enforceWhitelist: true
        });
        if (!isZipFile(temp)) throw new Error(`"${newName}" is not a valid jar file.`);

        const oldPath = path.join(contentDir, row.filename);
        for (const p of [oldPath, oldPath + DISABLED_SUFFIX]) {
            try { fs.unlinkSync(p); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
        // The new name can already be on disk as a stray copy of the same
        // mod; the update replaces that too, in either form.
        for (const p of [dest, dest + DISABLED_SUFFIX]) {
            try { fs.unlinkSync(p); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
        fs.renameSync(temp, row.disabled ? dest + DISABLED_SUFFIX : dest);
    } finally {
        try { fs.unlinkSync(temp); } catch { /* moved into place, or never written */ }
    }
    await renameModEnv(server.id, row.filename, newName);
    return newName;
}

// One update at a time per server: two would race on the same files.
const busyServers = new Set();

/**
 * Update the server's Modrinth mods or plugins to the newest version each has
 * for its loader and Minecraft version, installing any new required
 * dependency. `filenames` limits it to those listed files (as GET /plugins
 * names them); omitted, everything with an update is updated.
 *
 * Returns { updated: [{filename, newFilename, projectId, fromVersion, toVersion}],
 *           installed: [{filename, versionNumber, projectId}],
 *           skipped: [{filename, reason}] }
 * `skipped` names each requested file that wasn't updated: not a Modrinth
 * file, already up to date, no version for this server, or a failed download.
 * Throws an error with httpStatus 409 when an update is already running.
 */
async function updateContent(server, { filenames } = {}) {
    const contentDir = contentDirFor(server);
    if (!contentDir) {
        const e = new Error('This server type does not support plugins or mods.');
        e.httpStatus = 400;
        throw e;
    }
    if (busyServers.has(server.id)) {
        const e = new Error('An update is already running for this server.');
        e.httpStatus = 409;
        throw e;
    }
    busyServers.add(server.id);
    try {
        const rows = await scanInstalled(server);
        const byName = new Map(rows.map(r => [r.filename, r]));
        const skipped = [];
        let targets;
        if (Array.isArray(filenames)) {
            targets = [];
            for (const name of new Set(filenames)) {
                const row = byName.get(name);
                if (!row) skipped.push({ filename: name, reason: 'not-on-modrinth' });
                else if (!row.latest) skipped.push({ filename: name, reason: 'no-compatible-version' });
                else if (!row.updateAvailable) skipped.push({ filename: name, reason: 'up-to-date' });
                else targets.push(row);
            }
        } else {
            targets = rows.filter(r => r.updateAvailable);
            for (const r of rows) {
                if (!r.latest) skipped.push({ filename: r.filename, reason: 'no-compatible-version' });
            }
        }

        const updated = [];
        const queue = targets.slice();
        async function worker() {
            for (let row = queue.shift(); row; row = queue.shift()) {
                try {
                    const newFilename = await replaceWithLatest(server, contentDir, row);
                    updated.push({
                        filename: row.filename,
                        newFilename,
                        projectId: row.projectId,
                        fromVersion: row.version.version_number,
                        toVersion: row.latest.version_number
                    });
                } catch (err) {
                    log('warn', `Modrinth update of "${row.filename}" on ${server.id} failed: ${err.message}`);
                    skipped.push({ filename: row.filename, reason: 'failed', error: err.message });
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(UPDATE_CONCURRENCY, queue.length) }, worker));

        // A newer version can need a library the old one didn't. Projects
        // already on the server count as present whatever their version.
        const installed = [];
        const ctx = { server, installed, seenProjects: new Set(rows.map(r => r.projectId)) };
        for (const row of targets) {
            if (!updated.some(u => u.projectId === row.projectId)) continue;
            for (const dep of row.latest.dependencies || []) {
                if (dep.dependency_type !== 'required' || !dep.project_id) continue;
                try {
                    await installProject(ctx, dep.project_id, dep.version_id || null, 1);
                } catch (err) {
                    log('warn', `Modrinth update on ${server.id}: dependency ${dep.project_id} failed: ${err.message}`);
                }
            }
        }

        const byFilename = (a, b) => a.filename.localeCompare(b.filename);
        return { updated: updated.sort(byFilename), installed, skipped: skipped.sort(byFilename) };
    } finally {
        busyServers.delete(server.id);
    }
}

module.exports = {
    LOADER_GROUPS,
    loaderGroupFor,
    scanInstalled,
    installedProjectIds,
    describeRow,
    installProject,
    updateContent
};
