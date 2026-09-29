const fs = require('fs');
const path = require('path');
const { firstStartProperties } = require('./worldTypes');
const { isAtLeast } = require('../utils/mcVersion');

// Before 1.14 Minecraft reads gamemode and difficulty as numbers. A name
// fails to parse, so the server quietly plays Survival on Easy and rewrites
// the file with those numbers. 1.14 onwards reads a number or a name, and
// rewrites a number as its name. (Probed on the real server jars, 1.8.9 to
// 26.3.) Craftbox keeps names everywhere else and writes numbers where the
// version needs them; 1.14's snapshots get numbers too, being read either way.
const MODE_NAMES = {
    gamemode: ['survival', 'creative', 'adventure', 'spectator'],
    difficulty: ['peaceful', 'easy', 'normal', 'hard']
};

function readsModeNames(version) {
    return isAtLeast(version, '1.14', '19w15a');
}

/** `props` with gamemode and difficulty in the form `version` reads. */
function modeValuesFor(props, version) {
    if (readsModeNames(version)) return props;
    const result = { ...props };
    for (const [key, names] of Object.entries(MODE_NAMES)) {
        const id = key in result ? names.indexOf(String(result[key])) : -1;
        if (id !== -1) result[key] = String(id);
    }
    return result;
}

/** A gamemode or difficulty value as its name, whichever form the file holds. */
function modeNameOf(key, value) {
    const text = String(value ?? '').trim();
    const names = MODE_NAMES[key];
    return names && /^\d$/.test(text) && names[Number(text)] ? names[Number(text)] : text;
}

const DEFAULT_PROPERTIES = {
    'server-port': 25565,
    'gamemode': 'survival',
    'difficulty': 'normal',
    'max-players': 20,
    'motd': 'A Minecraft Server',
    'online-mode': true,
    'pvp': true,
    'spawn-protection': 16,
    'view-distance': 10,
    'enable-command-block': false,
    'allow-flight': false,
    'level-name': 'world',
    'level-seed': '',
    'white-list': false,
    'enforce-whitelist': false,
    'spawn-npcs': true,
    'spawn-animals': true,
    'spawn-monsters': true,
    'generate-structures': true,
    'enable-query': false,
    'enable-rcon': false,
    'enable-status': true,
    'sync-chunk-writes': true,
    'simulation-distance': 10,
    'max-tick-time': 60000,
    'max-world-size': 29999984,
    'network-compression-threshold': 256,
    'rate-limit': 0,
    'entity-broadcast-range-percentage': 100
};

// Craftbox's defaults for a server on `version`, with the settings Minecraft
// only reads when it generates a world placed after the seed.
function defaultsFor(version) {
    const props = {};
    for (const [key, value] of Object.entries(DEFAULT_PROPERTIES)) {
        props[key] = value;
        if (key === 'level-seed') Object.assign(props, firstStartProperties(version));
    }
    return props;
}

// Map writeServerProperties overrides (camelCase keys, or raw kebab-case keys)
// to server.properties keys.
function resolveOverrides(overrides) {
    const props = {};
    if (overrides.serverPort !== undefined) props['server-port'] = overrides.serverPort;
    if (overrides.maxPlayers !== undefined) props['max-players'] = overrides.maxPlayers;
    if (overrides.motd !== undefined) props['motd'] = overrides.motd;
    if (overrides.gamemode !== undefined) props['gamemode'] = overrides.gamemode;
    if (overrides.difficulty !== undefined) props['difficulty'] = overrides.difficulty;
    if (overrides.viewDistance !== undefined) props['view-distance'] = overrides.viewDistance;
    if (overrides.levelSeed !== undefined) props['level-seed'] = overrides.levelSeed;
    if (overrides.levelType !== undefined) props['level-type'] = overrides.levelType;

    // Allow raw property overrides (`level-seed`, `rcon.password`)
    Object.entries(overrides).forEach(([key, value]) => {
        if (key.includes('-') || key.includes('.')) props[key] = value;
    });
    return props;
}

