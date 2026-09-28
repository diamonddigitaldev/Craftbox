// Operations test: what the panel does to a real server over time, on vanilla
// servers started for real. Two sections, each on a fresh instance, so CI
// can run them side by side:
//
// - lifecycle: a version upgrade (and the refusals around it), restart,
//   restart behind a backup, kill, the guards on a running server, crash
//   detection and auto-restart (the JVM killed inside the container), a
//   restore-point settings save, and auto-start across a panel restart;
// - backups: backup, download, restore, restore-point Properties saves,
//   backing up and restoring a running server, and the schedule and
//   retention settings.
//
//   CRAFTBOX_URL=http://localhost:6464 CRAFTBOX_CONTAINER=craftbox node test/ci/operations.mjs [lifecycle|backups]
//
// Without CRAFTBOX_CONTAINER the checks that reach into the container (the
// crash and auto-start ones) are skipped.

import {
    CONTAINER, waitForPanel, openPanel, apiClient, provisionServer, waitForState, withUpstream,
    transientError, openSocket, docker, zipEntries, BASE_URL, createRunner, assert, assertStatus, sleep
} from './lib.mjs';

const PROVISION_TIMEOUT = 10 * 60_000;
const START_TIMEOUT = 5 * 60_000;
const sections = process.argv.slice(2).length ? process.argv.slice(2) : ['lifecycle', 'backups'];

const run = createRunner(`Operations test (${sections.join(', ')})`);
await waitForPanel();
const { key, session } = await openPanel();
const api = apiClient(key);
let socket = await openSocket({ cookie: session.cookie });

const server = async (id) => (await api('GET', `/servers/${id}`)).body.server;
const readFile = async (id, path) => (await api('GET', `/servers/${id}/file?path=${encodeURIComponent(path)}`)).body?.file?.content;
const eventTypes = async (id) => (await api('GET', `/servers/${id}/events?limit=200`)).body.events.map((e) => e.type);
const backups = async (id) => (await api('GET', `/servers/${id}/backups`)).body.backups;

async function start(id) {
    await withUpstream(['mojang'], async () => {
        assertStatus(await api('POST', `/servers/${id}/start`), 200, 'start');
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT });
    });
}
async function stop(id) {
    assertStatus(await api('POST', `/servers/${id}/stop`), 200, 'stop');
    await waitForState(api, id, ['stopped'], { timeoutMs: 120_000 });
}

// Wait for an async operation's final message (not its progress) after `since`
async function operation(id, name, since, timeoutMs = 180_000) {
    const msg = await socket.waitFor((m) => m.type === 'operation' && m.serverId === id && m.operation === name && m.status !== 'progress',
        { since, what: `the ${name} operation to finish`, timeoutMs });
    assert(msg.status === 'complete', `${name} ${msg.status}: ${msg.error || JSON.stringify(msg.payload)}`);
    return msg;
}

// Signal the JVM from inside the container, as something other than the
// panel would: SIGTERM makes it exit 143, SIGKILL is what the OOM killer sends
function signalJava(signal) {
    docker(['exec', CONTAINER, 'pkill', `-${signal}`, '-f', 'java']);
}

async function vanillaVersions() {
    return withUpstream(['mojang'], async () => {
        const res = await api('GET', '/versions?type=vanilla');
        if (res.status === 500) throw transientError(`versions: HTTP 500 ${res.text}`);
        assertStatus(res, 200, 'versions');
        return { latest: res.body.latest, stable: res.body.versions.filter((v) => v.channel === 'stable').map((v) => v.id) };
    });
}

// ── Lifecycle ──

