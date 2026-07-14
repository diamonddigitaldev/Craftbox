const fs = require('fs');
const { getProvider } = require('./serverTypes');
const { ChecksumMismatchError } = require('./serverTypes/_verifyChecksum');
const { lookupMojangJavaMajor } = require('./serverTypes/_mojangMeta');
const { log } = require('../utils/log');

/**
 * Download a server jar using the appropriate provider.
 * @param {string} type - Server type (vanilla, paper, fabric, etc.)
 * @param {string} version - Version string (or URL for custom type)
 * @param {number|null} build - Build number (for Paper/Purpur/Folia) or null
 * @param {string} destPath - Absolute path to save the jar
 * @returns {Promise<{build?: number|string, javaMajor?: number|null}>} Result metadata
 */
async function downloadServerJar(type, version, build, destPath) {
    const provider = getProvider(type);
    if (!provider) throw new Error(`Unknown server type: ${type}`);

    try {
        const result = (await provider.downloadJar(version, build, destPath)) || {};
        // Every non-custom type runs a real Minecraft version on the JVM.
        // Record the Java requirement Mojang publishes for it so ServerProcess
        // picks the right runtime — snapshot ids defeat the offline heuristic.
        if (type !== 'custom' && result.javaMajor == null) {
            result.javaMajor = await lookupMojangJavaMajor(version);
        }
        return result;
    } catch (err) {
        if (err instanceof ChecksumMismatchError) {
            try {
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                    log('warn', `Deleted ${destPath} after checksum mismatch.`);
                }
            } catch (cleanupErr) {
                log('warn', `Failed to delete ${destPath} after checksum mismatch: ${cleanupErr.message}`);
            }
        }
        throw err;
    }
}

/**
 * Download the vanilla Minecraft server jar (backward compat).
 */
async function downloadVanillaJar(version, destPath) {
    return downloadServerJar('vanilla', version, null, destPath);
}

module.exports = { downloadServerJar, downloadVanillaJar };