/**
 * Write a server.properties file to the given directory.
 * @param {string} serverDir - Path to the server directory
 * @param {object} overrides - Properties to override defaults
 * @param {object} [options]
 * @param {boolean} [options.mergeExisting] - Keep a server.properties already in
 *   the directory (e.g. one a modpack shipped): only the overrides are forced,
 *   and defaults fill in just the keys it leaves out.
 * @param {string} [options.version] - The server's Minecraft version, which
 *   decides the world-generation defaults (see worldTypes.js)
 */
function writeServerProperties(serverDir, overrides = {}, { mergeExisting = false, version = '' } = {}) {
    const managed = resolveOverrides(overrides);

    if (mergeExisting && fs.existsSync(path.join(serverDir, 'server.properties'))) {
        // Edit the existing lines in place rather than re-serialising parsed
        // values, which would drop escapes such as `minecraft\:normal` or the
        // unicode escapes Minecraft writes for a MOTD's colour codes.
        const existing = parseServerProperties(serverDir);
        const missingDefaults = {};
        for (const [key, value] of Object.entries(defaultsFor(version))) {
            if (!(key in existing)) missingDefaults[key] = value;
        }
        updateServerProperties(serverDir, { ...missingDefaults, ...managed }, { version });
        return;
    }

    const props = modeValuesFor({ ...defaultsFor(version), ...managed }, version);

    const lines = ['#Minecraft server properties', `#Generated by Craftbox on ${new Date().toISOString()}`];
    for (const [key, value] of Object.entries(props)) {
        lines.push(`${key}=${value}`);
    }

    fs.writeFileSync(path.join(serverDir, 'server.properties'), lines.join('\n') + '\n');
}

/**
 * Write eula.txt with eula=true.
 * @param {string} serverDir - Path to the server directory
 */
function writeEula(serverDir) {
    const content = [
        '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).',
        `#${new Date().toISOString()}`,
        'eula=true'
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(serverDir, 'eula.txt'), content);
}

/**
 * Parse an existing server.properties file into a key-value object.
 */
function parseServerProperties(serverDir) {
    const filePath = path.join(serverDir, 'server.properties');
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const props = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        // Java Properties ignores whitespace around the `=`, which hand-edited
        // files (a modpack's, say) sometimes have. Then unescape the Java
        // Properties escapes that MC's server adds on rewrite.
        props[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trimStart()
            .replace(/\\:/g, ':')
            .replace(/\\=/g, '=');
    }
    return props;
}

/**
 * Update specific keys in an existing server.properties file,
 * preserving comments and ordering.
 * @param {object} [options]
 * @param {string} [options.version] - The server's Minecraft version. Given,
 *   gamemode and difficulty are written in the form it reads (numbers before
 *   1.14); left out, they're written as given.
 */
function updateServerProperties(serverDir, updates, { version } = {}) {
    const filePath = path.join(serverDir, 'server.properties');
    if (!fs.existsSync(filePath)) return;
    if (version !== undefined) updates = modeValuesFor(updates, version);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const updatedKeys = new Set();

    const result = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return line;
        const key = trimmed.substring(0, eqIdx).trim();
        if (key in updates) {
            updatedKeys.add(key);
            return key + '=' + updates[key];
        }
        return line;
    });

    // Append new keys not already in the file, ahead of the final newline
    const trailingNewline = result.length > 1 && result[result.length - 1] === '';
    if (trailingNewline) result.pop();
    for (const [key, value] of Object.entries(updates)) {
        if (!updatedKeys.has(key)) {
            result.push(key + '=' + value);
        }
    }
    if (trailingNewline) result.push('');

    fs.writeFileSync(filePath, result.join('\n'));
}

module.exports = {
    writeServerProperties, writeEula, parseServerProperties, updateServerProperties, DEFAULT_PROPERTIES,
    modeValuesFor, modeNameOf
};
