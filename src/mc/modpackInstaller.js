// Modrinth modpack (.mrpack) install pipeline.
//
// A .mrpack is a zip holding modrinth.index.json (a list of files to download
// with hashes + the loader/MC versions to install) plus overrides/ and
// server-overrides/ directories layered onto the server directory. This module
// owns parsing, validation, and the multi-phase install; the API route owns
// the DB record, state transitions, and WebSocket broadcasts around it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const StreamZip = require('node-stream-zip');
const { downloadServerJar } = require('./downloader');
const { writeServerProperties, writeEula } = require('./serverProperties');
const { downloadToFile, assertWhitelistedUrl } = require('../utils/httpDownload');
const { setServerIcon } = require('../utils/serverIcon');
const { DISABLED_SUFFIX } = require('../utils/modEnvironment');
const { SERVERS_DIR } = require('../db');
const { log } = require('../utils/log');

const MAX_MRPACK_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const MAX_PACK_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const FILE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_CONCURRENCY = 4;
const DISK_HEADROOM_BYTES = 512 * 1024 * 1024;

// Only jars directly in mods/ take part in the mod environment map (it is keyed
// by the filename listModFiles() reports for that folder).
const MOD_JAR_RE = /^mods\/[^/]+\.jar$/i;

// Loader dependency keys in install-preference order. quilt-loader is known
// but unsupported — detected separately for a clearer error.
const LOADER_PRECEDENCE = [
    { key: 'fabric-loader', serverType: 'fabric' },
    { key: 'forge', serverType: 'forge' },
    { key: 'neoforge', serverType: 'neoforge' }
];

/**
 * Open a .mrpack and validate its manifest. On success the caller owns the
 * returned zip handle and must close it; on failure it is closed here.
 * @returns {Promise<{zip, manifest, entries}>}
 */
async function parseMrpack(zipPath) {
    const zip = new StreamZip.async({ file: zipPath });
    try {
        let entries;
        try {
            entries = await zip.entries();
        } catch {
            throw new Error('Failed to read the modpack archive.');
        }
        if (!entries['modrinth.index.json']) {
            throw new Error('Not a Modrinth modpack — modrinth.index.json is missing.');
        }
        let manifest;
        try {
            manifest = JSON.parse((await zip.entryData('modrinth.index.json')).toString('utf8'));
        } catch {
            throw new Error('Modpack manifest is corrupted.');
        }
        if (manifest.formatVersion !== 1) {
            throw new Error('This modpack uses an unsupported format version.');
        }
        if (manifest.game && manifest.game !== 'minecraft') {
            throw new Error('This modpack is not for Minecraft.');
        }
        if (!Array.isArray(manifest.files)) manifest.files = [];
        return { zip, manifest, entries };
    } catch (err) {
        try { await zip.close(); } catch { /* ignore */ }
        throw err;
    }
}

/**
 * Map a manifest dependencies object to a Craftbox server type + pinned
 * loader version. Throws for Quilt-only or loaderless packs.
 * @returns {{serverType: string, mcVersion: string, loaderBuild: string|null}}
 */
function resolveLoader(dependencies) {
    const deps = dependencies || {};
    const mcVersion = String(deps.minecraft || '').trim();
    if (!mcVersion) throw new Error('Modpack does not declare a Minecraft version.');

    for (const { key, serverType } of LOADER_PRECEDENCE) {
        if (deps[key]) {
            return { serverType, mcVersion, loaderBuild: String(deps[key]).trim() || null };
        }
    }
    if (deps['quilt-loader']) {
        throw new Error('Quilt modpacks are not supported by Craftbox.');
    }
    throw new Error('Modpack does not declare a supported server loader (Fabric, Forge, or NeoForge).');
}

/**
 * Map a Modrinth version's loaders array to a Craftbox server type, or null.
 * Used to pre-fill serverType before the .mrpack itself has been parsed.
 */
