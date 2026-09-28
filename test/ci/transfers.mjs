// Transfers test: everything that moves files in or out of the panel.
// Uploads in one request and in chunks (DGUP, docs/API.md "Chunked
// uploads"), server icons, plugins and mods, downloads and how they report
// over the WebSocket, .cbx export and import, duplicating a server,
// templates, and creating a server from a .mrpack sent in chunks.
//
//   CRAFTBOX_URL=http://localhost:6464 node test/ci/transfers.mjs

import crypto from 'node:crypto';
import {
    BASE_URL, waitForPanel, openPanel, apiClient, provisionServer, waitForState, withUpstream, upstreamFetch,
    openSocket, dgupUpload, chunkHeaders, makeZip, makeModJar, makePng, pngSize, zipEntries,
    createRunner, assert, assertStatus
} from './lib.mjs';

const PROVISION_TIMEOUT = 10 * 60_000;

const run = createRunner('Transfers test');
await waitForPanel();
const { key, session } = await openPanel();
const api = apiClient(key);
const socket = await openSocket({ cookie: session.cookie });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readFile = async (id, path) => (await api('GET', `/servers/${id}/file?path=${encodeURIComponent(path)}`)).body?.file?.content;
const exists = async (id, path) => (await api('GET', `/servers/${id}/files?path=${encodeURIComponent(path.split('/').slice(0, -1).join('/'))}`))
    .body?.files?.some((f) => f.name === path.split('/').pop()) || false;
async function fetchBytes(path, headers = {}) {
    const res = await fetch(BASE_URL + path, { headers: { authorization: `Bearer ${key}`, cookie: session.cookie, ...headers } });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}
// Multipart, with the media type a browser would give each file's extension
function form(fields, files) {
    const types = { png: 'image/png', jar: 'application/java-archive', txt: 'text/plain', zip: 'application/zip' };
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    for (const [name, data, field = 'file'] of files) {
        f.append(field, new Blob([data], { type: types[name.split('.').pop()] || 'application/octet-stream' }), name);
    }
    return f;
}
async function operation(id, name, since, timeoutMs = 180_000) {
    const msg = await socket.waitFor((m) => m.type === 'operation' && m.serverId === id && m.operation === name && m.status !== 'progress',
        { since, what: `the ${name} operation to finish`, timeoutMs });
    assert(msg.status === 'complete', `${name} ${msg.status}: ${msg.error || JSON.stringify(msg.payload)}`);
    return msg;
}

let vanilla = null;
let paper = null;
let fabric = null;
await run.step('creates vanilla, Paper and Fabric servers', async () => {
    const base = { version: 'latest', memory: 1536, eula: true };
    vanilla = await provisionServer(api, { ...base, name: 'CI Transfers', serverType: 'vanilla', port: 25565, group: 'CI Moves' },
        { timeoutMs: PROVISION_TIMEOUT, label: 'vanilla' });
    paper = await provisionServer(api, { ...base, name: 'CI Plugins', serverType: 'paper', port: 25566 }, { timeoutMs: PROVISION_TIMEOUT, label: 'paper' });
    fabric = await provisionServer(api, { ...base, name: 'CI Mods', serverType: 'fabric', port: 25567 }, { timeoutMs: PROVISION_TIMEOUT, label: 'fabric' });
    for (const s of [vanilla, paper, fabric]) socket.send({ type: 'subscribe', serverId: s.id });
    assertStatus(await api('POST', `/servers/${vanilla.id}/statuspublic`, { enabled: true }), 200, 'statuspublic');
    assertStatus(await api('POST', `/servers/${vanilla.id}/advertisedip`, { value: 'play.example.test' }), 200, 'advertisedip');
});
if (!vanilla || !paper || !fabric) {
    run.finish();
    process.exit();
}
const v = `/servers/${vanilla.id}`;

