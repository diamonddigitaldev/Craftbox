// World Type (server.properties `level-type`) and the other settings Minecraft
// only reads when it generates a new world. Values are unescaped, as
// parseServerProperties returns them; Minecraft reads a bare colon the same.
const { isAtLeast } = require('../utils/mcVersion');

// Minecraft 1.19 replaced world types with namespaced world presets. It reads
// none of the old names it doesn't happen to share: `largeBiomes` or `default`
// on a 1.19+ server generates a normal world, and `minecraft:flat` on 1.18 does
// the same.
const WORLD_PRESETS = [
    { value: 'minecraft:normal', label: 'Normal' },
    { value: 'minecraft:flat', label: 'Flat' },
    { value: 'minecraft:large_biomes', label: 'Large Biomes' },
    { value: 'minecraft:amplified', label: 'Amplified' },
    { value: 'minecraft:single_biome_surface', label: 'Single Biome' }
];
const LEGACY_WORLD_TYPES = [
    { value: 'default', label: 'Normal' },
    { value: 'flat', label: 'Flat' },
    { value: 'largeBiomes', label: 'Large Biomes' },
    { value: 'amplified', label: 'Amplified' }
];

const usesPresets = (version) => isAtLeast(version, '1.19', '22w11a');

/** The World Type options a server on `version` understands, default first. */
function worldTypesFor(version) {
    return usesPresets(version) ? WORLD_PRESETS : LEGACY_WORLD_TYPES;
}

/**
 * A world type in the form `version` reads, matched by what it is rather than
 * how it's spelt (`flat` ↔ `minecraft:flat`). Null for a value that is no world
 * type Craftbox knows, or one the version has no equivalent of (Single Biome
 * before 1.19).
 */
function worldTypeFor(value, version) {
    const wanted = String(value || '').trim().toLowerCase();
    const known = [...WORLD_PRESETS, ...LEGACY_WORLD_TYPES].find(t => t.value.toLowerCase() === wanted);
    if (!known) return null;
    return worldTypesFor(version).find(t => t.label === known.label)?.value || null;
}

/**
 * Settings Minecraft only reads when it generates a new world, with the
 * defaults `version` writes itself. Written into a new server's
 * server.properties so they can be set before the first start, since some
 * versions (1.17) never write them at all.
 */
function firstStartProperties(version) {
    const props = {
        'hardcore': false,
        'level-type': worldTypesFor(version)[0].value,
        'generator-settings': isAtLeast(version, '1.18', '21w37a') ? '{}' : ''
    };
    if (isAtLeast(version, '1.19.3', '22w42a')) {
        props['initial-enabled-packs'] = 'vanilla';
        props['initial-disabled-packs'] = '';
    }
    return props;
}

module.exports = { WORLD_PRESETS, LEGACY_WORLD_TYPES, worldTypesFor, worldTypeFor, firstStartProperties };
