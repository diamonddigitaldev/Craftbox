const fs = require('fs');
const path = require('path');

// Verify `target` resolves to a location strictly inside `baseDir`, even
// when intermediate directories are symlinks. `target` may not yet exist
// (e.g. on write) — realpath the deepest existing ancestor and check that.
// path.resolve alone only normalizes the path string; it does not follow
// symlinks, so a symlink inside the server dir pointing at /etc/passwd
// would pass a naive startsWith() containment check.
function isPathInside(baseDir, target) {
    let realBase;
    try {
        realBase = fs.realpathSync(baseDir);
    } catch {
        return false;
    }

    let probe = path.resolve(target);
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) return false; // hit FS root without finding anything
        probe = parent;
    }

    let realProbe;
    try {
        realProbe = fs.realpathSync(probe);
    } catch {
        return false;
    }

    return realProbe === realBase || realProbe.startsWith(realBase + path.sep);
}

module.exports = { isPathInside };
