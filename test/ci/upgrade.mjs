// Upgrade test: a published Craftbox with data in it, replaced by the image
// under test on the same volume, as a user updating their container would.
//
// It seeds the old version through its own API (only what that version
// offers: groups arrived in 1.1.0), plants the records the startup
// migrations exist for (a server stuck provisioning, a failed provision, a
// NeoForge template labelled "1.26.x" as before 1.2.1), and kills the old
// container with a server running. The new one must come up with everything
// intact, the stale states reset, the migrations applied, the admin, API key
// and even the open session still valid, and the server able to start.
//
//   CRAFTBOX_UPGRADE_FROM=willtda/craftbox:latest CRAFTBOX_IMAGE=craftbox:ci node test/ci/upgrade.mjs
//
// It runs the containers itself, publishing CRAFTBOX_URL's port (default
// 6464), as craftbox-upgrade-from and craftbox-upgrade-to on a fresh volume,
// all labelled craftbox-ci=upgrade. It only ever removes a container that
// carries that label, so it can't take one of yours with the same name.

import crypto from 'node:crypto';
import {
    BASE_URL, CI_USER, UpstreamError, waitForPanel, bootstrapPanel, createSession, apiClient, provisionServer,
    waitForState, withUpstream, docker, createRunner, assert, assertStatus, sleep
} from './lib.mjs';

const FROM = process.env.CRAFTBOX_UPGRADE_FROM || 'willtda/craftbox:latest';
const TO = process.env.CRAFTBOX_IMAGE || 'craftbox:ci';
const PORT = new URL(BASE_URL).port || '80';
const OLD = 'craftbox-upgrade-from';
const NEW = 'craftbox-upgrade-to';
const LABEL = 'craftbox-ci=upgrade';
const VOLUME = `craftbox-upgrade-${crypto.randomBytes(4).toString('hex')}`;
// Every release so far can run it, with the Java 21 all their images carry
const MC_VERSION = '1.21.1';

const run = createRunner(`Upgrade test (${FROM} → ${TO})`);

// Remove a container of ours left by an earlier run; refuse to touch anyone
// else's
function removeOurs(name) {
    let label;
    try {
        label = docker(['inspect', '--format', '{{index .Config.Labels "craftbox-ci"}}', name]).trim();
    } catch {
        return; // no such container
    }
    if (label !== 'upgrade') throw new Error(`A container named ${name} already exists and isn't this test's; rename or remove it first.`);
    docker(['rm', '-f', name]);
}

function startContainer(name, image) {
    removeOurs(name);
    docker(['run', '-d', '--name', name, '--label', LABEL, '-p', `${PORT}:6464`, '-v', `${VOLUME}:/app/data`, image]);
}

// Write straight into a running panel's database, as its own user
function plantRecords(container, records) {
    const script = `
        const db = new (require('better-sqlite3'))('data/craftbox.sqlite');
        const records = JSON.parse(process.argv[1]);
        for (const [table, key, value] of records) {
            db.prepare('INSERT OR REPLACE INTO ' + table + ' (ID, json) VALUES (?, ?)').run(key, JSON.stringify(value));
        }
        console.log(records.length);`;
    return docker(['exec', '-u', 'craftbox', '-w', '/app', container, 'node', '-e', script, JSON.stringify(records)]).trim();
}

const seeded = {};
let key = null;
let oldSession = null;
let server = null;

