const fs = require('fs');
const path = require('path');
const { formatSize } = require('./resourceStats');

// Extensions we treat as text when we cannot read the file to find out — it
// does not exist yet, or the running server has it locked. Contents decide
// every case where contents are available, so this list is a fallback, not the
// rule: an unlisted but perfectly textual file (a mod's own config extension, a
// dotfile, a name with no extension at all) still opens on the strength of its
// bytes rather than being refused for the sole crime of being unlisted.
const TEXT_EXTENSIONS = new Set([
    // Plain text and docs
    '.txt', '.log', '.md', '.markdown', '.rst', '.adoc', '.nfo',
    // Config
    '.properties', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
    '.env', '.list', '.rules', '.editorconfig',
    // JSON and friends — jsonl/ndjson are line-delimited, json5/jsonc allow comments
    '.json', '.jsonl', '.ndjson', '.json5', '.jsonc',
    // Markup and tabular
    '.xml', '.xsd', '.xsl', '.svg', '.html', '.htm', '.css', '.scss', '.less',
    '.csv', '.tsv', '.sql',
    // Scripts and source
    '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.psm1',
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
    '.py', '.rb', '.pl', '.lua', '.php', '.go', '.rs', '.c', '.h',
    '.cpp', '.hpp', '.cs', '.java', '.kt', '.kts', '.groovy', '.gradle',
    // Minecraft-specific text formats
    '.mcmeta', '.mcfunction', '.snbt', '.lang', '.sk',
    // Patches
    '.diff', '.patch'
]);

// Extensions we refuse without reading the file. This is the fast path that
// keeps a directory listing cheap: a mods folder is hundreds of jars and a
// world is thousands of region files, and none of them are worth opening to
// confirm what the name already says.
const BINARY_EXTENSIONS = new Set([
    // Archives and packaged content
    '.jar', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar',
    '.mrpack', '.war', '.ear',
    // Minecraft binary data — NBT is gzipped, region files are chunk blobs.
    // These used to be editable via '.nbt'; opening one in a text editor and
    // saving re-encodes its bytes as UTF-8 and corrupts the world or player.
    '.dat', '.dat_old', '.nbt', '.mca', '.mcr', '.mclevel', '.schematic', '.litematic',
    // Images, media, fonts
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff',
    '.mp3', '.ogg', '.wav', '.mp4', '.webm', '.ttf', '.otf', '.woff', '.woff2',
    // Compiled output and databases
    '.exe', '.dll', '.so', '.dylib', '.class', '.bin', '.o', '.a', '.pdf',
    '.db', '.sqlite', '.sqlite3'
]);

// How much of a file we look at. Enough to catch a binary header and any stray
// control bytes just past it, small enough that doing it for every candidate
// entry in a directory listing is cheap.
const SNIFF_BYTES = 8192;

// Control bytes that are ordinary in a text file: tab, newline, form feed,
// carriage return, and ESC — a Minecraft console log is full of ANSI colour
// codes, and a short one would otherwise fail on ratio alone.
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

// Largest file the editor and the text API will load in one piece. Past this,
// callers take a byte window (see readTextWindow) instead — an append-only log
// on a running server has no upper bound worth trusting.
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/**
 * Decide whether a sample of bytes reads as UTF-8 text.
 *
 * @param {Buffer} buf - the first bytes of a file, possibly cut mid-character
 * @returns {boolean}
 */
function looksLikeText(buf) {
    if (buf.length === 0) return true;

    // UTF-16/UTF-32 are text, but the editor reads and writes UTF-8 — saving
    // one back through it would rewrite every byte in the file, so refuse.
    if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return false;

    // A NUL byte is the single most reliable binary tell.
    if (buf.includes(0)) return false;

    try {
        // stream: true so a multi-byte character straddling the end of the
        // sample is held back rather than reported as corruption.
        new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
    } catch {
        return false;
    }

    // The rest of the C0 range and DEL are not ordinary: a light sprinkling is
    // tolerable, a heavy one is binary that happened to survive the NUL and
    // UTF-8 checks above.
    let control = 0;
    for (const byte of buf) {
        if ((byte < 0x20 || byte === 0x7f) && !ALLOWED_CONTROL_BYTES.has(byte)) control++;
    }
    return control / buf.length <= 0.1;
}

/**
 * Read the head of a file and decide whether it is text.
 *
 * @param {string} filePath - absolute path
 * @returns {boolean|null} null when the file could not be read at all — it is
 *   absent, or the running server holds it open — leaving nothing to judge
 */
function sniffFile(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(SNIFF_BYTES);
        const read = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
        return looksLikeText(buf.subarray(0, read));
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* already gone */ }
        }
    }
}

/**
 * Whether the panel will open this file as text.
 *
 * Contents decide it. The name only gets a say twice: to skip the read for
 * formats that are always binary, and to stand in when there is nothing to
 * read. Judging by bytes is what lets an unlisted extension through, and it is
 * also what catches the reverse — a UTF-16 or latin-1 file wearing a .txt on
 * the end, which the editor would show as mojibake and mangle on save, since
 * it reads and writes UTF-8 throughout.
 *
 * @param {string} filePath - absolute path
 * @returns {boolean}
 */
function isEditableFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return false;

    const sniffed = sniffFile(filePath);
    if (sniffed !== null) return sniffed;

    // Nothing to go on but the name. A path that does not exist yet is a file
    // the caller is about to write text into, so let any non-binary extension
    // through; one that exists but will not open falls back to the list.
    return !fs.existsSync(filePath) || TEXT_EXTENSIONS.has(ext);
}

