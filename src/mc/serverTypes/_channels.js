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

/**
 * Pick the build to install when the caller didn't specify one: the newest
 * build the provider published for that Minecraft version.
 *
 * This used to prefer the newest build on a "stable" channel, which on Forge
 * meant the *recommended* promotion rather than the newest one — MC 1.20.1
 * installed 47.4.10 while Forge had long since shipped 47.4.23. The same
 * choice drives the upgrade check, so a server sitting on the recommended
 * build was also reported up to date forever. Craftbox now tracks the newest
 * build for every loader; a version's channel still decides whether the
 * version itself is offered, which is the knob users actually asked for.
 *
 * Every provider returns builds newest-first, so the newest is the head of
 * the list.
 * @param {Array<{build: *, channel?: string}>} builds - newest-first
 */
function pickLatestBuild(builds) {
    if (!Array.isArray(builds) || builds.length === 0) return null;
    return builds[0];
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
    // segments are numeric.
    const aParts = String(a).split(/[.\-+]/);
    const bParts = String(b).split(/[.\-+]/);
    const shared = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < shared; i++) {
        const ap = aParts[i];
        const bp = bParts[i];
        const an = Number(ap);
        const bn = Number(bp);
        if (Number.isFinite(an) && Number.isFinite(bn)) {
            if (an !== bn) return an - bn;
        } else if (ap !== bp) {
            return ap < bp ? -1 : 1;
        }
    }

    // Equal as far as both go. Trailing segments decide: a numeric tail is a
    // further revision and wins ("21.1" < "21.1.1"), while a word tail is a
    // pre-release marker and loses ("21.9.16-beta" < "21.9.16"). Getting this
    // backwards let NeoForge sort a beta ahead of the release it precedes.
    const tail = aParts.length > bParts.length ? aParts : bParts;
    if (tail.length === shared) return 0;
    const sign = aParts.length > bParts.length ? 1 : -1;
    return Number.isFinite(Number(tail[shared])) ? sign : -sign;
}

module.exports = { classifyMcId, pickLatestBuild, compareBuilds };