console.log('Uploads');
const binary = crypto.randomBytes(300_000);
await run.step('uploads files in one request, replacing and refusing as documented', async () => {
    assertStatus(await api('POST', `${v}/files/mkdir`, { name: 'ci-up' }), [200, 201], 'mkdir');
    assertStatus(await api('POST', `${v}/files/mkdir`, { path: 'ci-up', name: 'taken' }), [200, 201], 'mkdir taken');
    let res = await api('POST', `${v}/files/upload`, form({ path: 'ci-up' }, [['a.txt', 'first\n'], ['b.bin', binary]]));
    assert(res.status === 200 && res.body.count === 2 && res.body.replaced === 0, `upload: ${res.status} ${res.text}`);
    res = await api('POST', `${v}/files/upload`, form({ path: 'ci-up' }, [['a.txt', 'second\n'], ['taken', 'x']]));
    assert(res.body.count === 1 && res.body.replaced === 1, `re-upload: ${res.text}`);
    assert(res.body.rejected?.length === 1 && res.body.rejected[0].name === 'taken', `a folder's name wasn't refused: ${res.text}`);
    assert(await readFile(vanilla.id, 'ci-up/a.txt') === 'second\n', 'a.txt not replaced');
    const down = await fetchBytes(`/api/v1${v}/download?path=ci-up/b.bin`);
    assert(down.status === 200 && down.body.equals(binary), `binary round trip: HTTP ${down.status}, ${down.body.length} bytes`);
    assert(Number(down.headers.get('content-length')) === binary.length, 'Content-Length doesn\'t match');
    assertStatus(await api('POST', `${v}/files/upload`, form({ path: 'no-such-dir' }, [['c.txt', 'x']])), 404, 'into a missing folder');
});
await run.step('uploads a file in chunks, in any order, and replays a lost completion', async () => {
    const data = crypto.randomBytes(11 * 1024 * 1024 + 123);
    const res = await dgupUpload(api, `${v}/files/upload`, 'big.bin', data, { path: 'ci-up' });
    assert(res.status === 200 && res.body.count === 1 && res.chunks > 2, `complete: ${res.status} ${res.text} (${res.chunks} chunks)`);
    const again = await api('POST', `${v}/files/upload/complete`, { uploadId: res.uploadId });
    assert(again.status === res.status && again.text === res.text, `a repeated complete answered ${again.status} ${again.text}`);
    const down = await fetchBytes(`/api/v1${v}/download?path=ci-up/big.bin`);
    assert(sha256(down.body) === sha256(data), 'the assembled file differs');
});
await run.step('checks every chunk and refuses an incomplete upload', async () => {
    const data = crypto.randomBytes(6 * 1024 * 1024);
    const init = await api('POST', `${v}/files/upload/init`, { filename: 'checked.bin', totalSize: data.length });
    assertStatus(init, 200, 'init');
    const { uploadId, chunkSize } = init.body;
    const first = data.subarray(0, chunkSize);
    const bad = await api('POST', `${v}/files/upload/chunk`, first, { headers: chunkHeaders(uploadId, 0, first, 'a'.repeat(64)) });
    assert(bad.status === 400 && bad.body?.code === 'hash_mismatch', `wrong hash: ${bad.status} ${bad.text}`);
    const short = first.subarray(1);
    assertStatus(await api('POST', `${v}/files/upload/chunk`, short, { headers: chunkHeaders(uploadId, 0, short) }), 400, 'a short chunk');
    assertStatus(await api('POST', `${v}/files/upload/chunk`, first, { headers: chunkHeaders(uploadId, 0, first) }), 200, 'chunk 0');
    assertStatus(await api('POST', `${v}/files/upload/chunk`, first, { headers: chunkHeaders(uploadId, 0, first) }), 200, 'chunk 0 again');
    assertStatus(await api('POST', `${v}/files/upload/complete`, { uploadId }), 400, 'complete with a chunk missing');
    assertStatus(await api('POST', `${v}/files/upload/cancel`, { uploadId }), 200, 'cancel');
    assertStatus(await api('POST', `${v}/files/upload/complete`, { uploadId }), 404, 'complete after cancel');
    assert(!(await exists(vanilla.id, 'ci-up/checked.bin')), 'a cancelled upload landed');
});