/**
 * A byte window can land in the middle of a multi-byte character at either
 * end. Drop the partial pieces rather than emitting U+FFFD into the response.
 *
 * @returns {{buf: Buffer, leading: number}} leading = bytes dropped at the front
 */
function trimPartialUtf8(buf, cutStart, cutEnd) {
    let lead = 0;
    if (cutStart) {
        while (lead < buf.length && (buf[lead] & 0xc0) === 0x80) lead++;
    }
    let end = buf.length;
    if (cutEnd) {
        let i = end - 1;
        while (i >= lead && (buf[i] & 0xc0) === 0x80) i--;
        if (i >= lead) {
            const b = buf[i];
            const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
            if (end - i < need) end = i;
        }
    }
    return { buf: buf.subarray(lead, end), leading: lead };
}

/**
 * Read all or part of a file as UTF-8 text.
 *
 * Offsets are in bytes, not characters, so a window is cheap to ask for
 * against a file that is still being appended to. The window is clamped to
 * MAX_TEXT_BYTES and to the file's actual length, so an over-large request
 * comes back short rather than failing.
 *
 * @param {string} filePath - absolute path
 * @param {{offset?: number, limit?: number|null, tail?: number|null}} window
 * @returns {{content: string, size: number, offset: number, length: number, truncated: boolean}}
 */
function readTextWindow(filePath, { offset = 0, limit = null, tail = null } = {}) {
    const size = fs.statSync(filePath).size;

    let start, want;
    if (tail !== null) {
        want = Math.min(tail, MAX_TEXT_BYTES, size);
        start = size - want;
    } else {
        start = Math.min(offset, size);
        want = Math.min(limit === null ? size - start : limit, MAX_TEXT_BYTES, size - start);
    }

    let read = 0;
    const buf = Buffer.alloc(want);
    if (want > 0) {
        const fd = fs.openSync(filePath, 'r');
        try { read = fs.readSync(fd, buf, 0, want, start); } finally { fs.closeSync(fd); }
    }

    const cutEnd = start + read < size;
    const trimmed = trimPartialUtf8(buf.subarray(0, read), start > 0, cutEnd);
    return {
        content: trimmed.buf.toString('utf8'),
        size,
        offset: start + trimmed.leading,
        length: trimmed.buf.length,
        truncated: start > 0 || cutEnd
    };
}

/**
 * Validate the offset/limit/tail trio off a query string.
 *
 * @param {object} query - req.query
 * @returns {{error: string}|{offset: number, limit: number|null, tail: number|null, windowed: boolean}}
 */
function parseReadWindow(query) {
    const parsed = {};
    for (const name of ['offset', 'limit', 'tail']) {
        const raw = query[name];
        if (raw === undefined || raw === '') { parsed[name] = null; continue; }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
            return { error: `"${name}" must be a whole number of bytes, zero or more.` };
        }
        parsed[name] = n;
    }
    if (parsed.tail !== null && (parsed.offset !== null || parsed.limit !== null)) {
        return { error: 'Use either "tail" or "offset"/"limit", not both.' };
    }
    return {
        offset: parsed.offset === null ? 0 : parsed.offset,
        limit: parsed.limit,
        tail: parsed.tail,
        windowed: parsed.tail !== null || parsed.offset !== null || parsed.limit !== null
    };
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
 * Stricter check for names the user types (rename, new folder, new file), as
 * opposed to names that arrive attached to an upload. Rejecting here produces a
 * clear message instead of a bare EINVAL/ENOENT from the filesystem later.
 *
 * Takes the name as typed, before safeEntryName has been near it. That order
 * matters for the separator check: safeEntryName reduces a name to its last
 * segment, which is right for an upload — a browser sends a whole relative path
 * as the filename — but wrong for a name somebody typed, where "sub/notes.txt"
 * would quietly become "notes.txt" in the current folder instead of saying that
 * a name is not a path. The client refuses a slash the same way
 * (public/js/files.js), so this is the server half of a check the UI already
 * makes rather than a new restriction.
 *
 * @param {*} name - the raw name from the request body
 * @returns {string|null} an error message, or null when the name is fine
 */
function newNameError(name) {
    if (typeof name !== 'string') return 'Enter a name.';
    const trimmed = name.trim();
    if (!trimmed) return 'Enter a name.';
    if (trimmed.length > 255) return 'A name cannot be longer than 255 characters.';
    if (trimmed === '.' || trimmed === '..') return 'That name cannot be used.';
    if (/[/\\]/.test(trimmed)) return 'A name cannot contain a slash.';
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(trimmed)) return 'A name cannot contain control characters.';
    if (/[<>:"|?*]/.test(trimmed)) return 'A name cannot contain any of: < > : " | ? *';
    if (/\.$/.test(trimmed)) return 'A name cannot end with a dot.';
    if (RESERVED_DEVICE_NAMES.test(trimmed)) return `"${trimmed}" is a reserved name and cannot be used.`;
    return null;
}

/**
 * List one directory, newest metadata first resolved per entry.
 * Directories sort ahead of files, then by name.
 *
 * Shared by the Files page and the file API so both describe a directory
 * identically. Entries whose stat fails (deleted mid-listing, permission
 * denied) are dropped rather than failing the whole listing. `editable` also
 * accounts for size: a file past MAX_TEXT_BYTES is text the editor still will
 * not open, so the Edit button stays off rather than leading to a 413.
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
                editable: !entry.isDirectory() && stat.size <= MAX_TEXT_BYTES && isEditableFile(entryPath)
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
}

module.exports = {
    TEXT_EXTENSIONS, BINARY_EXTENSIONS, MAX_TEXT_BYTES,
    looksLikeText, isEditableFile, readTextWindow, parseReadWindow,
    listDirectory, safeEntryName, newNameError
};