await run.step(`starts ${FROM} on a fresh volume`, async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            docker(['pull', FROM]);
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            await sleep(15_000);
        }
    }
    if (lastErr) throw new UpstreamError('Docker Hub', `pulling ${FROM}: ${lastErr.stderr || lastErr.message}`);
    docker(['volume', 'create', '--label', LABEL, VOLUME]);
    startContainer(OLD, FROM);
    await waitForPanel();
    seeded.version = (await (await fetch(`${BASE_URL}/login`)).text()).match(/v(\d+\.\d+\.\d+[^<\s"]*)/)?.[1] || 'unknown';
    console.log(`    running ${seeded.version}`);
});
if (run.failed) {
    run.finish();
    process.exit();
}

await run.step('fills it with a server, settings, files, a backup and a template', async () => {
    const boot = await bootstrapPanel();
    key = boot.key;
    oldSession = boot.session;
    const api = apiClient(key);
    server = await provisionServer(api, {
        name: 'CI Upgrade', serverType: 'vanilla', version: MC_VERSION, port: 25565, memory: 1536, eula: true
    }, { timeoutMs: 10 * 60_000, label: 'vanilla' });
    const id = server.id;
    const ok = async (what, method, path, body) => {
        const res = await api(method, path, body);
        if (res.status >= 200 && res.status < 300) seeded[what] = true;
        return res;
    };
    assertStatus(await ok('autoRestart', 'POST', `/servers/${id}/autorestart`, { enabled: true }), 200, 'autorestart');
    assertStatus(await ok('statusPagePublic', 'POST', `/servers/${id}/statuspublic`, { enabled: true }), 200, 'statuspublic');
    assertStatus(await ok('motd', 'POST', `/servers/${id}/motd`, { motd: 'Carried over' }), 200, 'motd');
    assertStatus(await ok('properties', 'POST', `/servers/${id}/properties`, { 'max-players': 7 }), 200, 'properties');
    assertStatus(await ok('file', 'POST', `/servers/${id}/edit-file`, { filePath: 'ci-upgrade.txt', content: 'from the old version\n' }), 200, 'file');
    await ok('advertisedIp', 'POST', `/servers/${id}/advertisedip`, { value: 'upgrade.example.test' });
    if ((await ok('group', 'POST', `/servers/${id}/group`, { group: 'CI Upgrade Group' })).status === 200) {
        await ok('groupColor', 'POST', `/groups/${encodeURIComponent('CI Upgrade Group')}`, { color: '#123456' });
    }
    await ok('schedule', 'POST', `/servers/${id}/backup-schedule`, { enabled: true, intervalHours: 24, countdownMinutes: 5 });

    assertStatus(await api('POST', `/servers/${id}/backups`, { name: 'CI old backup' }), 202, 'backup');
    const deadline = Date.now() + 120_000;
    while (!(await api('GET', `/servers/${id}/backups`)).body?.backups?.length) {
        assert(Date.now() < deadline, 'backup never listed');
        await sleep(1000);
    }
    await waitForState(api, id, ['stopped'], { timeoutMs: 60_000 });
    const template = await api('POST', '/templates', { serverId: id, name: 'CI Old Template' });
    assertStatus(template, 201, 'template');
    seeded.template = template.body.template;
    console.log(`    seeded: ${Object.keys(seeded).filter((k) => seeded[k] === true).join(', ')}`);
});

const planted = { provisioning: crypto.randomUUID(), failed: crypto.randomUUID(), neoTemplate: crypto.randomUUID() };
await run.step('plants the records the startup migrations are for, then kills it mid-run', async () => {
    const api = apiClient(key);
    const record = (await api('GET', `/servers/${server.id}`)).body.server;
    const copy = (id, extra) => ({ ...record, id, directory: `/app/data/servers/${id}`, group: null, backupSchedule: null, ...extra });
    for (const id of [planted.provisioning, planted.failed]) {
        docker(['exec', '-u', 'craftbox', OLD, 'mkdir', '-p', `/app/data/servers/${id}`]);
    }
    const count = plantRecords(OLD, [
        ['servers', `server_${planted.provisioning}`, copy(planted.provisioning, { name: 'CI Interrupted', state: 'provisioning', port: 25580 })],
        ['servers', `server_${planted.failed}`, copy(planted.failed, {
            name: 'CI Failed', state: 'crashed', crashReason: 'Provisioning failed: CI', provisionFailed: true, port: 25581
        })],
        ['templates', `template_${planted.neoTemplate}`, {
            ...seeded.template, id: planted.neoTemplate, name: 'CI NeoForge', serverType: 'neoforge', version: '1.26.1', build: '26.1.2.112'
        }]
    ]);
    assert(count === '3', `planted ${count}`);
    await withUpstream(['mojang'], async () => {
        assertStatus(await api('POST', `/servers/${server.id}/start`), 200, 'start');
        await waitForState(api, server.id, ['running'], { timeoutMs: 5 * 60_000 });
    });
    // No graceful shutdown: the database still says running
    docker(['kill', OLD]);
});

await run.step(`starts ${TO} on the same volume`, async () => {
    startContainer(NEW, TO);
    await waitForPanel();
    const logs = docker(['logs', NEW]);
    assert(!/Fatal startup error/.test(logs), `startup failed:\n${logs.slice(-2000)}`);
});

const api = apiClient(key);
await run.step('keeps the admin, the API key and the open session', async () => {
    assertStatus(await api('GET', '/servers'), 200, 'the old API key');
    assert((await oldSession.get('/dashboard')).status === 200, 'the session open before the upgrade was signed out');
    const fresh = createSession();
    assert((await fresh.get('/setup')).location === '/dashboard', 'setup offered again');
    await fresh.get('/login');
    const res = await fresh.post('/login', CI_USER);
    assert(res.status === 302 && res.location === '/dashboard', `sign-in: ${res.status} → ${res.location}`);
});
await run.step('keeps the server, its settings and files', async () => {
    const s = (await api('GET', `/servers/${server.id}`)).body?.server;
    assert(s, 'the server is gone');
    const want = { name: 'CI Upgrade', version: MC_VERSION, port: 25565, memory: 1536, serverType: 'vanilla' };
    if (seeded.autoRestart) want.autoRestart = true;
    if (seeded.statusPagePublic) want.statusPagePublic = true;
    if (seeded.advertisedIp) want.advertisedIp = 'upgrade.example.test';
    if (seeded.group) want.group = 'CI Upgrade Group';
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, s[k]]));
    assert(JSON.stringify(got) === JSON.stringify(want), `record: ${JSON.stringify(got)}`);
    assert(s.state === 'stopped', `left "${s.state}" after the old panel was killed running`);
    const props = (await api('GET', `/servers/${server.id}/file?path=server.properties`)).body.file.content;
    assert(/^max-players=7$/m.test(props) && /^motd=Carried over$/m.test(props), 'server.properties changed');
    assert((await api('GET', `/servers/${server.id}/file?path=ci-upgrade.txt`)).body?.file?.content === 'from the old version\n', 'file lost');
    if (seeded.groupColor) {
        const group = (await api('GET', '/groups')).body.groups.find((g) => g.name === 'CI Upgrade Group');
        assert(group?.color === '#123456', `group colour ${group?.color}`);
    }
    if (seeded.schedule) assert(s.backupSchedule?.enabled === true, 'backup schedule lost');
});
await run.step('keeps its backups, events and templates', async () => {
    const backups = (await api('GET', `/servers/${server.id}/backups`)).body.backups;
    assert(backups.length === 1 && backups[0].name === 'CI old backup', `backups: ${JSON.stringify(backups.map((b) => b.name))}`);
    const zip = await fetch(`${BASE_URL}/api/v1/servers/${server.id}/backups/${backups[0].id}/download`, { headers: { authorization: `Bearer ${key}` } });
    assert(zip.status === 200 && (await zip.arrayBuffer()).byteLength === backups[0].size, `backup download: HTTP ${zip.status}`);
    const events = (await api('GET', `/servers/${server.id}/events?limit=200`)).body.events.map((e) => e.type);
    assert(events.includes('backup_create') && events.includes('started'), `events: ${events.join(', ')}`);
    const t = (await api('GET', `/templates/${seeded.template.id}`)).body?.template;
    assert(t?.name === 'CI Old Template' && t.version === MC_VERSION && t.memory === 1536, `template: ${JSON.stringify(t)}`);
});
await run.step('runs the startup migrations', async () => {
    const interrupted = (await api('GET', `/servers/${planted.provisioning}`)).body?.server;
    assert(interrupted?.state === 'crashed' && interrupted.crashReason === 'Provisioning interrupted by restart',
        `interrupted provision: ${interrupted?.state} (${interrupted?.crashReason})`);
    assertStatus(await api('GET', `/servers/${planted.failed}`), 404, 'failed provision not purged');
    const dir = docker(['exec', NEW, 'sh', '-c', `test -e /app/data/servers/${planted.failed} && echo left || echo gone`]).trim();
    assert(dir === 'gone', 'the failed provision\'s directory was left behind');
    const neo = (await api('GET', `/templates/${planted.neoTemplate}`)).body?.template;
    assert(neo?.version === '26.1.2', `NeoForge template relabelled to ${neo?.version}`);
});
await run.step('starts the server on the new version', async () => {
    await withUpstream(['mojang'], async () => {
        assertStatus(await api('POST', `/servers/${server.id}/start`), 200, 'start');
        await waitForState(api, server.id, ['running'], { timeoutMs: 5 * 60_000 });
    });
    assertStatus(await api('POST', `/servers/${server.id}/stop`), 200, 'stop');
    await waitForState(api, server.id, ['stopped'], { timeoutMs: 120_000 });
});

// Keep the containers for their logs if anything failed; CI throws them away
if (run.failed === 0 && !process.env.GITHUB_ACTIONS) {
    for (const name of [OLD, NEW]) removeOurs(name);
    docker(['volume', 'rm', VOLUME]);
}
run.finish();
