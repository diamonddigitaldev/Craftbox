const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('../../utils/log');
const { getJavaForVersion } = require('../../utils/javaVersion');

const MAVEN_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

/**
 * Convert a Minecraft version to a NeoForge version prefix.
 * MC 1.20.2 → "20.2", MC 1.21 → "21.0", MC 1.21.4 → "21.4"
 */
function mcToNeoPrefix(mcVersion) {
    const parts = mcVersion.split('.').map(Number);
    const major = parts[1]; // 20, 21, etc.
    const minor = parts[2] || 0;
    return `${major}.${minor}`;
}

/**
 * Convert a NeoForge version prefix back to a Minecraft version.
 * "20.2" → "1.20.2", "21.0" → "1.21"
 */
function neoPrefixToMc(prefix) {
    const [major, minor] = prefix.split('.').map(Number);
    return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

/**
 * Filter to stable NeoForge versions (no alpha, beta, snapshot, pre, craftmine).
 */
function isStable(version) {
    return !/(?:alpha|beta|snapshot|pre|craftmine)/i.test(version);
}

module.exports = {
    id: 'neoforge',
    name: 'NeoForge',
    description: 'Modern, optimised Forge fork',
    icon: 'construction',
    logo: '/img/server-types/neoforge.svg',

    async listVersions() {
        const res = await fetch(MAVEN_API);
        if (!res.ok) throw new Error(`Failed to fetch NeoForge versions: HTTP ${res.status}`);
        const data = await res.json();

        const stableVersions = (data.versions || []).filter(isStable);

        // Group by MC version prefix (e.g. "20.4", "21.1")
        const mcVersions = new Set();
        for (const v of stableVersions) {
            const dotIdx = v.indexOf('.');
            const secondDotIdx = v.indexOf('.', dotIdx + 1);
            if (secondDotIdx === -1) continue;
            const prefix = v.substring(0, secondDotIdx);
            mcVersions.add(prefix);
        }

        // Sort prefixes descending and convert to MC versions
        const sorted = [...mcVersions].sort((a, b) => {
            const aParts = a.split('.').map(Number);
            const bParts = b.split('.').map(Number);
            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                const diff = (bParts[i] || 0) - (aParts[i] || 0);
                if (diff !== 0) return diff;
            }
            return 0;
        });

        const versions = sorted.map(prefix => ({ id: neoPrefixToMc(prefix) }));
        return {
            versions,
            latest: versions[0]?.id || null
        };
    },

    async getBuilds(version) {
        const prefix = mcToNeoPrefix(version);

        const res = await fetch(MAVEN_API);
        if (!res.ok) throw new Error(`Failed to fetch NeoForge versions: HTTP ${res.status}`);
        const data = await res.json();

        const matching = (data.versions || [])
            .filter(v => isStable(v) && v.startsWith(prefix + '.'))
            .map(v => {
                const buildNum = parseInt(v.split('.')[2], 10);
                return { build: v, channel: 'release', _buildNum: buildNum };
            })
            .sort((a, b) => b._buildNum - a._buildNum);

        return matching.map(({ build, channel }) => ({ build, channel }));
    },

    async downloadJar(version, build, destPath) {
        // Auto-select latest build if none specified
        if (!build) {
            const builds = await this.getBuilds(version);
            if (!builds || builds.length === 0) {
                throw new Error(`No NeoForge builds available for MC ${version}.`);
            }
            build = builds[0].build;
        }

        const installerUrl = `${MAVEN_BASE}/${build}/neoforge-${build}-installer.jar`;
        const serverDir = path.dirname(destPath);
        const installerPath = path.join(serverDir, 'neoforge-installer.jar');

        log('info', `Downloading NeoForge installer ${build}...`);
        const installerRes = await fetch(installerUrl);
        if (!installerRes.ok) throw new Error(`Failed to download NeoForge installer: HTTP ${installerRes.status}`);

        fs.mkdirSync(serverDir, { recursive: true });
        const installerBuffer = Buffer.from(await installerRes.arrayBuffer());
        fs.writeFileSync(installerPath, installerBuffer);
        log('info', `NeoForge installer downloaded (${(installerBuffer.length / 1024 / 1024).toFixed(1)} MB). Running installer...`);

        // Run the installer with the correct Java for this MC version
        const javaPath = getJavaForVersion(version);
        try {
            await runNeoForgeInstaller(javaPath, installerPath, serverDir, 300000);
        } catch (err) {
            try { fs.unlinkSync(installerPath); } catch {}
            const installerLogTail = readFileTail(path.join(serverDir, 'installer.log'), 8192);
            throw new Error(
                `NeoForge installer failed: ${err.message}` +
                (installerLogTail ? `\n\n--- installer.log (tail) ---\n${installerLogTail}` : '')
            );
        }

        // Clean up installer jar and log
        try { fs.unlinkSync(installerPath); } catch {}
        try { fs.unlinkSync(path.join(serverDir, 'installer.log')); } catch {}

        // NeoForge always uses the modern args-file launcher
        const argsFile = findNeoForgeArgsFile(serverDir);
        if (argsFile) {
            log('info', `NeoForge ${build} installed (modern launcher with args file).`);
            if (!fs.existsSync(destPath)) {
                fs.writeFileSync(destPath, ''); // empty marker
            }
        } else {
            log('warn', `NeoForge ${build} installed but no args file found — falling back to jar mode.`);
            // Look for a neoforge jar as fallback
            const neoJar = findNeoForgeJar(serverDir, build);
            if (neoJar && neoJar !== destPath) {
                fs.renameSync(neoJar, destPath);
            }
        }

        return { build };
    }
};

