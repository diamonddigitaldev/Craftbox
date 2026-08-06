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

/**
 * Compare two build identifiers. Returns >0 when `a` is newer than `b`, <0 when
 * older, 0 when equivalent or not comparable.
 *
 * Providers use two different shapes for `build`: Paper/Purpur/Folia report an
 * integer build number, while Forge/NeoForge/Fabric report a dotted version
 * string ("21.1.95", "0.16.9"). Comparing those with `>` compares them as text,
 * so "21.1.100" > "21.1.95" is false and a genuine upgrade goes undetected —
 * which is why an upgrade check appeared to work for some builds but not others.
 * @param {number|string|null} a
 * @param {number|string|null} b
 */
function compareBuilds(a, b) {
    if (a == null || b == null) return 0;

    const aNum = Number(a);
    const bNum = Number(b);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;

    // Dotted versions: compare segment by segment, numerically where both
    // segments are numeric. A missing segment counts as 0, so "21.1" < "21.1.1".
    const aParts = String(a).split(/[.\-+]/);
    const bParts = String(b).split(/[.\-+]/);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const ap = aParts[i] ?? '0';
        const bp = bParts[i] ?? '0';
        const an = Number(ap);
        const bn = Number(bp);
        if (Number.isFinite(an) && Number.isFinite(bn)) {
            if (an !== bn) return an - bn;
        } else if (ap !== bp) {
            return ap < bp ? -1 : 1;
        }
    }
    return 0;
}

module.exports = { classifyMcId, pickPreferredBuild, compareBuilds };
