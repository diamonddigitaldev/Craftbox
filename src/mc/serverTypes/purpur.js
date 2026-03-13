const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');

const BASE = 'https://api.purpurmc.org/v2/purpur';

module.exports = {
    id: 'purpur',
    name: 'Purpur',
    description: 'Feature-rich, customisable Paper fork',
    icon: 'blur_on',
    logo: '/img/server-types/purpur.svg',

    async listVersions() {
        const res = await fetch(BASE);
        if (!res.ok) throw new Error(`Failed to fetch Purpur versions: HTTP ${res.status}`);
        const data = await res.json();

        const versions = [...data.versions].reverse().map(v => ({ id: v }));
        return { versions, latest: versions[0]?.id || null };
    },

    async getBuilds(version) {
        const res = await fetch(`${BASE}/${version}`);
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
        const jarRes = await fetch(`${BASE}/${version}/${build}/download`);
        if (!jarRes.ok) throw new Error(`Failed to download Purpur jar: HTTP ${jarRes.status}`);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await jarRes.arrayBuffer());
        fs.writeFileSync(destPath, buffer);

        log('info', `Purpur server jar downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
        return { build };
    }
};
