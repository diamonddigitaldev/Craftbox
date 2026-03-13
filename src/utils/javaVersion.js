const fs = require('fs');

/**
 * Resolve the Debian architecture name used by Adoptium Temurin packages.
 * process.arch returns Node names (x64, arm64, arm); Temurin uses Debian names.
 */
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64', arm: 'armhf' };
const TEMURIN_ARCH = ARCH_MAP[process.arch] || 'amd64';

/**
 * Known Temurin JRE install paths (Docker / apt-installed).
 * These are checked first; if none exist we fall back to system java.
 */
const TEMURIN_PATHS = {
    8:  `/usr/lib/jvm/temurin-8-jre-${TEMURIN_ARCH}/bin/java`,
    17: `/usr/lib/jvm/temurin-17-jre-${TEMURIN_ARCH}/bin/java`,
    21: `/usr/lib/jvm/temurin-21-jre-${TEMURIN_ARCH}/bin/java`,
    25: `/usr/lib/jvm/temurin-25-jre-${TEMURIN_ARCH}/bin/java`,
};

/**
 * Detect whether we're in the Docker multi-JRE environment
 * (at least one Temurin path exists) or running standalone.
 * Cached at startup so we only check the filesystem once.
 */
const _hasTemurin = process.platform !== 'win32' &&
    Object.values(TEMURIN_PATHS).some(p => fs.existsSync(p));

/**
 * Determine the required Java version for a given Minecraft version.
 *
 * MC Version Requirements:
 *   1.7.x  – 1.16.x  → Java 8
 *   1.17.x            → Java 17
 *   1.18.x – 1.20.4   → Java 17
 *   1.20.5 – 1.21.x+  → Java 21
 *
 * @param {string} mcVersion - e.g. "1.20.4", "1.21.1"
 * @returns {number} Java major version (8, 17, 21)
 */
function getRequiredJavaVersion(mcVersion) {
    if (!mcVersion || typeof mcVersion !== 'string') return 25;

    const parts = mcVersion.split('.').map(Number);
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;

    if (minor >= 21) return 21;
    if (minor === 20 && patch >= 5) return 21;
    if (minor >= 17) return 17;  // 1.17 – 1.20.4
    return 8;                     // 1.16.x and below
}

/**
 * Get the Java binary path for a given Minecraft version.
 *
 * In Docker (Temurin paths detected): picks the exact JRE for the MC version,
 * falling back to the closest available version if that exact one is missing.
 *
 * Standalone Linux / Windows: returns 'java' (system PATH).
 *
 * @param {string} mcVersion - e.g. "1.20.4"
 * @returns {string} Path to java binary
 */
function getJavaForVersion(mcVersion) {
    // Windows or standalone Linux — use system java
    if (process.platform === 'win32' || !_hasTemurin) {
        return 'java';
    }

    const required = getRequiredJavaVersion(mcVersion);
    const exactPath = TEMURIN_PATHS[required];
    if (fs.existsSync(exactPath)) return exactPath;

    // Exact version not installed — try the next higher version that exists
    const allVersions = [8, 17, 21, 25];
    for (const ver of allVersions) {
        if (ver >= required && fs.existsSync(TEMURIN_PATHS[ver])) {
            return TEMURIN_PATHS[ver];
        }
    }

    return getDefaultJava();
}

/**
 * Get the default (newest) Java binary.
 * Used as fallback and for tasks that don't depend on MC version (e.g. Forge installer).
 *
 * @returns {string} Path to java binary
 */
function getDefaultJava() {
    if (process.platform === 'win32' || !_hasTemurin) {
        return 'java';
    }

    // Try newest first
    const versions = [25, 21, 17, 8];
    for (const ver of versions) {
        if (fs.existsSync(TEMURIN_PATHS[ver])) return TEMURIN_PATHS[ver];
    }
    return 'java';
}

module.exports = { getJavaForVersion, getDefaultJava, getRequiredJavaVersion, TEMURIN_PATHS };
