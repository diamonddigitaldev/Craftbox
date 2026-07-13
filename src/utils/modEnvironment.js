const fs = require('fs');
const path = require('path');
const { modMetadataDb } = require('../db');
const { log } = require('./log');
const { getContentType } = require('./contentType');

const DISABLED_SUFFIX = '.disabled';
const VALID_ENVS = ['both', 'client', 'server'];

function isModServerType(serverType) {
    const ct = getContentType(serverType);
    return !!ct && ct.label === 'Mods';
}

async function getModEnvMap(serverId) {
    const map = await modMetadataDb.get(`modmeta_${serverId}`);
    return map && typeof map === 'object' ? map : {};
}

async function getModEnv(serverId, filename) {
    const map = await getModEnvMap(serverId);
    return map[filename] || 'both';
}

async function setModEnvMap(serverId, map) {
    if (!map || Object.keys(map).length === 0) {
        await modMetadataDb.delete(`modmeta_${serverId}`);
    } else {
        await modMetadataDb.set(`modmeta_${serverId}`, map);
    }
}

async function clearModEnv(serverId, filename) {
    const map = await getModEnvMap(serverId);
    if (filename in map) {
        delete map[filename];
        await setModEnvMap(serverId, map);
    }
}

async function clearAllModEnv(serverId) {
    await modMetadataDb.delete(`modmeta_${serverId}`);
}

async function copyModEnvMap(sourceId, newId) {
    const map = await getModEnvMap(sourceId);
    if (Object.keys(map).length > 0) {
        await modMetadataDb.set(`modmeta_${newId}`, { ...map });
    }
}

function enableOnDisk(contentDir, filename) {
    const enabledPath = path.join(contentDir, filename);
    const disabledPath = enabledPath + DISABLED_SUFFIX;
    if (fs.existsSync(disabledPath) && !fs.existsSync(enabledPath)) {
        fs.renameSync(disabledPath, enabledPath);
    }
}

function disableOnDisk(contentDir, filename) {
    const enabledPath = path.join(contentDir, filename);
    const disabledPath = enabledPath + DISABLED_SUFFIX;
    if (fs.existsSync(enabledPath) && !fs.existsSync(disabledPath)) {
        fs.renameSync(enabledPath, disabledPath);
    }
}

async function setModEnv(serverId, filename, env, contentDir) {
    if (!VALID_ENVS.includes(env)) {
        throw new Error(`Invalid environment value: ${env}`);
    }
    const map = await getModEnvMap(serverId);

    if (env === 'client') {
        disableOnDisk(contentDir, filename);
        map[filename] = 'client';
    } else if (env === 'server') {
        enableOnDisk(contentDir, filename);
        map[filename] = 'server';
    } else {
        enableOnDisk(contentDir, filename);
        delete map[filename];
    }

    await setModEnvMap(serverId, map);
}

function listModFiles(contentDir) {
    let entries;
    try {
        entries = fs.readdirSync(contentDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const results = [];
    for (const entry of entries) {
        if (entry.isDirectory()) continue;
        const name = entry.name;
        const lower = name.toLowerCase();

        let displayName;
        let isDisabled;
        if (lower.endsWith('.jar')) {
            displayName = name;
            isDisabled = false;
        } else if (lower.endsWith('.jar' + DISABLED_SUFFIX)) {
            displayName = name.slice(0, -DISABLED_SUFFIX.length);
            isDisabled = true;
        } else {
            continue;
        }

        let stat;
        try { stat = fs.statSync(path.join(contentDir, name)); } catch { continue; }

        results.push({
            displayName,
            onDiskName: name,
            isDisabled,
            size: stat.size,
            modified: stat.mtime
        });
    }
    return results.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function reconcileModFiles(serverId, serverDir, serverType) {
    if (!isModServerType(serverType)) return;

    const contentDir = path.join(serverDir, 'mods');
    if (!fs.existsSync(contentDir)) return;

    const map = await getModEnvMap(serverId);
    let changed = false;

    for (const filename of Object.keys(map)) {
        const env = map[filename];
        const enabledPath = path.join(contentDir, filename);
        const disabledPath = enabledPath + DISABLED_SUFFIX;
        const hasEnabled = fs.existsSync(enabledPath);
        const hasDisabled = fs.existsSync(disabledPath);

        if (!hasEnabled && !hasDisabled) {
            delete map[filename];
            changed = true;
            continue;
        }

        if (env === 'client' && hasEnabled) {
            try {
                if (hasDisabled) fs.unlinkSync(enabledPath);
                else fs.renameSync(enabledPath, disabledPath);
                log('info', `[reconcile ${serverId}] Disabled client-only mod: ${filename}`);
            } catch (err) {
                log('warn', `[reconcile ${serverId}] Failed to disable ${filename}: ${err.message}`);
            }
        } else if (env === 'server' && hasDisabled) {
            try {
                if (hasEnabled) fs.unlinkSync(disabledPath);
                else fs.renameSync(disabledPath, enabledPath);
                log('info', `[reconcile ${serverId}] Re-enabled server mod: ${filename}`);
            } catch (err) {
                log('warn', `[reconcile ${serverId}] Failed to re-enable ${filename}: ${err.message}`);
            }
        }
    }

    if (changed) {
        await setModEnvMap(serverId, map);
    }
}

module.exports = {
    VALID_ENVS,
    DISABLED_SUFFIX,
    isModServerType,
    getModEnvMap,
    setModEnvMap,
    getModEnv,
    setModEnv,
    clearModEnv,
    clearAllModEnv,
    copyModEnvMap,
    listModFiles,
    reconcileModFiles
};
