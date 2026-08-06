const fs = require('fs');
const path = require('path');
const { formatSize } = require('./resourceStats');

// Extensions the file editor will open as text. Everything else is treated as
// binary and can only be downloaded. This is an allowlist, not content
// sniffing — an unlisted extension is refused rather than guessed at.
const TEXT_EXTENSIONS = new Set([
    '.txt', '.log', '.properties', '.json', '.yml', '.yaml', '.xml',
    '.cfg', '.conf', '.ini', '.toml', '.csv', '.md', '.sh', '.bat',
    '.cmd', '.ps1', '.js', '.ts', '.py', '.java', '.html', '.css',
    '.mcmeta', '.lang', '.sk', '.nbt'
]);

function isTextFile(filename) {
    return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

// Windows refuses these outright; creating one on Linux would produce a file
// that breaks the moment the server directory is exported and restored there.
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Reduce a caller-supplied name to a single safe path segment.
 * Mirrors the checks DGUP already applies to an uploaded filename
 * (see middleware/dgup.js) so both upload paths agree on what a name is.
 *
 * @param {*} name
 * @returns {string|null} the segment, or null when it cannot be made safe
 */
function safeEntryName(name) {
    if (typeof name !== 'string') return null;
    const base = path.basename(name).replace(/[/\\]/g, '').trim();
    // eslint-disable-next-line no-control-regex
    if (!base || base.length > 255 || /[\x00-\x1f]/.test(base)) return null;
    if (base === '.' || base === '..') return null;
    return base;
}

/**
 * Stricter check for names the user types (rename, new folder), as opposed to
 * names that arrive attached to an upload. Rejecting here produces a clear
 * message instead of a bare EINVAL/ENOENT from the filesystem later.
 *
 * @param {string} name - already through safeEntryName
 * @returns {string|null} an error message, or null when the name is fine
 */
function newNameError(name) {
    if (/[<>:"|?*]/.test(name)) return 'A name cannot contain any of: < > : " | ? *';
    if (/[. ]$/.test(name)) return 'A name cannot end with a dot or a space.';
    if (RESERVED_DEVICE_NAMES.test(name)) return `"${name}" is a reserved name and cannot be used.`;
    return null;
}

/**
 * List one directory, newest metadata first resolved per entry.
 * Directories sort ahead of files, then by name.
 *
 * Shared by the Files page and the file API so both describe a directory
 * identically. Entries whose stat fails (deleted mid-listing, permission
 * denied) are dropped rather than failing the whole listing.
 * @param {string} dir - absolute path, already validated with isPathInside
 */
function listDirectory(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .map(entry => {
            const entryPath = path.join(dir, entry.name);
            let stat;
            try { stat = fs.statSync(entryPath); } catch { return null; }
            return {
                name: entry.name,
                isDirectory: entry.isDirectory(),
                size: stat.size,
                sizeFormatted: formatSize(stat.size),
                modified: stat.mtime,
                modifiedISO: stat.mtime.toISOString(),
                editable: !entry.isDirectory() && isTextFile(entry.name)
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
}

module.exports = { TEXT_EXTENSIONS, isTextFile, listDirectory, safeEntryName, newNameError };
