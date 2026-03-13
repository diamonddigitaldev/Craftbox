const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { log } = require('../../utils/log');
const { getDefaultJava } = require('../../utils/javaVersion');

const PROMOTIONS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const MAVEN_BASE = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

module.exports = {
    id: 'forge',
    name: 'Forge',
    description: 'Classic large-modpack platform',
    icon: 'construction',
    logo: '/img/server-types/forge.svg',

    async listVersions() {
        const res = await fetch(PROMOTIONS_URL);
        if (!res.ok) throw new Error(`Failed to fetch Forge promotions: HTTP ${res.status}`);
        const data = await res.json();

        // promos keys look like "1.21.4-latest", "1.21.4-recommended", "1.20.1-latest", etc.
        const mcVersions = new Set();
        for (const key of Object.keys(data.promos || {})) {
            const mcVer = key.replace(/-(?:latest|recommended)$/, '');
            mcVersions.add(mcVer);
        }

        // Sort versions descending
        const sorted = [...mcVersions].sort((a, b) => {
            const aParts = a.split('.').map(Number);
            const bParts = b.split('.').map(Number);
            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                const diff = (bParts[i] || 0) - (aParts[i] || 0);
                if (diff !== 0) return diff;
            }
            return 0;
        });

        return {
            versions: sorted.map(v => ({ id: v })),
            latest: sorted[0] || null
        };
    },

    async getBuilds(version) {
        const res = await fetch(PROMOTIONS_URL);
        if (!res.ok) throw new Error(`Failed to fetch Forge promotions: HTTP ${res.status}`);
        const data = await res.json();
        const promos = data.promos || {};

        const builds = [];
        const latest = promos[`${version}-latest`];
        const recommended = promos[`${version}-recommended`];

        if (recommended) {
            builds.push({ build: recommended, channel: 'recommended' });
        }
        if (latest && latest !== recommended) {
            builds.push({ build: latest, channel: 'latest' });
        }

        return builds;
    },

    async downloadJar(version, build, destPath) {
        // Auto-select build if none specified
        if (!build) {
            const builds = await this.getBuilds(version);
            if (!builds || builds.length === 0) {
                throw new Error(`No Forge builds available for MC ${version}.`);
            }
            // Prefer recommended, fallback to latest
            build = builds[0].build;
        }

        const forgeVersion = `${version}-${build}`;
        const installerUrl = `${MAVEN_BASE}/${forgeVersion}/forge-${forgeVersion}-installer.jar`;
        const serverDir = path.dirname(destPath);
        const installerPath = path.join(serverDir, 'forge-installer.jar');

        log('info', `Downloading Forge installer ${forgeVersion}...`);
        const installerRes = await fetch(installerUrl);
        if (!installerRes.ok) throw new Error(`Failed to download Forge installer: HTTP ${installerRes.status}`);

        fs.mkdirSync(serverDir, { recursive: true });
        const installerBuffer = Buffer.from(await installerRes.arrayBuffer());
        fs.writeFileSync(installerPath, installerBuffer);
        log('info', `Forge installer downloaded (${(installerBuffer.length / 1024 / 1024).toFixed(1)} MB). Running installer...`);

        // Run the installer
        const javaPath = getDefaultJava();
        try {
            execFileSync(javaPath, ['-jar', installerPath, '--installServer'], {
                cwd: serverDir,
                stdio: 'pipe',
                timeout: 300000 // 5 minute timeout
            });
        } catch (err) {
            // Clean up installer on failure
            try { fs.unlinkSync(installerPath); } catch {}
            const stderr = err.stderr ? err.stderr.toString().slice(-500) : '';
            throw new Error(`Forge installer failed: ${err.message}${stderr ? '\n' + stderr : ''}`);
        }

        // Clean up installer jar
        try { fs.unlinkSync(installerPath); } catch {}
        // Clean up installer log
        try { fs.unlinkSync(path.join(serverDir, 'installer.log')); } catch {}

        // Determine what the installer created
        // For MC 1.17+: creates libraries/ dir with unix_args.txt/win_args.txt
        // For MC <1.17: creates forge-{version}.jar
        const argsFile = findForgeArgsFile(serverDir);
        if (argsFile) {
            // 1.17+ style — write a marker so ServerProcess knows to use @args
            log('info', `Forge ${forgeVersion} installed (modern launcher with args file).`);
            // Create a minimal server.jar marker (or just leave destPath absent)
            // The actual launch uses @args, not -jar server.jar
            // Write a small text file so the server dir isn't confusing
            if (!fs.existsSync(destPath)) {
                fs.writeFileSync(destPath, ''); // empty marker
            }
        } else {
            // Legacy style — find the generated forge jar and rename to server.jar
            const forgeJar = findForgeJar(serverDir, version, build);
            if (forgeJar && forgeJar !== destPath) {
                fs.renameSync(forgeJar, destPath);
            }
            log('info', `Forge ${forgeVersion} installed (legacy -jar mode).`);
        }

        return { build };
    }
};

/**
 * Find the Forge args file for 1.17+ style installations.
 * Looks for unix_args.txt or win_args.txt in the libraries directory.
 */
function findForgeArgsFile(serverDir) {
    const libDir = path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge');
    if (!fs.existsSync(libDir)) return null;

    try {
        const versions = fs.readdirSync(libDir);
        for (const ver of versions) {
            const argsName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
            const argsPath = path.join(libDir, ver, argsName);
            if (fs.existsSync(argsPath)) {
                // Return path relative to serverDir
                return path.relative(serverDir, argsPath);
            }
        }
    } catch {}
    return null;
}

/**
 * Find the generated forge server jar for legacy (<1.17) installations.
 */
function findForgeJar(serverDir, mcVersion, forgeVersion) {
    const candidates = [
        `forge-${mcVersion}-${forgeVersion}.jar`,
        `forge-${mcVersion}-${forgeVersion}-universal.jar`
    ];

    for (const name of candidates) {
        const jarPath = path.join(serverDir, name);
        if (fs.existsSync(jarPath)) return jarPath;
    }

    // Fallback: find any forge-*.jar
    try {
        const files = fs.readdirSync(serverDir);
        const forgeJar = files.find(f => f.startsWith('forge-') && f.endsWith('.jar') && !f.includes('installer'));
        if (forgeJar) return path.join(serverDir, forgeJar);
    } catch {}

    return null;
}

// Export helper for use by ServerProcess
module.exports.findForgeArgsFile = findForgeArgsFile;
