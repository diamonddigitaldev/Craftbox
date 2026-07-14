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
    8: `/usr/lib/jvm/temurin-8-jre-${TEMURIN_ARCH}/bin/java`,
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
 *   1.7.x  - 1.16.x  → Java 8
 *   1.17.x - 1.20.4   → Java 17
 *   1.20.5 - 1.21.x+  → Java 21
 *   26.x+             → Java 25  (new year.drop.patch versioning from 2026)
 *
 * Snapshot ids ("25w03a") carry no dotted version — mapped by snapshot year
 * to the corresponding release era. Pre-release/rc suffixes ("1.20.5-rc1",
 * "1.14 Pre-Release 5") resolve like their target release.
 *
 * This is the offline heuristic; a server record's `javaMajor` (looked up
 * from Mojang metadata at download time) takes precedence when present.
 *
 * @param {string} mcVersion - e.g. "1.20.4", "1.21.1", "26.1", "25w03a"
 * @returns {number} Java major version (8, 17, 21, 25)
 */
function getRequiredJavaVersion(mcVersion) {
    if (!mcVersion || typeof mcVersion !== 'string') return 25;

    const snapshot = /^(\d{2})w\d{2}/.exec(mcVersion);
    if (snapshot) {
        const year = parseInt(snapshot[1], 10);
        if (year >= 26) return 25;
        if (year >= 24) return 21;  // 1.20.5 / 1.21 era
        if (year >= 21) return 17;  // 1.17 - 1.20.4 era
        return 8;                    // 1.16.x era and older
    }

    const cleaned = mcVersion.replace(/[ _-]?(?:pre|rc).*$/i, '');
    const parts = cleaned.split('.').map(Number);
    const major = parts[0] || 0;

    // New versioning: 26.x+ (year.drop.patch) requires Java 25
    if (major >= 26) return 25;

    // Legacy versioning: 1.x.y
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;

    // NeoForge represents year.drop MC versions as pseudo 1.x ids ("1.26.1"
    // means MC 26.1). Real 1.x versioning ended at 1.21, so 1.26+ can only
    // mean the new era.
    if (minor >= 26) return 25;

    if (minor >= 21) return 21;
    if (minor === 20 && patch >= 5) return 21;
    if (minor >= 17) return 17;  // 1.17 - 1.20.4
    return 8;                     // 1.16.x and below
}

/**
 * Get the Java binary path for a required Java major version.
 *
 * In Docker (Temurin paths detected): picks the exact JRE, falling back to
 * the next higher installed version (e.g. Mojang's 16 → Temurin 17).
 *
 * Standalone Linux / Windows: returns 'java' (system PATH).
 *
 * @param {number} required - Java major version (e.g. 8, 16, 17, 21, 25)
 * @returns {string} Path to java binary
 */
function getJavaForMajor(required) {
    // Windows or standalone Linux — use system java
    if (process.platform === 'win32' || !_hasTemurin) {
        return 'java';
    }

    const exactPath = TEMURIN_PATHS[required];
    if (exactPath && fs.existsSync(exactPath)) return exactPath;

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
 * Get the Java binary path for a given Minecraft version.
 *
 * @param {string} mcVersion - e.g. "1.20.4"
 * @returns {string} Path to java binary
 */
function getJavaForVersion(mcVersion) {
    return getJavaForMajor(getRequiredJavaVersion(mcVersion));
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

module.exports = { getJavaForVersion, getJavaForMajor, getDefaultJava, getRequiredJavaVersion, TEMURIN_PATHS };
