const { serversDb } = require('../db');

const GROUP_NAME_REGEX = /^[a-zA-Z0-9 _\-]+$/;
const GROUP_NAME_MAX_LENGTH = 30;
const GROUP_NAME_ERROR = 'Group name must be 1-30 characters (letters, numbers, spaces, hyphens, underscores).';

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

module.exports = { normalizeGroupName, getDistinctGroups, GROUP_NAME_ERROR };
