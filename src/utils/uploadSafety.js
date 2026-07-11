const fs = require('fs');

// Removes multer temp files after an upload has been handled (or rejected).
function cleanupTempFiles(files) {
    if (!files) return;
    for (const file of files) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
}

// JARs and Craftbox export archives are ZIP files; every valid one starts
// with one of these 4-byte magic numbers. Filename suffix alone is not
// enough — multer accepts anything the client labels with the extension.
function isZipFile(filepath) {
    let fd;
    try {
        fd = fs.openSync(filepath, 'r');
        const buf = Buffer.alloc(4);
        const n = fs.readSync(fd, buf, 0, 4, 0);
        if (n < 4) return false;
        if (buf[0] !== 0x50 || buf[1] !== 0x4B) return false;
        return (buf[2] === 0x03 && buf[3] === 0x04)
            || (buf[2] === 0x05 && buf[3] === 0x06)
            || (buf[2] === 0x07 && buf[3] === 0x08);
    } catch {
        return false;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
}

module.exports = { cleanupTempFiles, isZipFile };
