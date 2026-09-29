// Forge and NeoForge installers are verified against a checksum sidecar on
// Maven before they run. Not every installer has every sidecar (Forge's
// 1.12.2 builds have no .sha256), so these drive the fallback with Maven
// stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyMavenChecksum, ChecksumMismatchError } = require('../../src/mc/serverTypes/_verifyChecksum');

const URL = 'https://maven.example/forge-installer.jar';
const INSTALLER = Buffer.from('installer bytes');
const hash = (algo) => crypto.createHash(algo).update(INSTALLER).digest('hex');

// Answer each sidecar URL from `sidecars` ({'.sha1': body or HTTP status}),
// recording what was asked for
function stubMaven(t, sidecars) {
    const asked = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
        const ext = String(url).slice(URL.length);
        asked.push(ext);
        const answer = sidecars[ext] ?? 404;
        if (typeof answer === 'number') return { ok: answer < 400, status: answer, text: async () => '' };
        return { ok: true, status: 200, text: async () => answer };
    });
    return asked;
}

test('uses the SHA-256 sidecar when there is one', async (t) => {
    const asked = stubMaven(t, { '.sha256': hash('sha256'), '.sha1': hash('sha1') });
    assert.equal(await verifyMavenChecksum(INSTALLER, URL, 'Forge'), 'sha256');
    assert.deepEqual(asked, ['.sha256']);
});

test('falls back to SHA-1, then MD5, when the stronger sidecars are missing', async (t) => {
    let asked = stubMaven(t, { '.sha1': `${hash('sha1')}  forge-installer.jar\n`, '.md5': hash('md5') });
    assert.equal(await verifyMavenChecksum(INSTALLER, URL, 'Forge'), 'sha1');
    assert.deepEqual(asked, ['.sha256', '.sha1']);

    t.mock.restoreAll();
    asked = stubMaven(t, { '.md5': hash('md5') });
    assert.equal(await verifyMavenChecksum(INSTALLER, URL, 'Forge'), 'md5');
    assert.deepEqual(asked, ['.sha256', '.sha1', '.md5']);
});

test('refuses when no sidecar is published', async (t) => {
    stubMaven(t, {});
    await assert.rejects(verifyMavenChecksum(INSTALLER, URL, 'Forge'), /no checksum published/);
});

test('refuses instead of falling back when a sidecar fails with anything but 404', async (t) => {
    const asked = stubMaven(t, { '.sha256': 503, '.sha1': hash('sha1') });
    await assert.rejects(verifyMavenChecksum(INSTALLER, URL, 'Forge'), /HTTP 503/);
    assert.deepEqual(asked, ['.sha256']);
});

test('refuses a mismatch in the sidecar it used, without trying a weaker one', async (t) => {
    const asked = stubMaven(t, { '.sha1': '0'.repeat(40), '.md5': hash('md5') });
    await assert.rejects(verifyMavenChecksum(INSTALLER, URL, 'Forge'), ChecksumMismatchError);
    assert.deepEqual(asked, ['.sha256', '.sha1']);
});
