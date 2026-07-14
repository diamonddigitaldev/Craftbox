const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');
const { verifyChecksum } = require('./_verifyChecksum');
const { classifyMcId } = require('./_channels');

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

// Snapshot ids ("25w03a") can't be parsed by hasServerJar; use the 1.2.5
// release date as the server-jar cutoff instead.
const SERVER_JAR_CUTOFF = '2012-03-25T00:00:00+00:00';

module.exports = {
    id: 'vanilla',
    name: 'Vanilla',
    description: 'Official Minecraft server from Mojang',
    icon: 'cube',
    logo: '/img/server-types/vanilla.svg',

    async listVersions({ channel = 'stable' } = {}) {
        const res = await fetch(VERSION_MANIFEST_URL);
        if (!res.ok) throw new Error(`Failed to fetch version manifest: HTTP ${res.status}`);
        const manifest = await res.json();

        // Manifest order is newest-first with snapshots and releases interleaved
        // chronologically — preserve it. old_beta/old_alpha never had server jars.
        const versions = manifest.versions
            .filter(v => {
                if (v.type === 'release') return hasServerJar(v.id);
                if (channel !== 'all') return false;
                return v.type === 'snapshot' && v.releaseTime > SERVER_JAR_CUTOFF;
            })
            .map(v => ({
                id: v.id,
                channel: v.type === 'release' ? 'stable' : classifyMcId(v.id),
                releaseDate: v.releaseTime
            }));

        return { versions, latest: manifest.latest.release };
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

        // Mojang publishes the required Java runtime with the version details;
        // pass it along so the downloader can skip its own lookup.
        return { javaMajor: detail.javaVersion?.majorVersion || null };
    }
};