console.log('Icons');
await run.step('resizes an uploaded icon to 64x64 and refuses anything else', async () => {
    const icon = async () => {
        const res = await fetchBytes(`/api/v1${v}/icon`);
        return res.status === 200 ? { type: res.headers.get('content-type'), ...pngSize(res.body) } : { status: res.status };
    };
    const fresh = await icon();
    assert(fresh.width === 64 && fresh.height === 64, `a new server's icon: ${JSON.stringify(fresh)}`);
    assertStatus(await api('POST', `${v}/icon`, form({}, [['wide.png', makePng(300, 120), 'icon']])), 200, 'upload');
    const up = await icon();
    assert(up.type === 'image/png' && up.width === 64 && up.height === 64, `after upload: ${JSON.stringify(up)}`);
    assert(await exists(vanilla.id, 'server-icon.png'), 'no server-icon.png for Minecraft to read');
    const junk = await api('POST', `${v}/icon`, form({}, [['junk.png', crypto.randomBytes(2000), 'icon']]));
    assert(junk.status === 400, `undecodable image: ${junk.status} ${junk.text}`);
    assertStatus(await api('POST', `${v}/icon/upload/init`, { filename: 'icon.jpg', totalSize: 1000 }), 400, 'chunked .jpg');
    const chunked = await dgupUpload(api, `${v}/icon/upload`, 'tall.png', makePng(90, 400));
    assertStatus(chunked, 200, 'chunked upload');
    assertStatus(await api('DELETE', `${v}/icon`), 200, 'delete');
    assert((await icon()).status === 404, 'icon still served after delete');
    assertStatus(await api('POST', `${v}/icon/reset`), 200, 'reset');
    assert((await icon()).width === 64, 'no default icon after reset');
});

