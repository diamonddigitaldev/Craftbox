/**
 * Maps server types to their plugin/mod content type info.
 * Absent types (vanilla, custom) do not support plugins/mods.
 */
const CONTENT_TYPES = {
    paper:  { label: 'Plugins', folder: 'plugins', icon: 'extension' },
    purpur: { label: 'Plugins', folder: 'plugins', icon: 'extension' },
    folia:  { label: 'Plugins', folder: 'plugins', icon: 'extension' },
    fabric:   { label: 'Mods',    folder: 'mods',    icon: 'extension' },
    forge:    { label: 'Mods',    folder: 'mods',    icon: 'extension' },
    neoforge: { label: 'Mods',    folder: 'mods',    icon: 'extension' }
};

function getContentType(serverType) {
    return CONTENT_TYPES[serverType] || null;
}

module.exports = { CONTENT_TYPES, getContentType };