function pickLoaderFromArray(loaders) {
    const list = Array.isArray(loaders) ? loaders : [];
    for (const { key, serverType } of LOADER_PRECEDENCE) {
        // Version loaders use bare names: 'fabric', 'forge', 'neoforge'
        if (list.includes(serverType) || list.includes(key)) return serverType;
    }
    return null;
}

/**
 * Resolve a manifest-relative path inside the server dir, rejecting absolute
 * paths, drive letters, and .. traversal (belt and braces like import).
 */
function sanitizeEntryPath(serverDir, relPath) {
    const rel = String(relPath || '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
        throw new Error(`Modpack contains an unsafe file path: ${relPath}`);
    }
    const resolvedDir = path.resolve(serverDir);
    const target = path.resolve(serverDir, rel);
    if (target === resolvedDir || !target.startsWith(resolvedDir + path.sep)) {
        throw new Error(`Modpack contains an unsafe file path: ${relPath}`);
    }
    return target;
}

// Small worker pool — stops picking up new items once any worker throws.
async function runPool(items, concurrency, worker) {
    let next = 0;
    let failed = false;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (!failed) {
            const i = next++;
            if (i >= items.length) return;
            try {
                await worker(items[i]);
            } catch (err) {
                failed = true;
                throw err;
            }
        }
    });
    await Promise.all(runners);
}

/**
 * Run the full modpack install into an existing (empty) server directory.
 * Phases: download → parse → loader → files → overrides → finalize, reported
 * through onProgress(phase, done?, total?). Throws on any failure — the
 * caller handles CRASHED state + broadcasts. Never deletes the server dir.
 *
 * @param {object} opts
 * @param {string} opts.serverId
 * @param {string} opts.serverDir - Absolute path
 * @param {object} opts.mrpack - { url, sha512 } (fetch it) or { localPath } (already on disk)
 * @param {object} opts.baseConfig - { port, gamemode, difficulty, seed } for server.properties
 * @param {string|null} [opts.iconUrl] - Modrinth CDN icon to use as the server icon (non-fatal)
 * @param {function} [opts.onProgress] - (phase, done, total)
 * @returns {Promise<{serverType, mcVersion, loaderBuild, build, filesInstalled, modsInstalled, clientOnlyMods, manifestName, manifestVersionId, warnings}>}
 *   filesInstalled counts manifest downloads plus override files; modsInstalled
 *   counts every jar landing in mods/ from either source, client-only ones
 *   included — it is what the mods page will list, and what the 'files' progress
 *   phase counts towards. clientOnlyMods holds the filenames written pre-disabled;
 *   the caller persists them to the mod environment map.
 */
