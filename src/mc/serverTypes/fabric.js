const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');

const BASE = 'https://meta.fabricmc.net/v2';

module.exports = {
    id: 'fabric',
    name: 'Fabric',
    description: 'Lightweight modding framework',
    icon: 'style',

    async listVersions() {
        const res = await fetch(`${BASE}/versions/game`);
        if (!res.ok) throw new Error(`Failed to fetch Fabric game versions: HTTP ${res.status}`);
        const versions = await res.json();

        const stable = versions
            .filter(v => v.stable)
            .map(v => ({ id: v.version }));

        return { versions: stable, latest: stable[0]?.id || null };
    },

    async getBuilds() {
        // Fabric auto-selects the loader version; no user-facing build picker
        return null;
    },

    async downloadJar(version, build, destPath) {
        // Get the latest stable loader version
        const loaderRes = await fetch(`${BASE}/versions/loader`);
        if (!loaderRes.ok) throw new Error(`Failed to fetch Fabric loader versions: HTTP ${loaderRes.status}`);
        const loaders = await loaderRes.json();

        const stableLoader = loaders.find(l => l.stable) || loaders[0];
        if (!stableLoader) throw new Error('No Fabric loader versions available.');
        const loaderVersion = stableLoader.version;

        // Get the latest installer version
        const installerRes = await fetch(`${BASE}/versions/installer`);
        if (!installerRes.ok) throw new Error(`Failed to fetch Fabric installer versions: HTTP ${installerRes.status}`);
        const installers = await installerRes.json();

        const stableInstaller = installers.find(i => i.stable) || installers[0];
        if (!stableInstaller) throw new Error('No Fabric installer versions available.');
        const installerVersion = stableInstaller.version;

        const downloadUrl = `${BASE}/versions/loader/${version}/${loaderVersion}/${installerVersion}/server/jar`;

        log('info', `Downloading Fabric server ${version} (loader ${loaderVersion})...`);
        const jarRes = await fetch(downloadUrl);
        if (!jarRes.ok) throw new Error(`Failed to download Fabric server jar: HTTP ${jarRes.status}`);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await jarRes.arrayBuffer());
        fs.writeFileSync(destPath, buffer);

        log('info', `Fabric server jar downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
    }
};
