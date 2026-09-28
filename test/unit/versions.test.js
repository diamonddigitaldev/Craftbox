const test = require('node:test');
const assert = require('node:assert/strict');
const { MC_VERSION_RE, isReleaseVersion, isAtLeast } = require('../../src/utils/mcVersion');
const { classifyMcId, pickLatestBuild, compareBuilds } = require('../../src/mc/serverTypes/_channels');
const { worldTypesFor, worldTypeFor, firstStartProperties } = require('../../src/mc/worldTypes');

test('MC_VERSION_RE accepts every id form Mojang uses', () => {
    for (const v of ['1.21.4', '1.21', '26.1', '1.21.5-pre1', '1.21.5-rc2', '25w03a', '23w13a_or_b', '1.14 Pre-Release 5', 'b1.7.3']) {
        assert.ok(MC_VERSION_RE.test(v), v);
    }
});

test('MC_VERSION_RE refuses anything path- or URL-breaking', () => {
    for (const v of ['', '../1.21', '1.21/evil', '1.21?x=1', '1.21#x', ' 1.21', '-1.21', '.1.21', 'a'.repeat(65), '1.21\n']) {
        assert.ok(!MC_VERSION_RE.test(v), JSON.stringify(v));
    }
});

test('isReleaseVersion matches plain releases only', () => {
    for (const v of ['1.21', '1.21.4', '26.1', '26.1.2']) assert.ok(isReleaseVersion(v), v);
    for (const v of ['1.21.5-pre1', '25w03a', '1.14 Pre-Release 5', '', undefined, null, '1']) assert.ok(!isReleaseVersion(v), String(v));
});

test('isAtLeast compares releases numerically', () => {
    assert.equal(isAtLeast('1.19.3', '1.19.3', '22w42a'), true);
    assert.equal(isAtLeast('1.19.2', '1.19.3', '22w42a'), false);
    assert.equal(isAtLeast('1.20', '1.19.3', '22w42a'), true);
    assert.equal(isAtLeast('1.19', '1.19.0', '22w11a'), true);
    assert.equal(isAtLeast('1.9', '1.19', '22w11a'), false, '1.9 is not after 1.19');
    assert.equal(isAtLeast('1.10', '1.9', '15w31a'), true, '1.10 is after 1.9');
    assert.equal(isAtLeast('26.1', '1.19.3', '22w42a'), true);
});

test('isAtLeast places snapshots, pre-releases and unknown forms', () => {
    assert.equal(isAtLeast('22w42a', '1.19.3', '22w42a'), true);
    assert.equal(isAtLeast('22w45a', '1.19.3', '22w42a'), true);
    assert.equal(isAtLeast('22w40a', '1.19.3', '22w42a'), false);
    assert.equal(isAtLeast('26w14a', '1.19.3', '22w42a'), true);
    assert.equal(isAtLeast('1.19.3-pre1', '1.19.3', '22w42a'), true, 'a pre-release counts as its release');
    assert.equal(isAtLeast('1.19.3-rc2', '1.19.3', '22w42a'), true);
    assert.equal(isAtLeast('1.19.2-pre1', '1.19.3', '22w42a'), false);
    assert.equal(isAtLeast('1.14 Pre-Release 5', '1.14', '18w43a'), true);
    assert.equal(isAtLeast('', '1.19.3', '22w42a'), true, 'a custom jar counts as current');
    assert.equal(isAtLeast('something-odd', '1.19.3', '22w42a'), true);
});

test('classifyMcId names the channel of a non-release id', () => {
    assert.equal(classifyMcId('1.21.5-pre1'), 'pre-release');
    assert.equal(classifyMcId('1.14 Pre-Release 5'), 'pre-release');
    assert.equal(classifyMcId('1.21.5-rc2'), 'rc');
    assert.equal(classifyMcId('25w03a'), 'snapshot');
});

test('pickLatestBuild takes the head of a newest-first list', () => {
    assert.equal(pickLatestBuild([]), null);
    assert.equal(pickLatestBuild(null), null);
    assert.deepEqual(pickLatestBuild([{ build: 3 }, { build: 2 }]), { build: 3 });
});

test('compareBuilds orders numbers and dotted versions', () => {
    const newer = (a, b) => assert.ok(compareBuilds(a, b) > 0 && compareBuilds(b, a) < 0, `${a} > ${b}`);
    newer(100, 99);
    newer('100', '99');
    newer('21.1.100', '21.1.95');
    newer('0.16.10', '0.16.9');
    newer('47.4.23', '47.4.10');
    newer('21.9.16', '21.9.16-beta');
    newer('21.1.1', '21.1');
    newer('26.1.2.112', '26.1.1.3');
    assert.equal(compareBuilds('21.1.95', '21.1.95'), 0);
    assert.equal(compareBuilds(null, 5), 0);
    assert.equal(compareBuilds(5, undefined), 0);
});

test('world types use presets from 1.19 and legacy names before', () => {
    assert.equal(worldTypesFor('1.18.2')[0].value, 'default');
    assert.equal(worldTypesFor('22w10a')[0].value, 'default');
    assert.equal(worldTypesFor('1.19')[0].value, 'minecraft:normal');
    assert.equal(worldTypesFor('22w11a')[0].value, 'minecraft:normal');
    assert.equal(worldTypesFor('26.1')[0].value, 'minecraft:normal');
});

test('worldTypeFor translates a type into the spelling a version reads', () => {
    assert.equal(worldTypeFor('flat', '1.21.1'), 'minecraft:flat');
    assert.equal(worldTypeFor('minecraft:flat', '1.18.2'), 'flat');
    assert.equal(worldTypeFor('default', '1.21.1'), 'minecraft:normal');
    assert.equal(worldTypeFor('LARGEBIOMES', '1.16.5'), 'largeBiomes');
    assert.equal(worldTypeFor('DEFAULT', '1.12.2'), 'default');
    assert.equal(worldTypeFor('minecraft:single_biome_surface', '1.16.5'), null, 'no Single Biome before 1.19');
    assert.equal(worldTypeFor('bogus', '1.21.1'), null);
    assert.equal(worldTypeFor('', '1.21.1'), null);
});

test('firstStartProperties matches what each version writes itself', () => {
    assert.deepEqual(firstStartProperties('1.16.5'), { hardcore: false, 'level-type': 'default', 'generator-settings': '' });
    assert.deepEqual(firstStartProperties('1.18.2'), { hardcore: false, 'level-type': 'default', 'generator-settings': '{}' });
    assert.deepEqual(firstStartProperties('1.19.2'), { hardcore: false, 'level-type': 'minecraft:normal', 'generator-settings': '{}' });
    assert.deepEqual(firstStartProperties('1.19.3'), {
        hardcore: false, 'level-type': 'minecraft:normal', 'generator-settings': '{}',
        'initial-enabled-packs': 'vanilla', 'initial-disabled-packs': ''
    });
});