console.log('Plugins and mods');
const p = `/servers/${paper.id}`;
await run.step('manages plugins on a Paper server', async () => {
    // Anything but a .jar refuses the whole request; a .jar that isn't a zip
    // is refused on its own
    assertStatus(await api('POST', `${p}/plugins/upload`, form({}, [['notes.txt', 'not a jar']])), 400, 'a .txt');
    const res = await api('POST', `${p}/plugins/upload`, form({}, [
        ['one.jar', makeModJar('paper', 'one')], ['two.jar', makeModJar('paper', 'two')], ['fake.jar', 'not a zip']
    ]));
    assert(res.status === 200 && res.body.count === 2, `upload: ${res.status} ${res.text}`);
    assert(res.body.rejected.map((r) => r.name).join() === 'fake.jar', `rejected: ${JSON.stringify(res.body.rejected)}`);
    const chunked = await dgupUpload(api, `${p}/plugins/upload`, 'three.jar', makeModJar('paper', 'three'));
    assert(chunked.status === 200 && chunked.body.count === 1, `chunked: ${chunked.text}`);
    const list = (await api('GET', `${p}/plugins`)).body;
    assert(list.contentType.label === 'Plugins' && list.files.map((f) => f.name).sort().join() === 'one.jar,three.jar,two.jar',
        `listed: ${JSON.stringify(list)}`);
    assert(list.files.every((f) => f.environment === 'both'), 'a plugin with an environment other than both');
    assertStatus(await api('GET', `${p}/plugins/environment`), 400, 'environments on a plugin server');
    assertStatus(await api('POST', `${p}/plugins/delete`, { filename: 'two.jar' }), 200, 'delete');
    assert((await api('GET', `${p}/plugins`)).body.files.length === 2, 'two.jar still listed');
    assertStatus(await api('GET', `/servers/${vanilla.id}/plugins`), 404, 'plugins on vanilla');
});
await run.step('reports plugin downloads over the WebSocket', async () => {
    let since = socket.mark();
    const one = await fetchBytes(`${p}/plugins/download?file=one.jar&dl=ci-one`);
    assert(one.status === 200 && one.body.equals(makeModJar('paper', 'one')), `one.jar: HTTP ${one.status}`);
    let msg = await operation(paper.id, 'download', since);
    assert(msg.payload?.token === 'ci-one' && msg.payload.bytes === one.body.length, JSON.stringify(msg.payload));
    since = socket.mark();
    const all = await fetchBytes(`${p}/plugins/download-all?dl=ci-all`);
    assert(all.status === 200 && Number(all.headers.get('content-length')) === all.body.length, `download-all: HTTP ${all.status}`);
    assert(zipEntries(all.body).map((n) => n.split('/').pop()).sort().join() === 'one.jar,three.jar', `zip: ${zipEntries(all.body).join(', ')}`);
    msg = await operation(paper.id, 'download', since);
    assert(msg.payload?.token === 'ci-all', JSON.stringify(msg.payload));
    since = socket.mark();
    assertStatus(await fetchBytes(`${p}/plugins/download?file=missing.jar&dl=ci-missing`), 404, 'a missing plugin');
    // A failure carries its reason as a string naming the file, and the token
    // like every other report, so the page can tell which download failed
    msg = await socket.waitFor((m) => m.type === 'operation' && m.operation === 'download' && m.status === 'failed', { since, what: 'the failed download' });
    assert(/missing\.jar/.test(msg.error) && msg.payload?.token === 'ci-missing', JSON.stringify(msg));
    assertStatus(await api('POST', `${p}/plugins/delete-all`), 200, 'delete-all');
    assert((await api('GET', `${p}/plugins`)).body.files.length === 0, 'plugins left after delete-all');
});
await run.step('tags mods client-only or server-only on a Fabric server', async () => {
    const f = `/servers/${fabric.id}`;
    assertStatus(await api('POST', `${f}/plugins/upload`, form({}, [['mod.jar', makeModJar('fabric', 'ci_mod')]])), 200, 'upload');
    assertStatus(await api('POST', `${f}/plugins/environment`, { filename: 'mod.jar', environment: 'client' }), 200, 'client');
    let list = (await api('GET', `${f}/plugins`)).body;
    assert(list.contentType.label === 'Mods' && list.files[0]?.environment === 'client', `listed: ${JSON.stringify(list.files)}`);
    assert(await exists(fabric.id, 'mods/mod.jar.disabled') && !(await exists(fabric.id, 'mods/mod.jar')), 'a client-only mod left enabled on disk');
    assert((await api('GET', `${f}/plugins/environment`)).body.environment['mod.jar'] === 'client', 'environment map');
    assertStatus(await api('POST', `${f}/plugins/environment`, { filename: 'mod.jar', environment: 'sideways' }), 400, 'a bad environment');
    // Uploading it again is "put this on the server": enabled, both sides
    assertStatus(await api('POST', `${f}/plugins/upload`, form({}, [['mod.jar', makeModJar('fabric', 'ci_mod')]])), 200, 're-upload');
    list = (await api('GET', `${f}/plugins`)).body;
    assert(list.files.length === 1 && list.files[0].environment === 'both', `after re-upload: ${JSON.stringify(list.files)}`);
    assert(await exists(fabric.id, 'mods/mod.jar') && !(await exists(fabric.id, 'mods/mod.jar.disabled')), 'still disabled on disk');
});

console.log('Downloads');
await run.step('downloads a file and the whole server, reporting each', async () => {
    let since = socket.mark();
    const file = await fetchBytes(`${v}/download?path=ci-up/a.txt&dl=ci-file`);
    assert(file.status === 200 && file.body.toString() === 'second\n', `file: HTTP ${file.status}`);
    assert((await operation(vanilla.id, 'download', since)).payload?.token === 'ci-file', 'no report for the file');
    since = socket.mark();
    const zip = await fetchBytes(`${v}/download-zip?dl=ci-zip`);
    assert(zip.status === 200 && Number(zip.headers.get('content-length')) === zip.body.length, `zip: HTTP ${zip.status}`);
    const names = zipEntries(zip.body);
    assert(names.includes('ci-up/a.txt') && names.includes('server.properties'), `zip holds ${names.slice(0, 8).join(', ')}…`);
    assert((await operation(vanilla.id, 'download', since)).payload?.token === 'ci-zip', 'no report for the zip');
    assertStatus(await fetchBytes(`${v}/download?path=../../craftbox.sqlite`), 403, 'traversal');
});

