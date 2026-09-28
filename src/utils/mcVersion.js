/**
 * Minecraft version string helpers shared by the API routes.
 *
 * MC_VERSION_RE accepts release ids (1.21.4), pre/rc ids (1.21.5-pre1),
 * snapshot ids (25w03a, 23w13a_or_b) and Mojang's legacy long forms
 * ("1.14 Pre-Release 5"). The charset is deliberately conservative: version
 * strings never build filesystem paths, but they do appear in provider URLs
 * and exact-match lookups, so nothing URL- or path-breaking is allowed.
 */
const MC_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,63}$/;

// Plain release format (1.21 / 1.21.4 / 26.2) — these ids order numerically.
const RELEASE_RE = /^\d+\.\d+(\.\d+)?$/;

function isReleaseVersion(v) {
    return RELEASE_RE.test(String(v || ''));
}

const SNAPSHOT_RE = /^(\d{2})w(\d{2})/;

/**
 * Whether `version` is `release` or newer. Snapshot ids compare against
 * `firstSnapshot`, the snapshot that opened `release`'s cycle; pre-release and
 * rc ids count as their release. A blank version (a custom jar) or one in no
 * known form is taken as current, since Craftbox tracks newer servers.
 *
 * @param {string} version - e.g. "1.18.2", "26.1", "22w45a", "1.19.3-pre1"
 * @param {string} release - e.g. "1.19.3"
 * @param {string} firstSnapshot - e.g. "22w42a"
 */
function isAtLeast(version, release, firstSnapshot) {
    const v = String(version || '').trim();
    const snapshot = SNAPSHOT_RE.exec(v);
    if (snapshot) {
        const [, year, week] = snapshot;
        const [, firstYear, firstWeek] = SNAPSHOT_RE.exec(firstSnapshot);
        return Number(year) * 100 + Number(week) >= Number(firstYear) * 100 + Number(firstWeek);
    }
    const cleaned = v.replace(/[ _-]?(?:pre|rc).*$/i, '');
    if (!isReleaseVersion(cleaned)) return true;
    const a = cleaned.split('.').map(Number);
    const b = release.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff > 0;
    }
    return true;
}

module.exports = { MC_VERSION_RE, isReleaseVersion, isAtLeast };
