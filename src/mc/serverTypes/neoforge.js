const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('../../utils/log');
const { getJavaForVersion } = require('../../utils/javaVersion');
const { verifyMavenChecksum } = require('./_verifyChecksum');
const { pickLatestBuild, compareBuilds } = require('./_channels');

const MAVEN_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

/**
 * The Minecraft version a NeoForge build targets. NeoForge numbers its builds
 * after it: up to 1.21.x it drops Minecraft's leading "1." (21.1.252 → 1.21.1,
 * 21.0.x → 1.21), and from Minecraft's year-based versions on it keeps the
 * whole version, hotfix included, ahead of the build number (26.1.2.112 →
 * 26.1.2, 26.2.0.88 → 26.2).
 */
function neoBuildToMc(build) {
    const nums = String(build).split('-')[0].split('.').map(Number);
    if (nums[0] >= 26) {
        const [year, drop, hotfix] = nums;
        return hotfix ? `${year}.${drop}.${hotfix}` : `${year}.${drop}`;
    }
    const [minor, patch] = nums;
    return patch ? `1.${minor}.${patch}` : `1.${minor}`;
}

/**
 * Before 1.2.1 Craftbox listed NeoForge's year-based builds as Minecraft
 * "1.26.x", which is no real version (and lumped 26.1, 26.1.1 and 26.1.2
 * together as "1.26.1"). Returns the version a record with such a label
 * actually runs, read off its build where it has one; any other version is
 * returned unchanged.
 */
function relabelLegacyVersion(version, build) {
    const legacy = /^1\.(\d+)\.(\d+)$/.exec(String(version || ''));
    if (!legacy || Number(legacy[1]) < 26) return version;
    if (build && /^\d+\.\d+\.\d+\.\d+/.test(String(build))) return neoBuildToMc(build);
    return `${legacy[1]}.${legacy[2]}`;
}

function compareMcVersions(a, b) {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
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

    async listVersions({ channel = 'stable' } = {}) {
        const res = await fetch(MAVEN_API);
        if (!res.ok) throw new Error(`Failed to fetch NeoForge versions: HTTP ${res.status}`);
        const data = await res.json();

        // April-Fools "craftmine" builds don't map to real MC versions — always excluded.
        const allVersions = (data.versions || []).filter(v => !/craftmine/i.test(v));

        // Group builds by the MC version they target, tracking whether that
        // version has any stable NeoForge build. An MC version whose builds are
        // all -beta (early lifecycle) is labeled 'beta'.
        const mcHasStable = new Map();
        for (const v of allVersions) {
            if (v.split('.').length < 3) continue;
            const mc = neoBuildToMc(v);
            mcHasStable.set(mc, mcHasStable.get(mc) || isStable(v));
        }

        const versions = [...mcHasStable.keys()]
            .filter(mc => channel === 'all' || mcHasStable.get(mc))
            .sort((a, b) => compareMcVersions(b, a))
            .map(mc => ({
                id: mc,
                channel: mcHasStable.get(mc) ? 'stable' : 'beta'
            }));
        return {
            versions,
            latest: versions.find(v => v.channel === 'stable')?.id || null
        };
    },

    async getBuilds(version) {
        const mc = relabelLegacyVersion(version);

        const res = await fetch(MAVEN_API);
        if (!res.ok) throw new Error(`Failed to fetch NeoForge versions: HTTP ${res.status}`);
        const data = await res.json();

        // Newest-first. Sorting on the parsed build number alone left
        // "21.9.16-beta" and "21.9.16" in whatever order the API returned them,
        // so the beta could be picked over the release it precedes;
        // compareBuilds reads the -beta suffix as older.
        return (data.versions || [])
            .filter(v => !/craftmine/i.test(v) && v.split('.').length >= 3 && neoBuildToMc(v) === mc)
            .map(v => ({ build: v, channel: isStable(v) ? 'release' : 'beta' }))
            .sort((a, b) => compareBuilds(b.build, a.build));
    },

    async downloadJar(version, build, destPath) {
        // Auto-select the newest published build if none specified.
        if (!build) {
            const builds = await this.getBuilds(version);
            if (!builds || builds.length === 0) {
                throw new Error(`No NeoForge builds available for MC ${version}.`);
            }
            build = pickLatestBuild(builds).build;
        }

        const installerUrl = `${MAVEN_BASE}/${build}/neoforge-${build}-installer.jar`;
        const serverDir = path.dirname(destPath);
        const installerPath = path.join(serverDir, 'neoforge-installer.jar');

        log('info', `Downloading NeoForge installer ${build}...`);
        const installerRes = await fetch(installerUrl);
        if (!installerRes.ok) throw new Error(`Failed to download NeoForge installer: HTTP ${installerRes.status}`);

        fs.mkdirSync(serverDir, { recursive: true });
        const installerBuffer = Buffer.from(await installerRes.arrayBuffer());

        // Verify against the checksum sidecar published by Maven before the
        // installer is written to disk and executed. Mirror compromise or
        // in-path tampering would otherwise yield host RCE here.
        const algo = await verifyMavenChecksum(installerBuffer, installerUrl, 'NeoForge');

        fs.writeFileSync(installerPath, installerBuffer);
        log('info', `NeoForge installer downloaded and ${algo.toUpperCase().replace(/^SHA/, 'SHA-')} verified (${(installerBuffer.length / 1024 / 1024).toFixed(1)} MB). Running installer...`);

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
// For the startup migration in db.js
module.exports.relabelLegacyVersion = relabelLegacyVersion;

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
