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

module.exports = { MC_VERSION_RE, isReleaseVersion };
