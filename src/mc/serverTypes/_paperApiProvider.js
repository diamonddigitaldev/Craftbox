const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');

/**
 * Factory that creates a provider for any PaperMC API v3 project
 * (Paper, Folia, Velocity, etc.) using fill.papermc.io.
 */
function createPaperApiProvider({ project, id, name, description, icon, logo }) {
    const BASE = `https://fill.papermc.io/v3/projects/${project}`;

    return {
        id,
        name,
        description,
        icon,
        logo,

        async listVersions() {
            const res = await fetch(BASE);
            if (!res.ok) throw new Error(`Failed to fetch ${name} versions: HTTP ${res.status}`);
            const data = await res.json();

            // v3 returns versions grouped by major: { versions: { "1.21": ["1.21.11", ...], "1.20": [...] } }
            const grouped = data.versions;
            if (!grouped || typeof grouped !== 'object') {
                throw new Error(`Unexpected ${name} API response format.`);
            }

            // Sort major version keys descending (e.g. 1.21 before 1.20)
            const majorKeys = Object.keys(grouped).sort((a, b) => {
                const aParts = a.split('.').map(Number);
                const bParts = b.split('.').map(Number);
                for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                    const diff = (bParts[i] || 0) - (aParts[i] || 0);
                    if (diff !== 0) return diff;
                }
                return 0;
            });

            // Build stable sub-version lists per major (pre/rc filtered out).
            // v3 API returns sub-versions newest-first, which is what we want.
            const stableSubsByMajor = {};
            for (const major of majorKeys) {
                stableSubsByMajor[major] = grouped[major].filter(v => !/pre|rc/i.test(v));
            }

            // Drop major groups whose newest sub-version has no STABLE builds.
            // Minecraft's new "Copper Age" versions (e.g. 26.1.x) appear in the v3
            // listing but only ship ALPHA builds, which would 404 on download.
            const majorHasStable = await Promise.all(majorKeys.map(async major => {
                const newest = stableSubsByMajor[major][0];
                if (!newest) return false;
                try {
                    const r = await fetch(`${BASE}/versions/${newest}/builds?channel=STABLE`);
                    if (!r.ok) return false;
                    const builds = await r.json();
                    return Array.isArray(builds) && builds.length > 0;
                } catch {
                    return false;
                }
            }));

            // Flatten into a single newest-first array
            const allVersions = [];
            for (let i = 0; i < majorKeys.length; i++) {
                if (!majorHasStable[i]) continue;
                allVersions.push(...stableSubsByMajor[majorKeys[i]]);
            }

            return {
                versions: allVersions.map(v => ({ id: v })),
                latest: allVersions[0] || null
            };
        },

        async getBuilds(version) {
            const res = await fetch(`${BASE}/versions/${version}/builds?channel=STABLE`);
            if (!res.ok) throw new Error(`Failed to fetch ${name} builds for ${version}: HTTP ${res.status}`);
            const data = await res.json();

            // v3 returns an array of build objects:
            // { id, time, channel, downloads: { "server:default": { name, url, checksums, size } } }
            if (!Array.isArray(data)) {
                throw new Error(`Unexpected ${name} builds response format.`);
            }

            return data
                .map(b => ({ build: b.id, channel: b.channel }))
                .reverse(); // newest-first
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

            // Fetch build details to get the direct download URL
            const buildRes = await fetch(`${BASE}/versions/${version}/builds/${build}`);
            if (!buildRes.ok) throw new Error(`Failed to fetch ${name} build info: HTTP ${buildRes.status}`);
            const buildData = await buildRes.json();

            const download = buildData.downloads?.['server:default'];
            if (!download || !download.url) {
                throw new Error(`No download available for ${name} ${version} build ${build}.`);
            }

            log('info', `Downloading ${name} ${version} build ${build}...`);
            const jarRes = await fetch(download.url);
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
