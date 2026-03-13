const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');

/**
 * Factory that creates a provider for any PaperMC API v2 project
 * (Paper, Folia, Velocity, etc.).
 */
function createPaperApiProvider({ project, id, name, description, icon }) {
    const BASE = `https://api.papermc.io/v2/projects/${project}`;

    return {
        id,
        name,
        description,
        icon,

        async listVersions() {
            const res = await fetch(BASE);
            if (!res.ok) throw new Error(`Failed to fetch ${name} versions: HTTP ${res.status}`);
            const data = await res.json();

            // API returns versions oldest-first; reverse for newest-first
            const versions = [...data.versions].reverse().map(v => ({ id: v }));
            return { versions, latest: versions[0]?.id || null };
        },

        async getBuilds(version) {
            const res = await fetch(`${BASE}/versions/${version}/builds`);
            if (!res.ok) throw new Error(`Failed to fetch ${name} builds for ${version}: HTTP ${res.status}`);
            const data = await res.json();

            // Return builds newest-first
            return data.builds
                .map(b => ({ build: b.build, channel: b.channel }))
                .reverse();
        },

        async downloadJar(version, build, destPath) {
            // Auto-select latest build if none specified
            if (!build) {
                const builds = await this.getBuilds(version);
                if (!builds || builds.length === 0) {
                    throw new Error(`No builds available for ${name} ${version}.`);
                }
                build = builds[0].build;
            }

            // Get the download filename
            const buildRes = await fetch(`${BASE}/versions/${version}/builds/${build}`);
            if (!buildRes.ok) throw new Error(`Failed to fetch ${name} build info: HTTP ${buildRes.status}`);
            const buildData = await buildRes.json();

            const filename = buildData.downloads?.application?.name;
            if (!filename) throw new Error(`No download available for ${name} ${version} build ${build}.`);

            log('info', `Downloading ${name} ${version} build ${build}...`);
            const jarRes = await fetch(`${BASE}/versions/${version}/builds/${build}/downloads/${filename}`);
            if (!jarRes.ok) throw new Error(`Failed to download ${name} jar: HTTP ${jarRes.status}`);

            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            const buffer = Buffer.from(await jarRes.arrayBuffer());
            fs.writeFileSync(destPath, buffer);

            log('info', `${name} server jar downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
            return { build };
        }
    };
}

module.exports = createPaperApiProvider;