console.log('Export and import');
let archive = null;
await run.step('exports a server, its backups and events as .cbx', async () => {
    assertStatus(await api('POST', `${v}/edit-file`, { filePath: 'ci-cbx.txt', content: 'travels\n' }), 200, 'seed file');
    const since = socket.mark();
    assertStatus(await api('POST', `${v}/backups`, { name: 'CI export' }), 202, 'backup');
    await operation(vanilla.id, 'backup', since);
    const res = await fetchBytes(`/api/v1${v}/export?backups=true&events=true`);
    assert(res.status === 200, `export: HTTP ${res.status} ${res.body.toString().slice(0, 200)}`);
    assert(res.headers.get('content-type') === 'application/x-craftbox-export+zip', `type ${res.headers.get('content-type')}`);
    assert(/filename="?CI_Transfers\.cbx"?/.test(res.headers.get('content-disposition') || ''), `named ${res.headers.get('content-disposition')}`);
    assert(Number(res.headers.get('content-length')) === res.body.length, 'Content-Length doesn\'t match');
    const names = zipEntries(res.body);
    const missing = ['craftbox-manifest.json', 'modenv.json', 'server/ci-cbx.txt', 'server/server.properties', 'backups.json', 'events.json']
        .filter((n) => !names.includes(n));
    assert(missing.length === 0 && names.some((n) => /^backups\/.+\.zip$/.test(n)), `missing ${missing.join(', ')} (has ${names.length} entries)`);
    archive = res.body;
});
async function checkImported(res, how) {
    assert(res.status === 201, `${how}: ${res.status} ${res.text}`);
    const id = res.body.server.id;
    assert(id !== vanilla.id, 'imported over the original\'s id');
    assert(res.body.warnings?.some((w) => /port/i.test(w)), `no port-collision warning: ${JSON.stringify(res.body.warnings)}`);
    await waitForState(api, id, ['stopped'], { timeoutMs: 120_000, label: how });
    const s = (await api('GET', `/servers/${id}`)).body.server;
    const kept = { name: s.name, memory: s.memory, group: s.group, statusPagePublic: s.statusPagePublic, advertisedIp: s.advertisedIp };
    assert(JSON.stringify(kept) === JSON.stringify({ name: 'CI Transfers', memory: 1536, group: 'CI Moves', statusPagePublic: true, advertisedIp: 'play.example.test' }),
        `settings: ${JSON.stringify(kept)}`);
    assert(await readFile(id, 'ci-cbx.txt') === 'travels\n', 'files not imported');
    const backups = (await api('GET', `/servers/${id}/backups`)).body.backups;
    assert(backups.length === 1 && backups[0].name === 'CI export', `backups: ${backups.map((b) => b.name).join(', ')}`);
    assert((await api('GET', `/servers/${id}/events?limit=200`)).body.events.length > 0, 'no events imported');
    return id;
}
if (archive) {
    await run.step('imports it back as a copy', async () => {
        await checkImported(await api('POST', '/servers/import', form({}, [['CI_Transfers.cbx', archive, 'archive']])), 'import');
    });
    await run.step('imports it through a chunked upload', async () => {
        await checkImported(await dgupUpload(api, '/servers/import/upload', 'CI_Transfers.cbx', archive), 'chunked import');
    });
    await run.step('refuses archives that aren\'t Craftbox exports', async () => {
        const cases = [
            ['a zip without a manifest', 'plain.cbx', makeZip({ 'server/server.properties': 'motd=x\n' })],
            ['not a zip', 'noise.cbx', crypto.randomBytes(4096)],
            ['the wrong extension', 'CI_Transfers.zip', archive]
        ];
        for (const [what, name, data] of cases) {
            assertStatus(await api('POST', '/servers/import', form({}, [[name, data, 'archive']])), 400, what);
        }
    });
}

