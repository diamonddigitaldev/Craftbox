const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');
const pkg = require('../../package.json');

const USER_AGENT = `Craftbox/${pkg.version} (github.com/diamonddigitaldev/Craftbox)`;

// Hosts a Modrinth modpack is allowed to pull files from (the .mrpack spec
// whitelist), plus objects.githubusercontent.com — github.com release-asset
// links redirect there, so the post-redirect check needs it too.
const DOWNLOAD_HOST_WHITELIST = new Set([
    'cdn.modrinth.com',
    'github.com',
    'raw.githubusercontent.com',
    'gitlab.com',
    'objects.githubusercontent.com'
]);

/**
 * Throws unless the URL is https and its host is on the download whitelist.
 * Returns the parsed URL for convenience.
 */
function assertWhitelistedUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid download URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') {
        throw new Error(`Refusing non-HTTPS download URL: ${url}`);
    }
    if (!DOWNLOAD_HOST_WHITELIST.has(parsed.hostname.toLowerCase())) {
        throw new Error(`Download host not allowed: ${parsed.hostname}`);
    }
    return parsed;
}

/**
 * Streaming file download with size cap and optional checksum verification.
 * The whole transfer streams to disk — nothing is buffered in memory — and a
 * failed or over-cap download never leaves a partial file behind.
 *
 * @param {string} url
 * @param {string} destPath - Absolute path to write to (parent dirs created)
 * @param {object} [opts]
 * @param {number}  [opts.maxBytes] - Abort + unlink past this many bytes
 * @param {string}  [opts.sha512] - Expected hex digest; mismatch unlinks + throws
 * @param {string}  [opts.sha1] - Fallback digest when no sha512 is available
 * @param {object}  [opts.headers] - Extra request headers (UA is always set)
 * @param {number}  [opts.timeoutMs] - Whole-transfer timeout (default 120s)
 * @param {boolean} [opts.enforceWhitelist] - Check host before AND after redirects
 * @returns {Promise<{bytes: number}>}
 */
async function downloadToFile(url, destPath, opts = {}) {
    const {
        maxBytes = Infinity,
        sha512 = null,
        sha1 = null,
        headers = {},
        timeoutMs = 120000,
        enforceWhitelist = false
    } = opts;
    const label = path.basename(destPath);

    if (enforceWhitelist) assertWhitelistedUrl(url);

    let res;
    try {
        res = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, ...headers },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (err) {
        const reason = err && err.name === 'TimeoutError' ? 'timed out' : (err.message || String(err));
        throw new Error(`Download failed for ${label}: ${reason}`);
    }
    if (!res.ok) throw new Error(`Download failed for ${label}: HTTP ${res.status}`);
    // Redirect hardening: the URL we validated is not necessarily the one that
    // answered. res.url is the final URL after redirects.
    if (enforceWhitelist && res.url) assertWhitelistedUrl(res.url);
    if (!res.body) throw new Error(`Download failed for ${label}: empty response body`);

    const algo = sha512 ? 'sha512' : (sha1 ? 'sha1' : null);
    const expected = (sha512 || sha1 || '').toLowerCase();
    const hash = algo ? crypto.createHash(algo) : null;
    let received = 0;
    const meter = new Transform({
        transform(chunk, _enc, cb) {
            received += chunk.length;
            if (received > maxBytes) {
                return cb(new Error(`Download of ${label} exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`));
            }
            if (hash) hash.update(chunk);
            cb(null, chunk);
        }
    });

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(destPath));
        if (hash && hash.digest('hex') !== expected) {
            throw new Error(`Checksum mismatch for ${label}`);
        }
    } catch (err) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        if (err && err.name === 'TimeoutError') {
            throw new Error(`Download failed for ${label}: timed out`);
        }
        throw err;
    }
    return { bytes: received };
}

module.exports = { downloadToFile, assertWhitelistedUrl, USER_AGENT, DOWNLOAD_HOST_WHITELIST };
