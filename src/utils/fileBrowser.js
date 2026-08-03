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

module.exports = { TEXT_EXTENSIONS, isTextFile, listDirectory };
