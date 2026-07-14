const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';

/**
 * Best-effort lookup of the Java runtime major version Mojang publishes for
 * a Minecraft version id (release or snapshot). Returns null when the id is
 * not in the manifest or the lookup fails — callers fall back to the offline
 * heuristic in utils/javaVersion.js. Never throws.
 *
 * @param {string} versionId - exact Mojang version id, e.g. "1.21.4", "25w03a"
 * @returns {Promise<number|null>}
 */
async function lookupMojangJavaMajor(versionId) {
    try {
        const res = await fetch(VERSION_MANIFEST_URL);
        if (!res.ok) return null;
        const manifest = await res.json();

        const entry = (manifest.versions || []).find(v => v.id === versionId);
        if (!entry) return null;

        const detailRes = await fetch(entry.url);
        if (!detailRes.ok) return null;
        const detail = await detailRes.json();

        return detail.javaVersion?.majorVersion || null;
    } catch {
        return null;
    }
}

module.exports = { lookupMojangJavaMajor, VERSION_MANIFEST_URL };