async function lifecycle() {
    console.log('Lifecycle');
    const { latest, stable } = await vanillaVersions();
    const previous = stable[stable.indexOf(latest) + 1];
    let id = null;

    await run.step(`creates a vanilla server on the previous release (${previous})`, async () => {
        assert(previous, 'no release before the latest');
        id = (await provisionServer(api, {
            name: 'CI Lifecycle', serverType: 'vanilla', version: previous, port: 25565, memory: 1536, eula: true
        }, { timeoutMs: PROVISION_TIMEOUT, label: 'vanilla' })).id;
        socket.send({ type: 'subscribe', serverId: id });
        await socket.waitFor((m) => m.type === 'subscribed' && m.serverId === id, { what: 'subscribed' });
    });
    if (!id) return;

    await run.step('offers vanilla no build upgrade, and says why', async () => {
        const res = await api('GET', `/servers/${id}/check-upgrade`);
        assertStatus(res, 200, 'check-upgrade');
        assert(res.body.upgradeAvailable === false && /no build tracking/i.test(res.body.reason), JSON.stringify(res.body));
    });
    await run.step(`upgrades it to ${latest}, refusing bad versions and downgrades`, async () => {
        assertStatus(await api('POST', `/servers/${id}/upgrade-jar`, { version: '../1.21' }), 400, 'bad version');
        const older = stable[stable.indexOf(previous) + 1];
        const down = await api('POST', `/servers/${id}/upgrade-jar`, { version: older });
        assert(down.status === 400 && /downgrade/i.test(down.body?.error), `downgrade to ${older}: ${down.status} ${down.text}`);
        const since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/upgrade-jar`, { version: latest }), 202, 'upgrade');
        const done = await withUpstream(['mojang'], () => operation(id, 'jar-upgrade', since));
        assert(done.payload?.version === latest, `operation payload ${JSON.stringify(done.payload)}`);
        const s = await waitForState(api, id, ['stopped'], { timeoutMs: 60_000 });
        assert(s.version === latest && s.javaMajor, `recorded version ${s.version}, Java ${s.javaMajor}`);
        assert((await eventTypes(id)).includes('jar_upgrade'), 'no jar_upgrade event');
        const edit = await api('POST', `/servers/${id}/edit`, { name: 'CI Lifecycle', port: 25565, memory: 1536, version: previous });
        assertStatus(edit, 400, 'downgrade through Settings');
    });

    let running = false;
    await run.step('starts, then restarts', async () => {
        await start(id);
        running = true;
        const since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/restart`), 200, 'restart');
        await socket.waitFor((m) => m.type === 'state' && m.serverId === id && m.state === 'running', { since, what: 'running again', timeoutMs: START_TIMEOUT });
        const states = socket.messages.slice(since).filter((m) => m.type === 'state' && m.serverId === id).map((m) => m.state);
        assert(states.join() === 'stopping,stopped,starting,running', `states: ${states.join()}`);
        const stopped = socket.messages.slice(since).find((m) => m.type === 'state' && m.state === 'stopped');
        assert(stopped.restarting === true, 'the stopped broadcast of a restart didn\'t say it was restarting');
        assert((await eventTypes(id)).includes('restarted'), 'no restarted event');
    });
    if (!running) return;

    await run.step('guards a running server', async () => {
        const cases = [
            ['backup without stopFirst', 'POST', `/servers/${id}/backups`, {}, 409],
            ['jar upgrade', 'POST', `/servers/${id}/upgrade-jar`, {}, 409],
            ['delete', 'DELETE', `/servers/${id}`, undefined, 409],
            ['rename a file', 'POST', `/servers/${id}/files/rename`, { path: 'server.properties', newName: 'x.properties' }, 409],
            ['start', 'POST', `/servers/${id}/start`, undefined, 400]
        ];
        const wrong = [];
        for (const [what, method, path, body, status] of cases) {
            const res = await api(method, path, body);
            if (res.status !== status) wrong.push(`${what}: ${res.status}, expected ${status}`);
        }
        assert(wrong.length === 0, wrong.join('\n'));
        assert((await server(id)).state === 'running', 'no longer running');
    });
    await run.step('restarts behind a backup', async () => {
        const since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/restart`, { backup: true }), 202, 'restart with backup');
        await operation(id, 'backup', since);
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT });
        assert((await backups(id)).some((b) => b.name === 'Pre-restart backup'), 'no Pre-restart backup');
    });
    await run.step('kills it', async () => {
        assertStatus(await api('POST', `/servers/${id}/kill`), 200, 'kill');
        const s = await waitForState(api, id, ['stopped', 'crashed'], { timeoutMs: 60_000 });
        assert(s.state === 'stopped' && !s.crashReason, `a kill left it ${s.state} (${s.crashReason})`);
    });

    await run.step('saves settings behind a restore point while running, and restarts', async () => {
        await start(id);
        const since = socket.mark();
        const res = await api('POST', `/servers/${id}/edit`, { name: 'CI Lifecycle', port: 25565, memory: 1536, difficulty: 'hard', backup: true });
        assertStatus(res, 202, 'edit with backup');
        await operation(id, 'backup', since);
        const saved = await operation(id, 'settings-save', since);
        assert(saved.payload?.restarted === true, `payload ${JSON.stringify(saved.payload)}`);
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT });
        assert(/^difficulty=hard$/m.test(await readFile(id, 'server.properties')), 'difficulty not saved');
        assert((await backups(id)).some((b) => b.name === 'Pre-edit backup'), 'no Pre-edit backup');
    });

    // The rest reach into the container
    const crash = 'detects a crash, and keeps its details off the status page';
    const autoRestart = 'restarts itself after a crash when auto-restart is on';
    const signalled = 'detects a JVM killed by a signal (as the kernel\'s OOM killer does)';
    const autoStart = 'auto-starts across a panel restart only when asked to';
    if (!CONTAINER) {
        for (const name of [crash, autoRestart, signalled, autoStart]) run.skip(name, 'CRAFTBOX_CONTAINER not set');
        // Leave the port free for whatever uses this panel next
        if ((await server(id)).state === 'running') await stop(id);
        return;
    }

    await run.step(crash, async () => {
        if ((await server(id)).state !== 'running') await start(id);
        const since = socket.mark();
        signalJava('TERM'); // the JVM exits 143
        const s = await waitForState(api, id, ['crashed', 'stopped'], { timeoutMs: 60_000 });
        assert(s.state === 'crashed' && s.crashReason === 'exit_code' && s.exitCode === 143,
            `state ${s.state}, crashReason ${s.crashReason}, exitCode ${s.exitCode}`);
        await socket.waitFor((m) => m.type === 'event' && m.serverId === id && m.eventType === 'crashed', { since, what: 'crashed event' });
        const pub = (await (await fetch(`${BASE_URL}/status/${id}/api`)).json()).server;
        assert(pub.state === 'crashed' && !('crashReason' in pub) && !('exitCode' in pub), `public: ${JSON.stringify(pub)}`);
    });
    await run.step(autoRestart, async () => {
        assertStatus(await api('POST', `/servers/${id}/autorestart`, { enabled: true }), 200, 'autorestart');
        await start(id);
        const since = socket.mark();
        signalJava('TERM');
        await socket.waitFor((m) => m.type === 'state' && m.serverId === id && m.state === 'crashed', { since, what: 'the crash' });
        await socket.waitFor((m) => m.type === 'state' && m.serverId === id && m.state === 'running', { since, what: 'running again', timeoutMs: START_TIMEOUT });
    });
    await run.step(signalled, async () => {
        const since = socket.mark();
        signalJava('KILL');
        const exit = await socket.waitFor((m) => m.type === 'state' && m.serverId === id && ['crashed', 'stopped'].includes(m.state), { since, what: 'the exit' });
        assert(exit.state === 'crashed' && exit.crashReason === 'signal' && exit.exitCode === null,
            `recorded as ${exit.state} (exitCode ${exit.exitCode}, crashReason ${exit.crashReason}), so auto-restart never fires`);
        await socket.waitFor((m) => m.type === 'event' && m.serverId === id && m.eventType === 'crashed', { since, what: 'crashed event' });
        await socket.waitFor((m) => m.type === 'state' && m.serverId === id && m.state === 'running', { since, what: 'the auto-restart', timeoutMs: START_TIMEOUT });
    });
    await run.step(autoStart, async () => {
        const restartPanel = async () => {
            socket.close();
            docker(['restart', '-t', '60', CONTAINER]);
            await waitForPanel();
            socket = await openSocket({ cookie: session.cookie });
        };
        assertStatus(await api('POST', `/servers/${id}/autostart`, { enabled: false }), 200, 'autostart off');
        await restartPanel();
        await sleep(5000);
        const after = await server(id);
        assert(after.state === 'stopped', `with auto-start off it came back ${after.state}`);
        assert(after.name === 'CI Lifecycle' && after.version === latest, 'the record changed across the restart');

        assertStatus(await api('POST', `/servers/${id}/autostart`, { enabled: true }), 200, 'autostart on');
        await restartPanel();
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT });
        const started = (await api('GET', `/servers/${id}/events?limit=5`)).body.events.find((e) => e.type === 'started');
        assert(started?.initiatedBy === 'Auto Start', `started by ${started?.initiatedBy}`);
    });
    if ((await server(id)).state === 'running') await stop(id);
}

// ── Backups ──

async function backupsSection() {
    console.log('Backups');
    let id = null;
    await run.step('creates a vanilla server', async () => {
        id = (await provisionServer(api, {
            name: 'CI Backups', serverType: 'vanilla', version: 'latest', port: 25566, memory: 1536, eula: true
        }, { timeoutMs: PROVISION_TIMEOUT, label: 'vanilla' })).id;
        socket.send({ type: 'subscribe', serverId: id });
        await socket.waitFor((m) => m.type === 'subscribed' && m.serverId === id, { what: 'subscribed' });
    });
    if (!id) return;

    let backupId = null;
    await run.step('backs up, and serves the archive', async () => {
        assertStatus(await api('POST', `/servers/${id}/edit-file`, { filePath: 'ci-restore.txt', content: 'original\n' }), 200, 'seed file');
        const since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/backups`, { name: 'CI restore point' }), 202, 'backup');
        const done = await operation(id, 'backup', since);
        backupId = done.payload?.backup?.id || (await backups(id)).find((b) => b.name === 'CI restore point')?.id;
        assert(backupId, 'no backup id');
        const res = await fetch(`${BASE_URL}/api/v1/servers/${id}/backups/${backupId}/download`, { headers: { authorization: `Bearer ${key}` } });
        const zip = Buffer.from(await res.arrayBuffer());
        assert(res.status === 200 && /zip/.test(res.headers.get('content-type')), `download: ${res.status} ${res.headers.get('content-type')}`);
        assert(Number(res.headers.get('content-length')) === zip.length, 'Content-Length doesn\'t match the body');
        const names = zipEntries(zip);
        assert(names.includes('ci-restore.txt') && names.includes('server.properties'), `archive holds ${names.slice(0, 10).join(', ')}…`);
    });
    await run.step('restores it over later changes', async () => {
        assertStatus(await api('POST', `/servers/${id}/edit-file`, { filePath: 'ci-restore.txt', content: 'changed\n' }), 200, 'change');
        assertStatus(await api('POST', `/servers/${id}/edit-file`, { filePath: 'ci-extra.txt', content: 'added later\n' }), 200, 'add');
        const since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/backups/${backupId}/restore`), 202, 'restore');
        await operation(id, 'restore', since);
        await waitForState(api, id, ['stopped'], { timeoutMs: 60_000 });
        assert(await readFile(id, 'ci-restore.txt') === 'original\n', 'file not restored');
        assertStatus(await api('GET', `/servers/${id}/file?path=ci-extra.txt`), 404, 'a file added after the backup');
        assert((await eventTypes(id)).includes('backup_restore'), 'no backup_restore event');
    });
    await run.step('saves Properties behind a restore point', async () => {
        const since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/properties`, { 'max-players': 9, backup: true }), 202, 'properties with backup');
        await operation(id, 'backup', since);
        const saved = await operation(id, 'settings-save', since);
        assert(saved.payload?.restarted === false, `a stopped server was restarted: ${JSON.stringify(saved.payload)}`);
        const props = await readFile(id, 'server.properties');
        assert(/^max-players=9$/m.test(props) && !/^backup=/m.test(props), 'not saved, or `backup` written as a property');
        assert((await backups(id)).some((b) => b.name === 'Pre-properties backup'), 'no Pre-properties backup');
    });
    await run.step('backs up and restores a running server, starting it again after', async () => {
        await start(id);
        let since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/backups`, { name: 'CI live', stopFirst: true, startAfter: true }), 202, 'backup');
        await operation(id, 'backup', since);
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT });
        since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/backups/${backupId}/restore`, { startAfter: true }), 202, 'restore');
        await operation(id, 'restore', since);
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT });
        await stop(id);
    });
    await run.step('keeps the backup schedule within range', async () => {
        const schedule = async (body, status = 200) => {
            const res = await api('POST', `/servers/${id}/backup-schedule`, body);
            assert(res.status === status, `${JSON.stringify(body)}: HTTP ${res.status}, expected ${status}`);
            return (await server(id)).backupSchedule;
        };
        let s = await schedule({ enabled: true, intervalHours: 12, countdownMinutes: 3 });
        assert(s.enabled === true && s.intervalHours === 12 && s.countdownMinutes === 3, JSON.stringify(s));
        const res = await api('POST', `/servers/${id}/backup-schedule`, { enabled: true, intervalHours: 12, countdownMinutes: 3 });
        const next = Date.parse(res.body.nextBackupAt) - Date.now();
        assert(next > 11 * 3600_000 && next <= 12 * 3600_000, `next backup in ${Math.round(next / 60_000)} minutes`);
        // Refused whole, so the valid half of the last one isn't saved either
        for (const bad of [{ intervalHours: 0 }, { intervalHours: 169 }, { intervalHours: -5 }, { intervalHours: '12abc' },
            { intervalHours: 1.5 }, { countdownMinutes: 0 }, { countdownMinutes: 31 }, { countdownMinutes: 'soon' },
            { enabled: 'yes' }, { intervalHours: 6, countdownMinutes: 31 }]) {
            s = await schedule(bad, 400);
            assert(s.enabled === true && s.intervalHours === 12 && s.countdownMinutes === 3, `${JSON.stringify(bad)} was stored: ${JSON.stringify(s)}`);
        }
        s = await schedule({ intervalHours: '6', countdownMinutes: null });
        assert(s.intervalHours === 6 && s.countdownMinutes === 3, `a digit string, and null for "keep": ${JSON.stringify(s)}`);
        s = await schedule({ enabled: false });
        assert(s.enabled === false, 'not disabled');
        assert((await api('POST', `/servers/${id}/backup-schedule`, {})).body.nextBackupAt === null, 'a disabled schedule has a next backup');
    });
    await run.step('keeps retention within range and applies it', async () => {
        const retention = async (body, status = 200) => {
            const res = await api('POST', `/servers/${id}/backup-retention`, body);
            assert(res.status === status, `${JSON.stringify(body)}: HTTP ${res.status}, expected ${status}`);
            return (await server(id)).backupSchedule;
        };
        let s = await retention({ retentionCount: 2, retentionDays: 0 });
        assert(s.retentionCount === 2 && s.retentionDays === 0, JSON.stringify(s));
        for (const bad of [{ retentionCount: -1 }, { retentionCount: 101 }, { retentionCount: '3x' }, { retentionDays: 366 },
            { retentionDays: -1 }, { retentionDays: 0.5 }, { retentionCount: 4, retentionDays: 366 }]) {
            s = await retention(bad, 400);
            assert(s.retentionCount === 2 && s.retentionDays === 0, `${JSON.stringify(bad)} was stored: ${JSON.stringify(s)}`);
        }
        for (const name of ['CI retention 1', 'CI retention 2']) {
            const since = socket.mark();
            assertStatus(await api('POST', `/servers/${id}/backups`, { name }), 202, name);
            await operation(id, 'backup', since);
        }
        const names = (await backups(id)).map((b) => b.name).sort();
        assert(names.join() === 'CI retention 1,CI retention 2', `kept: ${names.join(', ')}`);
    });
}

if (sections.includes('lifecycle')) await lifecycle();
if (sections.includes('backups')) await backupsSection();

socket.close();
run.finish();
