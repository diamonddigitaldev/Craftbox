const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');
const { verifyChecksum } = require('./_verifyChecksum');
const paper = require('./paper');

const BASE = 'https://api.purpurmc.org/v2/purpur';

module.exports = {
    id: 'purpur',
    name: 'Purpur',
    description: 'Feature-rich, customisable Paper fork',
    icon: 'blur_on',
    logo: '/img/server-types/purpur.svg',

    async listVersions({ channel = 'stable' } = {}) {
        const res = await fetch(BASE);
        if (!res.ok) throw new Error(`Failed to fetch Purpur versions: HTTP ${res.status}`);
        const data = await res.json();

        // Purpur's API publishes no stability signal, but Purpur is a direct
        // Paper fork — a version whose Paper base only ships experimental
        // builds is experimental here too. Borrow Paper's channel per version.
        let paperChannels = new Map();
        try {
            const paperList = await paper.listVersions({ channel: 'all' });
            paperChannels = new Map(paperList.versions.map(v => [v.id, v.channel]));
        } catch (err) {
            // Degraded mode: without Paper's map everything reads as stable —
            // better than failing the Purpur listing outright.
            log('warn', `Purpur channel lookup via Paper failed: ${err.message}`);
        }

        const versions = [...data.versions].reverse()
            .map(v => ({ id: v, channel: paperChannels.get(v) || 'stable' }))
            .filter(v => channel === 'all' || v.channel === 'stable');

        return {
            versions,
            latest: versions.find(v => v.channel === 'stable')?.id || null
        };
    },

    async getBuilds(version) {
        const res = await fetch(`${BASE}/${encodeURIComponent(version)}`);
        if (!res.ok) throw new Error(`Failed to fetch Purpur builds for ${version}: HTTP ${res.status}`);
        const data = await res.json();

        return data.builds.all
            .map(b => ({ build: Number(b), channel: 'default' }))
            .reverse();
    },

    async downloadJar(version, build, destPath) {
        if (!build) {
            const builds = await this.getBuilds(version);
            if (!builds || builds.length === 0) {
                throw new Error(`No builds available for Purpur ${version}.`);
            }
            build = builds[0].build;
        }

        log('info', `Downloading Purpur ${version} build ${build}...`);

        // Fetch build metadata first to get the MD5 sidecar for verification.
        // MD5 is the only checksum Purpur publishes — cryptographically weak
        // (collisions are cheap) but still catches casual MITM and mirror
        // corruption, which are the realistic supply-chain threats here.
        const metaRes = await fetch(`${BASE}/${encodeURIComponent(version)}/${build}`);
        if (!metaRes.ok) throw new Error(`Failed to fetch Purpur build metadata: HTTP ${metaRes.status}`);
        const meta = await metaRes.json();

        const jarRes = await fetch(`${BASE}/${encodeURIComponent(version)}/${build}/download`);
        if (!jarRes.ok) throw new Error(`Failed to download Purpur jar: HTTP ${jarRes.status}`);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await jarRes.arrayBuffer());
        verifyChecksum(buffer, 'md5', meta.md5, 'Purpur');
        fs.writeFileSync(destPath, buffer);

        log('info', `Purpur server jar downloaded and MD5 verified (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
        return { build };
    }
};
