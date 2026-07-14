const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');
const { classifyMcId } = require('./_channels');

const BASE = 'https://meta.fabricmc.net/v2';

module.exports = {
    id: 'fabric',
    name: 'Fabric',
    description: 'Lightweight modding ecosystem',
    icon: 'style',
    logo: '/img/server-types/fabric.svg',

    async listVersions({ channel = 'stable' } = {}) {
        const res = await fetch(`${BASE}/versions/game`);
        if (!res.ok) throw new Error(`Failed to fetch Fabric game versions: HTTP ${res.status}`);
        const versions = await res.json();

        // Meta API order is newest-first with snapshots interleaved — preserve it.
        const mapped = versions
            .filter(v => channel === 'all' || v.stable)
            .map(v => ({
                id: v.version,
                channel: v.stable ? 'stable' : classifyMcId(v.version)
            }));

        return {
            versions: mapped,
            latest: mapped.find(v => v.channel === 'stable')?.id || null
        };
    },

    async getBuilds() {
        // Fabric auto-selects the loader version; no user-facing build picker
        return null;
    },

    async downloadJar(version, build, destPath) {
        // Honor a pinned loader version (modpacks pin fabric-loader exactly);
        // otherwise use the latest stable loader.
        let loaderVersion = build || null;
        if (!loaderVersion) {
            const loaderRes = await fetch(`${BASE}/versions/loader`);
            if (!loaderRes.ok) throw new Error(`Failed to fetch Fabric loader versions: HTTP ${loaderRes.status}`);
            const loaders = await loaderRes.json();

            const stableLoader = loaders.find(l => l.stable) || loaders[0];
            if (!stableLoader) throw new Error('No Fabric loader versions available.');
            loaderVersion = stableLoader.version;
        }

        // Get the latest installer version
        const installerRes = await fetch(`${BASE}/versions/installer`);
        if (!installerRes.ok) throw new Error(`Failed to fetch Fabric installer versions: HTTP ${installerRes.status}`);
        const installers = await installerRes.json();

        const stableInstaller = installers.find(i => i.stable) || installers[0];
        if (!stableInstaller) throw new Error('No Fabric installer versions available.');
        const installerVersion = stableInstaller.version;

        const downloadUrl = `${BASE}/versions/loader/${encodeURIComponent(version)}/${loaderVersion}/${installerVersion}/server/jar`;

        log('info', `Downloading Fabric server ${version} (loader ${loaderVersion})...`);
        // Fabric composes the server JAR on demand on its meta endpoint and
        // publishes no static checksum for the resulting artifact, so this
        // provider can't be checksum-verified the way the others are.
        // Surface this once per download so the operator is aware.
        log('warn', 'Fabric server JAR is not checksum-verified — upstream does not publish a checksum for the dynamically composed server jar.');
        const jarRes = await fetch(downloadUrl);
        if (!jarRes.ok) throw new Error(`Failed to download Fabric server jar: HTTP ${jarRes.status}`);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await jarRes.arrayBuffer());
        fs.writeFileSync(destPath, buffer);

        log('info', `Fabric server jar downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
        return { build: loaderVersion };
    }
};
