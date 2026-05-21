const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');
const { verifyChecksum } = require('./_verifyChecksum');

const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';

// Mojang began hosting official server jars with release 1.2.5 (March 2012).
// Older releases appear in the manifest but have no `downloads.server` entry.
function hasServerJar(id) {
    const parts = id.split('.').map(Number);
    if (parts.some(Number.isNaN)) return false;
    const [maj, min = 0, patch = 0] = parts;
    if (maj > 1) return true;
    if (maj < 1) return false;
    if (min > 2) return true;
    if (min < 2) return false;
    return patch >= 5;
}

module.exports = {
    id: 'vanilla',
    name: 'Vanilla',
    description: 'Official Minecraft server from Mojang',
    icon: 'cube',
    logo: '/img/server-types/vanilla.svg',

    async listVersions() {
        const res = await fetch(VERSION_MANIFEST_URL);
        if (!res.ok) throw new Error(`Failed to fetch version manifest: HTTP ${res.status}`);
        const manifest = await res.json();

        return {
            versions: manifest.versions
                .filter(v => v.type === 'release' && hasServerJar(v.id))
                .map(v => ({ id: v.id })),
            latest: manifest.latest.release
        };
    },

    async getBuilds() {
        return null;
    },

    async downloadJar(version, build, destPath) {
        log('info', `Fetching version manifest to download Vanilla ${version}...`);

        const manifestRes = await fetch(VERSION_MANIFEST_URL);
        if (!manifestRes.ok) throw new Error(`Failed to fetch version manifest: HTTP ${manifestRes.status}`);
        const manifest = await manifestRes.json();

        const versionEntry = manifest.versions.find(v => v.id === version);
        if (!versionEntry) throw new Error(`Minecraft version "${version}" not found.`);

        log('info', `Fetching version details for ${version}...`);
        const detailRes = await fetch(versionEntry.url);
        if (!detailRes.ok) throw new Error(`Failed to fetch version details: HTTP ${detailRes.status}`);
        const detail = await detailRes.json();

        const serverDownload = detail.downloads?.server;
        if (!serverDownload) throw new Error(`No server download available for version "${version}".`);

        log('info', `Downloading Vanilla server jar (${(serverDownload.size / 1024 / 1024).toFixed(1)} MB)...`);
        const jarRes = await fetch(serverDownload.url);
        if (!jarRes.ok) throw new Error(`Failed to download server jar: HTTP ${jarRes.status}`);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await jarRes.arrayBuffer());
        verifyChecksum(buffer, 'sha1', serverDownload.sha1, 'Vanilla');
        fs.writeFileSync(destPath, buffer);

        log('info', `Vanilla server jar downloaded and SHA-1 verified (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
    }
};
