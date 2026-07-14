/**
 * Shared helpers for version/build release channels.
 *
 * Normalized version channels exposed through the API:
 *   'stable' | 'snapshot' | 'pre-release' | 'rc' | 'beta' | 'experimental'
 */

/**
 * Classify a non-release Minecraft version id into a channel.
 * "1.21.5-pre1" → 'pre-release', "1.21.5-rc2" → 'rc', "25w03a" → 'snapshot'.
 * Also matches Mojang's legacy long forms ("1.14 Pre-Release 5").
 */
function classifyMcId(id) {
    if (/-pre|\bpre-?release\b/i.test(id)) return 'pre-release';
    if (/-rc|\brelease candidate\b/i.test(id)) return 'rc';
    return 'snapshot';
}

// Channel labels that count as "stable" across upstream APIs:
// PaperMC Fill uses STABLE, NeoForge/Purpur use release/default,
// Forge promotions use recommended/latest.
const STABLE_BUILD_CHANNELS = new Set(['stable', 'release', 'recommended', 'latest', 'default']);

/**
 * Pick the build to install when the caller didn't specify one.
 * Prefers the newest stable-channel build; a version whose builds are all
 * non-stable (e.g. experimental Paper versions with only ALPHA builds)
 * falls back to the newest build so it stays installable.
 * @param {Array<{build: *, channel?: string}>} builds - newest-first
 */
function pickPreferredBuild(builds) {
    if (!Array.isArray(builds) || builds.length === 0) return null;
    const stable = builds.find(b => STABLE_BUILD_CHANNELS.has(String(b.channel || '').toLowerCase()));
    return stable || builds[0];
}

module.exports = { classifyMcId, pickPreferredBuild };
