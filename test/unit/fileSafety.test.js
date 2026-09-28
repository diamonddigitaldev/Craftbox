const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isPathInside } = require('../../src/utils/pathSafety');
const { isZipFile } = require('../../src/utils/uploadSafety');

function tempDir(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craftbox-safety-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('isPathInside allows the directory and anything beneath it', (t) => {
    const base = tempDir(t);
    fs.mkdirSync(path.join(base, 'world'));
    assert.equal(isPathInside(base, base), true);
    assert.equal(isPathInside(base, path.join(base, 'world')), true);
    assert.equal(isPathInside(base, path.join(base, 'world', 'not-yet', 'level.dat')), true, 'a file about to be written');
});

test('isPathInside refuses traversal and look-alike siblings', (t) => {
    const base = tempDir(t);
    const server = path.join(base, 'server');
    fs.mkdirSync(server);
    fs.mkdirSync(path.join(base, 'server-evil'));
    assert.equal(isPathInside(server, path.join(server, '..')), false);
    assert.equal(isPathInside(server, path.join(server, '..', 'craftbox.sqlite')), false);
    assert.equal(isPathInside(server, path.join(base, 'server-evil', 'x')), false, 'prefix match is not containment');
    assert.equal(isPathInside(path.join(base, 'missing'), path.join(base, 'missing', 'x')), false, 'no base directory');
});

test('isPathInside follows symlinks out of the directory', (t) => {
    const base = tempDir(t);
    const server = path.join(base, 'server');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(server);
    fs.mkdirSync(outside);
    try {
        fs.symlinkSync(outside, path.join(server, 'link'), 'junction');
    } catch (err) {
        return t.skip(`cannot create a link here: ${err.code}`);
    }
    assert.equal(isPathInside(server, path.join(server, 'link', 'secret.txt')), false);
});

test('isZipFile checks the magic number, not the name', (t) => {
    const dir = tempDir(t);
    const file = (name, bytes) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, Buffer.from(bytes));
        return p;
    };
    assert.equal(isZipFile(file('a.jar', [0x50, 0x4b, 0x03, 0x04, 0, 0])), true, 'local file header');
    assert.equal(isZipFile(file('empty.zip', [0x50, 0x4b, 0x05, 0x06, 0, 0])), true, 'empty archive');
    assert.equal(isZipFile(file('spanned.zip', [0x50, 0x4b, 0x07, 0x08])), true, 'spanned archive');
    assert.equal(isZipFile(file('fake.jar', [0x7f, 0x45, 0x4c, 0x46])), false, 'an ELF binary named .jar');
    assert.equal(isZipFile(file('short.jar', [0x50, 0x4b])), false, 'too short');
    assert.equal(isZipFile(path.join(dir, 'missing.jar')), false);
});
