const crypto = require('crypto');

// Distinct error class for the "we computed the hash and it didn't match"
// case, so callers (e.g. downloader.js) can react with deletion of the
// destination file. Other failure modes — missing/malformed checksum from
// upstream — throw a plain Error and are treated as "couldn't verify"
// rather than "actively detected tampering".
class ChecksumMismatchError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ChecksumMismatchError';
    }
}

// Verify a downloaded buffer against an expected hex checksum sourced from
// the upstream API or a sidecar file. Throws on mismatch so the caller
// never writes a tampered/corrupted payload to disk.
//
// Tolerates the two common sidecar formats:
//   `<hex>\n`
//   `<hex>  <filename>\n`   (Maven / coreutils style)
//
// `algo` must be one of 'sha256' | 'sha1' | 'md5'. MD5 is intentionally
// supported because Purpur publishes nothing stronger; it still defeats
// casual MITM / mirror corruption, just not a determined collision attack.
function verifyChecksum(buffer, algo, expectedHex, label) {
    if (!expectedHex || typeof expectedHex !== 'string') {
        throw new Error(`${label}: missing checksum from upstream — cannot verify integrity.`);
    }
    const expected = expectedHex.trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]+$/.test(expected)) {
        throw new Error(`${label}: malformed checksum from upstream — cannot verify integrity.`);
    }
    const actual = crypto.createHash(algo).update(buffer).digest('hex').toLowerCase();
    if (actual !== expected) {
        throw new ChecksumMismatchError(`${label}: ${algo.toUpperCase()} checksum mismatch (expected ${expected}, got ${actual}). Refusing to install.`);
    }
}

// A Maven repository publishes checksum sidecars beside each artifact, but
// not always the same set: Forge's has only .sha1 and .md5 for many older
// installers (1.12.2, 1.14.4 and 1.15.2 among them). Verify against the
// strongest one published, moving on only when a sidecar is missing (404).
// Any other failure, or no sidecar at all, refuses the download rather than
// installing something unverified. Returns the algorithm used.
const MAVEN_SIDECARS = [['sha256', '.sha256'], ['sha1', '.sha1'], ['md5', '.md5']];

async function verifyMavenChecksum(buffer, artifactUrl, label) {
    for (const [algo, ext] of MAVEN_SIDECARS) {
        const res = await fetch(artifactUrl + ext);
        if (res.status === 404) continue;
        if (!res.ok) {
            throw new Error(`Could not fetch ${label} installer checksum: HTTP ${res.status}.`);
        }
        verifyChecksum(buffer, algo, await res.text(), label);
        return algo;
    }
    throw new Error(`${label}: no checksum published for the installer — cannot verify integrity.`);
}

module.exports = { verifyChecksum, verifyMavenChecksum, ChecksumMismatchError };
