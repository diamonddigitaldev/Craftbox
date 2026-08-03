const fs = require('fs');

// Craftbox writes every console line to <serverDir>/logs/craftbox-console.log as
// `[<ISO timestamp>] <line>`. That file is append-only and never rotated, so it
// can be large — reads are always tailed from the end rather than loaded whole.
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?([\s\S]*)$/;

// How far back to read when tailing. Generous enough that a `limit` of 1000
// almost always lands inside it, small enough never to load a multi-GB log.
const TAIL_BYTES = 1024 * 1024;

/**
 * Read the last `limit` lines of a console log.
 *
 * @param {string} logPath
 * @param {number} limit
 * @returns {{lines: Array<{timestamp: string|null, line: string}>, truncated: boolean}}
 *   `truncated` is true when older lines exist beyond what was read — either
 *   because the tail window was reached or because more lines were found than
 *   were asked for.
 */
function readConsoleTail(logPath, limit) {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - TAIL_BYTES);

    const fd = fs.openSync(logPath, 'r');
    let raw;
    try {
        const length = size - start;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        raw = buf.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }

    // A non-zero start almost certainly lands mid-line; drop that fragment.
    if (start > 0) {
        const nl = raw.indexOf('\n');
        raw = nl === -1 ? '' : raw.slice(nl + 1);
    }

    const all = raw.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();

    const selected = limit >= all.length ? all : all.slice(-limit);
    const truncated = start > 0 || selected.length < all.length;

    return {
        lines: selected.map((entry) => {
            const m = LINE_RE.exec(entry);
            // Lines written before timestamping, or a torn write, still come
            // back — just without a timestamp.
            return m ? { timestamp: m[1], line: m[2] } : { timestamp: null, line: entry };
        }),
        truncated
    };
}

module.exports = { readConsoleTail };