console.log('Copies');
await run.step('duplicates a server, with and without its world', async () => {
    assertStatus(await api('POST', `${v}/files/mkdir`, { name: 'world' }), [200, 201], 'world');
    assertStatus(await api('POST', `${v}/edit-file`, { filePath: 'world/ci.txt', content: 'a world\n' }), 200, 'world file');
    const copy = async (name, port, includeWorld) => {
        const since = socket.mark();
        const res = await api('POST', `${v}/duplicate`, { name, port, includeWorld });
        assertStatus(res, 201, `duplicate ${name}`);
        const id = res.body.server.id;
        socket.send({ type: 'subscribe', serverId: id });
        await operation(id, 'duplicate', since);
        await waitForState(api, id, ['stopped'], { timeoutMs: 120_000, label: name });
        return id;
    };
    const bare = await copy('CI Copy', 25570, false);
    assert(await readFile(bare, 'ci-cbx.txt') === 'travels\n', 'files not copied');
    assert(!(await exists(bare, 'world/ci.txt')), 'the world came along without includeWorld');
    assert((await api('GET', `/servers/${bare}`)).body.server.port === 25570, 'port not set');
    const whole = await copy('CI Copy World', 25571, true);
    assert(await readFile(whole, 'world/ci.txt') === 'a world\n', 'the world was left behind');
    assertStatus(await api('POST', `${v}/duplicate`, { name: 'bad/name', port: 25572 }), 400, 'a bad name');
});
await run.step('saves a template from a server and deletes it', async () => {
    assertStatus(await api('POST', '/templates', { serverId: vanilla.id, name: 'bad/name' }), 400, 'a bad name');
    const res = await api('POST', '/templates', { serverId: vanilla.id, name: 'CI Template' });
    assertStatus(res, 201, 'template');
    const t = res.body.template;
    const want = { serverType: 'vanilla', version: vanilla.version, memory: 1536, port: 25565 };
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, t[k]]));
    assert(JSON.stringify(got) === JSON.stringify(want) && t.levelType, `template: ${JSON.stringify(t)}`);
    assert(!('group' in t) || !t.group, 'a template carried the dashboard group');
    assert((await api('GET', '/templates')).body.templates.some((x) => x.id === t.id), 'not listed');
    assertStatus(await api('GET', `/templates/${t.id}`), 200, 'get');
    assertStatus(await api('DELETE', `/templates/${t.id}`), [200, 204], 'delete');
    assertStatus(await api('GET', `/templates/${t.id}`), 404, 'deleted template');
});

console.log('Modpacks');
await run.step('creates a server from a .mrpack sent in chunks', async () => {
    const mc = (await api('GET', '/versions?type=fabric')).body?.latest;
    const loader = (await (await upstreamFetch('https://meta.fabricmc.net/v2/versions/loader')).json()).find((l) => l.stable)?.version;
    assert(mc && loader, `Fabric ${mc}, loader ${loader}`);
    const pack = makeZip({
        'modrinth.index.json': JSON.stringify({
            formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: 'CI Chunked Pack', files: [],
            dependencies: { minecraft: mc, 'fabric-loader': loader }
        }),
        'overrides/config/ci.txt': 'from the pack',
        'overrides/mods/pack-mod.jar': makeModJar('fabric', 'pack_mod')
    });
    const server = await withUpstream(['fabric', 'mojang'], async () => {
        const res = await dgupUpload(api, '/servers/from-mrpack/upload', 'ci.mrpack', pack,
            { name: 'CI Chunked Pack', port: '25575', memory: '2048', eula: 'true', levelType: '' });
        assert(res.status === 201, `complete: ${res.status} ${res.text}`);
        try {
            return await waitForState(api, res.body.server.id, ['stopped'], { timeoutMs: PROVISION_TIMEOUT, label: 'mrpack' });
        } catch (err) {
            await api('DELETE', `/servers/${res.body.server.id}`);
            throw err;
        }
    });
    assert(server.serverType === 'fabric' && server.version === mc && server.modpack?.source === 'file', `record: ${JSON.stringify(server.modpack)}`);
    assert(await readFile(server.id, 'config/ci.txt') === 'from the pack', 'overrides not applied');
    assert((await api('GET', `/servers/${server.id}/plugins`)).body.files.some((f) => f.name === 'pack-mod.jar'), 'the pack\'s mod isn\'t listed');
});

socket.close();
run.finish();