async function installModpack({ serverId, serverDir, mrpack, baseConfig, iconUrl, onProgress }) {
    const emit = onProgress || (() => {});
    const warnings = [];
    let zip = null;
    let tmpMrpack = null;
    const ownsTmp = !!mrpack.url;

    try {
        // ── Phase 1: download the .mrpack (skipped for local uploads) ──
        if (mrpack.url) {
            emit('download');
            tmpMrpack = path.join(os.tmpdir(), `craftbox-mrpack-${serverId}`);
            await downloadToFile(mrpack.url, tmpMrpack, {
                maxBytes: MAX_MRPACK_BYTES,
                sha512: mrpack.sha512 || null,
                enforceWhitelist: true,
                timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS
            });
        } else {
            tmpMrpack = mrpack.localPath;
        }

        // ── Phase 2: parse + validate the manifest and build the file list ──
        emit('parse');
        const parsed = await parseMrpack(tmpMrpack);
        zip = parsed.zip;
        const { manifest, entries } = parsed;
        const { serverType, mcVersion, loaderBuild } = resolveLoader(manifest.dependencies);

        const files = [];
        const seenPaths = new Set();
        const clientOnlyMods = [];
        // Every jar that ends up in mods/, from the manifest or from an override.
        // Keyed by filename so an override replacing a manifest mod counts once.
        const modJars = new Set();
        let totalBytes = 0;
        for (const f of manifest.files) {
            const rel = String(f?.path || '').replace(/\\/g, '/');
            const relKey = rel.toLowerCase(); // Windows filesystems are case-insensitive
            if (seenPaths.has(relKey)) {
                warnings.push(`Duplicate file path in modpack skipped: ${rel}`);
                log('warn', `Modpack install ${serverId}: duplicate path skipped: ${rel}`);
                continue;
            }
            seenPaths.add(relKey);
            let dest = sanitizeEntryPath(serverDir, rel);
            if (MOD_JAR_RE.test(rel)) {
                modJars.add(path.basename(rel).toLowerCase());
                // Client-only mods are still installed, but land pre-disabled and
                // tagged 'client' so the loader ignores them while players can pull
                // them from the status page's mods download.
                if (f?.env?.server === 'unsupported') {
                    clientOnlyMods.push(path.basename(rel));
                    dest += DISABLED_SUFFIX;
                }
            }
            const url = (f.downloads || []).find((u) => {
                try { assertWhitelistedUrl(u); return true; } catch { return false; }
            });
            if (!url) throw new Error(`No allowed download source for modpack file: ${rel}`);
            const sha512 = f?.hashes?.sha512 || null;
            const sha1 = f?.hashes?.sha1 || null;
            if (!sha512 && !sha1) throw new Error(`Modpack file has no checksum: ${rel}`);
            totalBytes += Number(f.fileSize) || 0;
            files.push({ rel, dest, url, sha512, sha1 });
        }
        const overrideEntries = Object.values(entries).filter((e) => {
            const name = String(e.name).replace(/\\/g, '/');
            return name.startsWith('overrides/') || name.startsWith('server-overrides/');
        });
        if (files.length === 0 && overrideEntries.length === 0) {
            throw new Error('This modpack contains no files to install.');
        }
        if (clientOnlyMods.length > 0) {
            log('info', `Modpack install ${serverId}: installing ${clientOnlyMods.length} client-only mod(s) disabled.`);
        }

        // Progress counts mods, not raw files: mods are what a pack is measured
        // in and what the mods page shows afterwards, while the manifest's file
        // list also carries resource packs and shaders. Override jars belong in
        // the total — packs routinely ship mods there as well as in the manifest
        // — and a manifest mod that an override replaces is one mod, not two.
        for (const entry of overrideEntries) {
            if (entry.isDirectory) continue;
            const rel = String(entry.name).replace(/\\/g, '/').replace(/^(server-)?overrides\//, '');
            if (MOD_JAR_RE.test(rel)) modJars.add(path.basename(rel).toLowerCase());
        }
        const totalMods = modJars.size;
        const installedMods = new Set();
        const trackMod = (rel) => {
            if (!MOD_JAR_RE.test(rel)) return;
            installedMods.add(path.basename(rel).toLowerCase());
            emit('files', installedMods.size, totalMods);
        };

        // Disk preflight (same approach as DGUP init) — fail fast rather than
        // half-installing into a full disk. statfs is unavailable on some
        // filesystems; skip the check rather than fail there.
        try {
            const stat = fs.statfsSync(SERVERS_DIR);
            const free = stat.bavail * stat.bsize;
            const needed = totalBytes * 1.2 + DISK_HEADROOM_BYTES;
            if (free < needed) {
                throw new Error(`Not enough disk space — this modpack needs about ${(needed / 1024 / 1024 / 1024).toFixed(1)} GB free.`);
            }
        } catch (err) {
            if (err.message.startsWith('Not enough disk space')) throw err;
        }

        // ── Phase 3: install the loader server (reuses the existing providers,
        //    including the Forge/NeoForge installer runs) ──
        emit('loader');
        const dl = await downloadServerJar(serverType, mcVersion, loaderBuild, path.join(serverDir, 'server.jar'));
        if (!loaderBuild) {
            warnings.push('The modpack does not pin a loader version; the latest available was installed.');
        }

        // ── Phase 4: download the pack files ──
        emit('files', 0, totalMods);
        await runPool(files, DOWNLOAD_CONCURRENCY, async (file) => {
            let attempt = 0;
            for (;;) {
                try {
                    await downloadToFile(file.url, file.dest, {
                        maxBytes: MAX_PACK_FILE_BYTES,
                        sha512: file.sha512,
                        sha1: file.sha512 ? null : file.sha1,
                        enforceWhitelist: true,
                        timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS
                    });
                    break;
                } catch (err) {
                    if (++attempt > 1) throw err;
                    // One retry; back off harder when the CDN rate-limits us.
                    const backoff = /HTTP 429/.test(err.message) ? 15000 : 1000;
                    log('warn', `Modpack install ${serverId}: retrying ${file.rel} in ${backoff / 1000}s (${err.message})`);
                    await new Promise((r) => setTimeout(r, backoff));
                }
            }
            trackMod(file.rel);
        });

        // ── Phase 5: apply overrides/ then server-overrides/ (later wins;
        //    client-overrides/ is deliberately ignored on a server) ──
        emit('overrides');
        const streamEntryTo = (entryName, target) => new Promise((resolve, reject) => {
            zip.stream(entryName).then((stm) => {
                const out = fs.createWriteStream(target);
                stm.on('error', reject);
                out.on('error', reject);
                out.on('finish', resolve);
                stm.pipe(out);
            }).catch(reject);
        });
        let overridesInstalled = 0;
        for (const prefix of ['overrides/', 'server-overrides/']) {
            for (const entry of Object.values(entries)) {
                const entryName = String(entry.name).replace(/\\/g, '/');
                if (!entryName.startsWith(prefix)) continue;
                const relative = entryName.slice(prefix.length);
                if (!relative) continue;
                const target = sanitizeEntryPath(serverDir, relative);
                if (entry.isDirectory) {
                    await fs.promises.mkdir(target, { recursive: true });
                } else {
                    await fs.promises.mkdir(path.dirname(target), { recursive: true });
                    await streamEntryTo(entry.name, target);
                    overridesInstalled++;
                    trackMod(relative);
                }
            }
        }

        // ── Phase 6: finalize ──
        emit('finalize');
        // After overrides on purpose: Craftbox-managed values (port, gamemode,
        // difficulty, seed) must win over any server.properties the pack ships.
        writeServerProperties(serverDir, {
            serverPort: baseConfig.port,
            gamemode: baseConfig.gamemode,
            difficulty: baseConfig.difficulty,
            levelSeed: baseConfig.seed
        });
        writeEula(serverDir);

        if (iconUrl) {
            // Non-fatal: a broken icon shouldn't fail a finished install.
            const tmpIcon = path.join(os.tmpdir(), `craftbox-mricon-${serverId}`);
            try {
                const parsedUrl = new URL(iconUrl);
                if (parsedUrl.protocol === 'https:' && parsedUrl.hostname === 'cdn.modrinth.com') {
                    await downloadToFile(iconUrl, tmpIcon, { maxBytes: 20 * 1024 * 1024 });
                    await setServerIcon(serverId, tmpIcon);
                }
            } catch (err) {
                log('warn', `Modpack install ${serverId}: could not set the pack icon: ${err.message}`);
            } finally {
                fs.promises.unlink(tmpIcon).catch(() => {});
            }
        }

        return {
            serverType,
            mcVersion,
            loaderBuild,
            build: dl?.build ?? loaderBuild ?? null,
            javaMajor: dl?.javaMajor ?? null,
            filesInstalled: files.length + overridesInstalled,
            modsInstalled: installedMods.size,
            clientOnlyMods,
            manifestName: manifest.name || null,
            manifestVersionId: manifest.versionId || null,
            warnings
        };
    } finally {
        if (zip) { try { await zip.close(); } catch { /* ignore */ } }
        if (ownsTmp && tmpMrpack) fs.promises.unlink(tmpMrpack).catch(() => {});
    }
}

module.exports = { parseMrpack, resolveLoader, pickLoaderFromArray, sanitizeEntryPath, installModpack };
