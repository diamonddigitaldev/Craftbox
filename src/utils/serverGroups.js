const { serversDb, groupsDb } = require('../db');

// Same rules as server names: 1-50 chars, letters/numbers/spaces/hyphens/underscores.
const GROUP_NAME_REGEX = /^[a-zA-Z0-9 _\-]+$/;
const GROUP_NAME_MAX_LENGTH = 50;
const GROUP_NAME_ERROR = 'Group name must be 1-50 characters. Letters, numbers, spaces, hyphens, underscores.';
const GROUP_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_GROUP_COLOR = '#4caf50';

// Normalizes a raw group name. Blank input means "ungrouped" and maps to null.
// Returns { valid, value } — value is null for ungrouped, the trimmed name otherwise.
function normalizeGroupName(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { valid: true, value: null };
    if (trimmed.length > GROUP_NAME_MAX_LENGTH || !GROUP_NAME_REGEX.test(trimmed)) {
        return { valid: false, value: null };
    }
    return { valid: true, value: trimmed };
}

// Distinct group names across all servers, sorted case-insensitively.
// Groups exist implicitly — a group with no servers disappears.
async function getDistinctGroups() {
    const all = await serversDb.all();
    const names = new Set();
    for (const row of all) {
        const group = row.value?.group;
        if (typeof group === 'string' && group.trim()) names.add(group.trim());
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// Stored color for a group; groups without a record use the default.
async function getGroupColor(name) {
    const meta = await groupsDb.get(`group_${name}`);
    return (meta && GROUP_COLOR_REGEX.test(meta.color)) ? meta.color : DEFAULT_GROUP_COLOR;
}

async function setGroupColor(name, color) {
    await groupsDb.set(`group_${name}`, { name, color });
}

// All groups with color + server count, sorted case-insensitively by name.
async function getGroupsWithMeta() {
    const all = await serversDb.all();
    const counts = new Map();
    for (const row of all) {
        const group = row.value?.group;
        if (typeof group === 'string' && group.trim()) {
            const name = group.trim();
            counts.set(name, (counts.get(name) || 0) + 1);
        }
    }

    const metaRows = await groupsDb.all();
    const colors = new Map();
    for (const row of metaRows) {
        const meta = row.value;
        if (meta?.name && GROUP_COLOR_REGEX.test(meta.color)) colors.set(meta.name, meta.color);
    }

    return [...counts.entries()]
        .map(([name, count]) => ({ name, count, color: colors.get(name) || DEFAULT_GROUP_COLOR }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Drop a group's stored color once no server belongs to it any more — groups
// are implicit, so the metadata record must not outlive the group.
async function pruneGroupMetaIfEmpty(name) {
    if (!name) return;
    const all = await serversDb.all();
    const stillUsed = all.some(row => row.value?.group === name);
    if (!stillUsed) {
        try { await groupsDb.delete(`group_${name}`); } catch { /* ignore */ }
    }
}

// Rename a group: repoints every member server's `group` field, and carries
// the color metadata over to the new name. Returns the ids of affected servers
// so the caller can sync any live ServerProcess configs.
async function renameGroup(oldName, newName) {
    const all = await serversDb.all();
    const affected = all.filter(row => row.value?.group === oldName);

    for (const row of affected) {
        const server = row.value;
        server.group = newName;
        await serversDb.set(`server_${server.id}`, server);
    }

    const color = await getGroupColor(oldName);
    await setGroupColor(newName, color);
    try { await groupsDb.delete(`group_${oldName}`); } catch { /* ignore */ }

    return affected.map(row => row.value.id);
}

module.exports = {
    normalizeGroupName,
    getDistinctGroups,
    getGroupColor,
    setGroupColor,
    getGroupsWithMeta,
    pruneGroupMetaIfEmpty,
    renameGroup,
    GROUP_NAME_ERROR,
    GROUP_NAME_REGEX,
    GROUP_NAME_MAX_LENGTH,
    GROUP_COLOR_REGEX,
    DEFAULT_GROUP_COLOR
};
