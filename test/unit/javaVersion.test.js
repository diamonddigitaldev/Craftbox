const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { getRequiredJavaVersion, getJavaForMajor, TEMURIN_PATHS } = require('../../src/utils/javaVersion');

test('releases map to the Java they need', () => {
    const cases = {
        '1.7.10': 8, '1.12.2': 8, '1.16.5': 8,
        '1.17': 17, '1.17.1': 17, '1.18.2': 17, '1.20.4': 17,
        '1.20.5': 21, '1.20.6': 21, '1.21': 21, '1.21.1': 21, '1.21.11': 21,
        '26.1': 25, '26.1.2': 25, '27.1': 25
    };
    for (const [version, java] of Object.entries(cases)) {
        assert.equal(getRequiredJavaVersion(version), java, version);
    }
});

test('pre-releases and release candidates need their release\'s Java', () => {
    assert.equal(getRequiredJavaVersion('1.20.5-pre1'), 21);
    assert.equal(getRequiredJavaVersion('1.20.5-rc1'), 21);
    assert.equal(getRequiredJavaVersion('1.17-pre1'), 17);
    assert.equal(getRequiredJavaVersion('1.14 Pre-Release 5'), 8);
});

test('snapshots map by year', () => {
    assert.equal(getRequiredJavaVersion('20w45a'), 8);
    assert.equal(getRequiredJavaVersion('21w37a'), 17);
    assert.equal(getRequiredJavaVersion('23w51b'), 17);
    assert.equal(getRequiredJavaVersion('24w14a'), 21);
    assert.equal(getRequiredJavaVersion('25w03a'), 21);
    assert.equal(getRequiredJavaVersion('26w14a'), 25);
});

test('NeoForge\'s pseudo 1.26+ ids are the year-based era', () => {
    assert.equal(getRequiredJavaVersion('1.26.1'), 25);
});

test('no version (a custom jar) gets the newest Java', () => {
    for (const v of [undefined, null, '', 26]) assert.equal(getRequiredJavaVersion(v), 25, String(v));
});

test('the image\'s JREs are all known', () => {
    assert.deepEqual(Object.keys(TEMURIN_PATHS).map(Number), [8, 17, 21, 25]);
    for (const p of Object.values(TEMURIN_PATHS)) assert.match(p, /^\/usr\/lib\/jvm\/temurin-\d+-jre-[a-z0-9]+\/bin\/java$/);
});

const hasTemurin = process.platform !== 'win32' && Object.values(TEMURIN_PATHS).some((p) => fs.existsSync(p));

test('outside the Docker image, Java comes from PATH', { skip: hasTemurin && 'running where the Temurin JREs are installed' }, () => {
    for (const major of [8, 17, 21, 25]) assert.equal(getJavaForMajor(major), 'java');
});