/**
 * Find the NeoForge args file for modern installations.
 */
function findNeoForgeArgsFile(serverDir) {
    const libDir = path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge');
    if (!fs.existsSync(libDir)) return null;

    try {
        const versions = fs.readdirSync(libDir);
        for (const ver of versions) {
            const argsName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
            const argsPath = path.join(libDir, ver, argsName);
            if (fs.existsSync(argsPath)) {
                return path.relative(serverDir, argsPath);
            }
        }
    } catch {}
    return null;
}

/**
 * Find a NeoForge jar as fallback for older versions.
 */
function findNeoForgeJar(serverDir, build) {
    const candidates = [
        `neoforge-${build}.jar`,
        `neoforge-${build}-universal.jar`
    ];

    for (const name of candidates) {
        const jarPath = path.join(serverDir, name);
        if (fs.existsSync(jarPath)) return jarPath;
    }

    try {
        const files = fs.readdirSync(serverDir);
        const neoJar = files.find(f => f.startsWith('neoforge-') && f.endsWith('.jar') && !f.includes('installer'));
        if (neoJar) return path.join(serverDir, neoJar);
    } catch {}

    return null;
}

// Export helper for use by ServerProcess
module.exports.findNeoForgeArgsFile = findNeoForgeArgsFile;

function runNeoForgeInstaller(javaPath, installerPath, serverDir, timeoutMs) {
    return new Promise((resolve, reject) => {
        const args = ['-jar', installerPath, '--installServer'];
        const child = spawn(javaPath, args, {
            cwd: serverDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // Head a process group on POSIX so the timeout path can kill every
            // descendant the installer forks (e.g. javac, unpackers).
            detached: process.platform !== 'win32'
        });

        let stdoutTail = '';
        let stderrTail = '';
        const tailLimit = 64 * 1024;

        const timer = setTimeout(() => {
            try {
                if (process.platform === 'win32') {
                    child.kill('SIGKILL');
                } else {
                    process.kill(-child.pid, 'SIGKILL');
                }
            } catch {
                try { child.kill('SIGKILL'); } catch {}
            }
            reject(new Error(`Timed out after ${Math.ceil(timeoutMs / 1000)}s`));
        }, timeoutMs);
        timer.unref?.();

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                stdoutTail = appendTail(stdoutTail, chunk, tailLimit);
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                stderrTail = appendTail(stderrTail, chunk, tailLimit);
            });
        }

        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) return resolve();

            const combinedTail = (stderrTail || stdoutTail).trim();
            const exitDesc = `exit code ${code}${signal ? ` (signal ${signal})` : ''}`;
            reject(new Error(`${exitDesc}${combinedTail ? `\n${combinedTail}` : ''}`));
        });
    });
}

function appendTail(current, chunk, limitChars) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const next = current + text;
    return next.length > limitChars ? next.slice(-limitChars) : next;
}

function readFileTail(filePath, maxBytes) {
    try {
        if (!fs.existsSync(filePath)) return '';
        const stat = fs.statSync(filePath);
        const start = Math.max(0, stat.size - maxBytes);
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buffer, 0, buffer.length, start);
            return buffer.toString('utf8').trim();
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return '';
    }
}
