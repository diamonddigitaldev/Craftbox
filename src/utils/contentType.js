/**
 * Maps server types to their plugin/mod content type info.
 * Absent types (vanilla, custom) do not support plugins/mods.
 */
const CONTENT_TYPES = {
    paper:    { label: 'Plugins', folder: 'plugins', icon: 'extension', loaders: ['paper', 'spigot', 'bukkit'],  projectType: 'plugin' },
    purpur:   { label: 'Plugins', folder: 'plugins', icon: 'extension', loaders: ['paper', 'spigot', 'bukkit'],  projectType: 'plugin' },
    folia:    { label: 'Plugins', folder: 'plugins', icon: 'extension', loaders: ['folia'],                      projectType: 'plugin' },
    fabric:   { label: 'Mods',    folder: 'mods',    icon: 'extension', loaders: ['fabric'],                     projectType: 'mod' },
    forge:    { label: 'Mods',    folder: 'mods',    icon: 'extension', loaders: ['forge'],                      projectType: 'mod' },
    neoforge: { label: 'Mods',    folder: 'mods',    icon: 'extension', loaders: ['neoforge'],                   projectType: 'mod' }
};

function getContentType(serverType) {
    return CONTENT_TYPES[serverType] || null;
}

module.exports = { CONTENT_TYPES, getContentType };
