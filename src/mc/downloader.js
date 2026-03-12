const fs = require('fs');
const path = require('path');
const { log } = require('../utils/log');

const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';

/**
 * Download the vanilla Minecraft server jar for a given version.
 * @param {string} version - MC version string (e.g., "1.21.5")
 * @param {string} destPath - Absolute path to save the jar
 */
async function downloadVanillaJar(version, destPath) {
    log('info', `Fetching version manifest to download Minecraft ${version}...`);

    // Fetch the version manifest
    const manifestRes = await fetch(VERSION_MANIFEST_URL);
    if (!manifestRes.ok) {
        throw new Error(`Failed to fetch version manifest: HTTP ${manifestRes.status}`);
    }
    const manifest = await manifestRes.json();

    // Find the requested version
    const versionEntry = manifest.versions.find(v => v.id === version);
    if (!versionEntry) {
        throw new Error(`Minecraft version "${version}" not found.`);
    }

    // Fetch the version detail to get the server download URL
    log('info', `Fetching version details for ${version}...`);
    const detailRes = await fetch(versionEntry.url);
    if (!detailRes.ok) {
        throw new Error(`Failed to fetch version details: HTTP ${detailRes.status}`);
    }
    const detail = await detailRes.json();

    const serverDownload = detail.downloads?.server;
    if (!serverDownload) {
        throw new Error(`No server download available for version "${version}".`);
    }

    // Download the server jar
    log('info', `Downloading server jar (${(serverDownload.size / 1024 / 1024).toFixed(1)} MB)...`);
    const jarRes = await fetch(serverDownload.url);
    if (!jarRes.ok) {
        throw new Error(`Failed to download server jar: HTTP ${jarRes.status}`);
    }

    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // Stream to file
    const buffer = Buffer.from(await jarRes.arrayBuffer());
    fs.writeFileSync(destPath, buffer);

    log('info', `Server jar downloaded to ${destPath} (${buffer.length} bytes).`);
}

module.exports = { downloadVanillaJar };
