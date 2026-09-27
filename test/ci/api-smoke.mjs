// API smoke test: exercises the documented /api/v1 surface against a fresh
// Craftbox instance, the way an integration would. Starting servers is left to
// server-start.mjs; this covers auth, validation, create, settings, files,
// backups and delete on one vanilla server.
//
//   CRAFTBOX_URL=http://localhost:6464 node test/ci/api-smoke.mjs

import {
    waitForPanel, bootstrapApiKey, apiClient, waitForState,
    createRunner, assert, assertStatus, sleep
} from './lib.mjs';

const EXPECTED_TYPES = ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'forge', 'neoforge', 'custom'];
const PROVISION_TIMEOUT = 10 * 60_000;

// server.properties as the API returns it, parsed into an object
async function readProperties(api, id) {
    const res = await api('GET', `/servers/${id}/file?path=server.properties`);
    assertStatus(res, 200, 'read server.properties');
    const props = {};
    for (const line of res.body.file.content.split(/\r?\n/)) {
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const eq = line.indexOf('=');
        props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return props;
}

const run = createRunner('API smoke test');
await waitForPanel();
const key = await bootstrapApiKey();
const api = apiClient(key);
const anon = apiClient(null);
let latest = null;
let id = null;
let backupId = null;

console.log('Auth');
await run.step('rejects requests without a key', async () => {
    const res = await anon('GET', '/servers');
    assertStatus(res, 401, 'no key');
    assert(res.body?.error === 'unauthorized', `error was ${JSON.stringify(res.body)}`);
});
await run.step('rejects an unknown key', async () => {
    assertStatus(await apiClient('cbx_not-a-real-key')('GET', '/servers'), 401, 'bad key');
});
await run.step('refuses key management over bearer auth', async () => {
    const res = await api('GET', '/account/apikeys');
    assertStatus(res, 403, 'bearer on /account/apikeys');
    assert(res.body?.error === 'session_required', `error was ${JSON.stringify(res.body)}`);
});
await run.step('unknown API paths are a JSON 404', async () => {
    const res = await api('GET', '/definitely-not-a-route');
    assertStatus(res, 404, 'unknown path');
    assert(res.body?.error === 'not_found', `error was ${JSON.stringify(res.body)}`);
});

console.log('Catalogue');
await run.step('lists every server type', async () => {
    const res = await api('GET', '/server-types');
    assertStatus(res, 200, 'server-types');
    const ids = res.body.types.map((t) => t.id);
    const missing = EXPECTED_TYPES.filter((t) => !ids.includes(t));
    assert(missing.length === 0, `missing types: ${missing.join(', ')}`);
});
await run.step('lists vanilla versions with a latest stable', async () => {
    const res = await api('GET', '/versions?type=vanilla');
    assertStatus(res, 200, 'versions');
    latest = res.body.latest;
    assert(latest, 'no latest version');
    assert(res.body.versions.some((v) => v.id === latest), `latest ${latest} is not in the list`);
});
await run.step('rejects an unknown type in /versions', async () => {
    assertStatus(await api('GET', '/versions?type=bogus'), 400, 'bogus type');
});

console.log('Create');
const validBody = () => ({
    name: 'CI Smoke', serverType: 'vanilla', version: latest || 'latest',
    port: 25565, memory: 2048, eula: true, gamemode: 'survival', difficulty: 'easy'
});
await run.step('validates create input', async () => {
    const cases = [
        ['no EULA', { eula: false }],
        ['port below 1024', { port: 80 }],
        ['memory below 512', { memory: 100 }],
        ['bad name', { name: 'bad/name' }],
        ['unknown type', { serverType: 'bogus' }],
        ['bad version', { version: '../1.21' }],
        ['custom without a URL', { serverType: 'custom' }]
    ];
    for (const [what, patch] of cases) {
        assertStatus(await api('POST', '/servers', { ...validBody(), ...patch }), 400, what);
    }
});
await run.step('creates a vanilla server from version "latest"', async () => {
    const res = await api('POST', '/servers', { ...validBody(), version: 'latest' });
    assertStatus(res, 201, 'create');
    assert(res.body.server.state === 'provisioning', `state was ${res.body.server.state}`);
    assert(res.body.server.version === latest, `"latest" recorded as ${res.body.server.version}, expected ${latest}`);
    const server = await waitForState(api, res.body.server.id, ['stopped'], { timeoutMs: PROVISION_TIMEOUT, label: 'vanilla' });
    assert(server.version === latest, `version ${server.version}, expected ${latest}`);
    id = server.id; // the rest only runs against a fully provisioned server
});

if (id) {
    await run.step('lists and fetches the server', async () => {
        const list = await api('GET', '/servers');
        assertStatus(list, 200, 'list');
        assert(list.body.servers.some((s) => s.id === id), 'server missing from the list');
        const one = await api('GET', `/servers/${id}`);
        assertStatus(one, 200, 'get');
        assert(one.body.server.name === 'CI Smoke', `name ${one.body.server.name}`);
        assert(!('directory' in one.body.server), 'on-disk directory leaked in the response');
    });

    console.log('Properties');
    await run.step('writes vanilla defaults on create', async () => {
        const props = await readProperties(api, id);
        for (const k of ['online-mode', 'pvp', 'generate-structures', 'spawn-monsters', 'enable-status']) {
            assert(props[k] === 'true', `${k}=${props[k]}`);
        }
        assert(props['server-port'] === '25565', `server-port=${props['server-port']}`);
    });
    await run.step('partial update leaves omitted toggles alone', async () => {
        assertStatus(await api('POST', `/servers/${id}/properties`, { 'max-players': 7 }), 200, 'partial update');
        const props = await readProperties(api, id);
        assert(props['max-players'] === '7', `max-players=${props['max-players']}`);
        const flipped = ['online-mode', 'pvp', 'generate-structures', 'spawn-monsters', 'enable-status'].filter((k) => props[k] !== 'true');
        assert(flipped.length === 0, `switched off: ${flipped.join(', ')}`);
    });
    await run.step('sets toggles explicitly and rejects bad values', async () => {
        assertStatus(await api('POST', `/servers/${id}/properties`, { pvp: false }), 200, 'pvp false');
        assert((await readProperties(api, id)).pvp === 'false', 'pvp not switched off');
        assertStatus(await api('POST', `/servers/${id}/properties`, { pvp: 'true' }), 200, 'pvp "true"');
        assert((await readProperties(api, id)).pvp === 'true', 'pvp not switched back on');
        assertStatus(await api('POST', `/servers/${id}/properties`, { 'online-mode': 'yes' }), 400, 'online-mode "yes"');
        assert((await readProperties(api, id))['online-mode'] === 'true', 'bad value was written');
    });

    console.log('Settings');
    await run.step('edits config and mirrors it into server.properties', async () => {
        // "latest" resolves to the version this server is already on: no change
        const res = await api('POST', `/servers/${id}/edit`, {
            name: 'CI Smoke Edited', port: 25566, memory: 1536, gamemode: 'creative', difficulty: 'hard', version: 'latest'
        });
        assertStatus(res, 200, 'edit');
        assert(res.body.server.port === 25566 && res.body.server.memory === 1536, 'record not updated');
        assert(res.body.versionChanged === false && res.body.server.version === latest,
            `version ${res.body.server.version}, versionChanged ${res.body.versionChanged}`);
        assert(!('directory' in res.body.server), 'on-disk directory leaked in the edit response');
        const props = await readProperties(api, id);
        assert(props['server-port'] === '25566' && props.gamemode === 'creative' && props.difficulty === 'hard',
            `properties: port=${props['server-port']} gamemode=${props.gamemode} difficulty=${props.difficulty}`);
    });
    await run.step('sets the MOTD', async () => {
        assertStatus(await api('POST', `/servers/${id}/motd`, { motd: 'CI smoke test' }), 200, 'motd');
        assert((await readProperties(api, id)).motd === 'CI smoke test', 'motd not written');
    });
    await run.step('toggles auto-restart, auto-start and the public status page', async () => {
        const ar = await api('POST', `/servers/${id}/autorestart`, { enabled: true });
        assertStatus(ar, 200, 'autorestart');
        assert(ar.body.autoRestart === true, 'autoRestart not set');
        const as = await api('POST', `/servers/${id}/autostart`, { enabled: false });
        assertStatus(as, 200, 'autostart');
        assert(as.body.autoStart === false, 'autoStart not cleared');
        assertStatus(await api('POST', `/servers/${id}/statuspublic`, { enabled: true }), 200, 'statuspublic');
    });
    await run.step('assigns a group', async () => {
        const res = await api('POST', `/servers/${id}/group`, { group: 'CI Group' });
        assertStatus(res, 200, 'group');
        assert(res.body.group === 'CI Group', `group ${res.body.group}`);
        const groups = await api('GET', '/groups');
        assertStatus(groups, 200, 'groups');
        assert(groups.body.groups.some((g) => g.name === 'CI Group' && g.count === 1), 'group not listed');
    });

    console.log('Files');
    await run.step('creates, writes, reads, renames and deletes files', async () => {
        assertStatus(await api('POST', `/servers/${id}/files/mkdir`, { name: 'ci-dir' }), [200, 201], 'mkdir');
        assertStatus(await api('POST', `/servers/${id}/files/mkfile`, { path: 'ci-dir', name: 'notes.txt' }), [200, 201], 'mkfile');
        assertStatus(await api('POST', `/servers/${id}/edit-file`, { filePath: 'ci-dir/notes.txt', content: 'hello from CI\n' }), 200, 'edit-file');
        const read = await api('GET', `/servers/${id}/file?path=ci-dir/notes.txt`);
        assertStatus(read, 200, 'read file');
        assert(read.body.file.content === 'hello from CI\n', `content ${JSON.stringify(read.body.file.content)}`);
        assertStatus(await api('POST', `/servers/${id}/files/rename`, { path: 'ci-dir/notes.txt', newName: 'renamed.txt' }), 200, 'rename');
        const list = await api('GET', `/servers/${id}/files?path=ci-dir`);
        assertStatus(list, 200, 'list dir');
        assert(list.body.files.map((f) => f.name).join() === 'renamed.txt', `listing ${JSON.stringify(list.body.files.map((f) => f.name))}`);
        assertStatus(await api('POST', `/servers/${id}/files/delete`, { path: 'ci-dir' }), 200, 'delete dir');
        assertStatus(await api('GET', `/servers/${id}/files?path=ci-dir`), 404, 'deleted dir');
    });
    await run.step('refuses paths outside the server directory', async () => {
        assertStatus(await api('GET', `/servers/${id}/file?path=../../craftbox.sqlite`), 403, 'traversal');
    });

    console.log('Lifecycle guards');
    await run.step('refuses a console command while stopped', async () => {
        assertStatus(await api('POST', `/servers/${id}/command`, { command: 'list' }), 409, 'command while stopped');
    });
    await run.step('refuses to stop a stopped server', async () => {
        assertStatus(await api('POST', `/servers/${id}/stop`), 400, 'stop while stopped');
    });

    console.log('Backups');
    await run.step('creates, lists and deletes a backup', async () => {
        assertStatus(await api('POST', `/servers/${id}/backups`, { name: 'CI backup' }), 202, 'create backup');
        const deadline = Date.now() + 120_000;
        let backups = [];
        while (Date.now() < deadline) {
            backups = (await api('GET', `/servers/${id}/backups`)).body?.backups || [];
            if (backups.length > 0) break;
            await sleep(1000);
        }
        assert(backups.length === 1, `expected 1 backup, found ${backups.length}`);
        backupId = backups[0].id;
        await waitForState(api, id, ['stopped'], { timeoutMs: 60_000, label: 'after backup' });
        assertStatus(await api('DELETE', `/servers/${id}/backups/${backupId}`), 200, 'delete backup');
        const after = await api('GET', `/servers/${id}/backups`);
        assert(after.body.backups.length === 0, 'backup still listed');
    });
    await run.step('records events', async () => {
        const res = await api('GET', `/servers/${id}/events?limit=50`);
        assertStatus(res, 200, 'events');
        const types = res.body.events.map((e) => e.type);
        for (const t of ['backup_create', 'backup_delete']) assert(types.includes(t), `no ${t} event (have ${types.join(', ')})`);
    });
    await run.step('serves console output', async () => {
        const res = await api('GET', `/servers/${id}/console?limit=10`);
        assertStatus(res, 200, 'console');
        assert(Array.isArray(res.body.lines), 'no lines array');
    });

    console.log('Delete');
    await run.step('deletes the server', async () => {
        assertStatus(await api('DELETE', `/servers/${id}`), 200, 'delete');
        assertStatus(await api('GET', `/servers/${id}`), 404, 'deleted server');
    });
}

run.finish();
