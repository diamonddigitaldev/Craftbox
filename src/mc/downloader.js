const { getProvider } = require('./serverTypes');

/**
 * Download a server jar using the appropriate provider.
 * @param {string} type - Server type (vanilla, paper, fabric, etc.)
 * @param {string} version - Version string (or URL for custom type)
 * @param {number|null} build - Build number (for Paper/Purpur/Folia) or null
 * @param {string} destPath - Absolute path to save the jar
 * @returns {Promise<{build?: number}>} Result metadata (e.g. resolved build number)
 */
async function downloadServerJar(type, version, build, destPath) {
    const provider = getProvider(type);
    if (!provider) throw new Error(`Unknown server type: ${type}`);
    return await provider.downloadJar(version, build, destPath);
}

/**
 * Download the vanilla Minecraft server jar (backward compat).
 */
async function downloadVanillaJar(version, destPath) {
    return downloadServerJar('vanilla', version, null, destPath);
}

module.exports = { downloadServerJar, downloadVanillaJar };
