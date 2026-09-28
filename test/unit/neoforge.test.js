// NeoForge names its builds after the Minecraft version they target, and
// that naming changed with Minecraft's year-based versions. The mapping is
// private to the module, so these drive it through listVersions/getBuilds
// with Maven's version list stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const neoforge = require('../../src/mc/serverTypes/neoforge');
const { relabelLegacyVersion } = neoforge;

const MAVEN_VERSIONS = [
    '20.2.3-beta',
    '20.4.237',
    '20.6.119',
    '21.0.167',
    '21.1.1', '21.1.95', '21.1.100',
    '21.9.16-beta', '21.9.16',
    '0.25w14craftmine.3-beta',
    '26.1.0.7',
    '26.1.1.3',
    '26.1.2.112',
    '26.2.0.88-beta'
];

test.beforeEach((t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
        assert.match(String(url), /maven\.neoforged\.net\/api\/maven\/versions\/releases\/net\/neoforged\/neoforge$/);
        return { ok: true, status: 200, json: async () => ({ versions: MAVEN_VERSIONS }) };
    });
});

test('builds are listed under the Minecraft version they target', async () => {
    const { versions, latest } = await neoforge.listVersions();
    assert.deepEqual(versions.map((v) => v.id), ['26.1.2', '26.1.1', '26.1', '1.21.9', '1.21.1', '1.21', '1.20.6', '1.20.4']);
    assert.ok(versions.every((v) => v.channel === 'stable'));
    assert.equal(latest, '26.1.2');
});

test('versions with only beta builds appear on the "all" channel', async () => {
    const { versions, latest } = await neoforge.listVersions({ channel: 'all' });
    const channel = Object.fromEntries(versions.map((v) => [v.id, v.channel]));
    assert.equal(channel['26.2'], 'beta');
    assert.equal(channel['1.20.2'], 'beta');
    assert.equal(channel['1.21.9'], 'stable', 'a version with a stable build is stable');
    assert.equal(versions[0].id, '26.2');
    assert.equal(latest, '26.1.2', 'latest is never a beta');
    assert.ok(!versions.some((v) => /craftmine|^0\./.test(v.id)), 'April Fools builds excluded');
});

test('getBuilds lists one version\'s builds, newest first', async () => {
    assert.deepEqual((await neoforge.getBuilds('1.21.1')).map((b) => b.build), ['21.1.100', '21.1.95', '21.1.1']);
    assert.deepEqual(await neoforge.getBuilds('1.21.9'), [
        { build: '21.9.16', channel: 'release' },
        { build: '21.9.16-beta', channel: 'beta' }
    ]);
    assert.deepEqual((await neoforge.getBuilds('26.1')).map((b) => b.build), ['26.1.0.7']);
    assert.deepEqual((await neoforge.getBuilds('26.1.2')).map((b) => b.build), ['26.1.2.112']);
    assert.deepEqual((await neoforge.getBuilds('1.21')).map((b) => b.build), ['21.0.167']);
});

test('getBuilds accepts a pre-1.2.1 "1.26.x" label', async () => {
    assert.deepEqual((await neoforge.getBuilds('1.26.1')).map((b) => b.build), ['26.1.0.7']);
});

test('relabelLegacyVersion reads the real version off the build', () => {
    assert.equal(relabelLegacyVersion('1.26.1', '26.1.2.112'), '26.1.2');
    assert.equal(relabelLegacyVersion('1.26.1', '26.1.0.7'), '26.1');
    assert.equal(relabelLegacyVersion('1.26.1'), '26.1');
    assert.equal(relabelLegacyVersion('1.26.2', '21.1.5'), '26.2', 'a build in another form is ignored');
});

test('relabelLegacyVersion leaves real versions alone', () => {
    assert.equal(relabelLegacyVersion('1.21.1', '21.1.95'), '1.21.1');
    assert.equal(relabelLegacyVersion('26.1', '26.1.0.7'), '26.1');
    assert.equal(relabelLegacyVersion('26.1.2', '26.1.2.112'), '26.1.2');
    assert.equal(relabelLegacyVersion(null), null);
});
