// WebSocket test: the live protocol the panel's pages run on (docs/API.md,
// "WebSocket protocol"), against a vanilla server started for real. Session
// auth on the upgrade, subscribing, the console stream, `command` (whose
// field is `line`), state, event, operation and change broadcasts, and the
// public /ws/status socket's reduced view.
//
//   CRAFTBOX_URL=http://localhost:6464 node test/ci/websocket.mjs

import {
    waitForPanel, bootstrapPanel, apiClient, provisionServer, waitForState, withUpstream,
    openSocket, upgradeStatus, createRunner, assert, assertStatus, sleep
} from './lib.mjs';

const PROVISION_TIMEOUT = 10 * 60_000;
const START_TIMEOUT = 5 * 60_000;
const CLIENT_ID = 'ci-websocket-test';

const run = createRunner('WebSocket test');
await waitForPanel();
const { key, session } = await bootstrapPanel();
const api = apiClient(key);
const tagged = (method, path, body) => api(method, path, body, { headers: { 'x-client-id': CLIENT_ID } });

let socket = null;
let pub = null;
let id = null;

console.log('Connecting');
await run.step('refuses an upgrade without a signed-in session', async () => {
    assert(await upgradeStatus('/') === 401, 'no cookie');
    assert(await upgradeStatus('/', { cookie: 'connect.sid=s%3Anot-a-session.sig' }) === 401, 'forged cookie');
    assert(await upgradeStatus('/', { authorization: `Bearer ${key}` }) === 401, 'an API key is not a session');
});
await run.step('opens for a session, and publicly on /ws/status', async () => {
    socket = await openSocket({ cookie: session.cookie });
    pub = await openSocket({ path: '/ws/status' });
});
if (!socket || !pub) {
    run.finish();
    process.exit();
}
await run.step('answers ping and reports protocol errors', async () => {
    const reply = async (msg, what) => {
        const since = socket.mark();
        socket.send(msg);
        return socket.waitFor((m) => m.type === 'pong' || m.type === 'error', { since, what, timeoutMs: 5000 });
    };
    assert((await reply({ type: 'ping' }, 'pong')).type === 'pong', 'no pong');
    for (const [msg, error] of [
        ['not json', 'Invalid JSON.'],
        [{ type: 'bogus' }, 'Unknown message type: bogus'],
        [{ type: 'subscribe' }, 'Missing serverId.'],
        [{ type: 'command', line: 'list' }, 'Missing serverId or line.']
    ]) {
        const got = await reply(msg, `error for ${JSON.stringify(msg)}`);
        assert(got.type === 'error' && got.message === error, `${JSON.stringify(msg)}: ${JSON.stringify(got)}`);
    }
});

console.log('Server');
await run.step('tells every signed-in socket, and no public one, when servers change', async () => {
    const since = socket.mark();
    const pubSince = pub.mark();
    const server = await provisionServer(api, {
        name: 'CI WebSocket', serverType: 'vanilla', version: 'latest', port: 25565, memory: 1536, eula: true
    }, { timeoutMs: PROVISION_TIMEOUT, label: 'vanilla' });
    id = server.id;
    await socket.waitFor((m) => m.type === 'dashboard-changed', { since, what: 'dashboard-changed on create' });
    const regroup = socket.mark();
    assertStatus(await tagged('POST', `/servers/${id}/group`, { group: 'CI' }), 200, 'group');
    const msg = await socket.waitFor((m) => m.type === 'dashboard-changed', { since: regroup, what: 'dashboard-changed on regroup' });
    assert(msg.origin === CLIENT_ID, `origin ${JSON.stringify(msg.origin)}, expected the request's X-Client-Id`);
    assert(!pub.messages.slice(pubSince).some((m) => m.type === 'dashboard-changed'), 'the public socket was told');
});
if (!id) {
    run.finish();
    process.exit();
}
await run.step('sends a snapshot on subscribe, fuller for a session than in public', async () => {
    socket.send({ type: 'subscribe', serverId: id });
    pub.send({ type: 'subscribe', serverId: id });
    const full = await socket.waitFor((m) => m.type === 'subscribed' && m.serverId === id, { what: 'subscribed' });
    const reduced = await pub.waitFor((m) => m.type === 'subscribed' && m.serverId === id, { what: 'public subscribed' });
    assert(full.state === 'stopped' && Array.isArray(full.history) && 'crashReason' in full, `session: ${JSON.stringify(full)}`);
    assert(reduced.state === 'stopped', `public state ${reduced.state}`);
    const leaked = ['history', 'crashReason', 'exitCode'].filter((k) => k in reduced);
    assert(leaked.length === 0, `public snapshot has ${leaked.join(', ')}`);
});
await run.step('refuses a command while the server is stopped', async () => {
    const since = socket.mark();
    socket.send({ type: 'command', serverId: id, line: 'list' });
    const got = await socket.waitFor((m) => m.type === 'error', { since, what: 'error', timeoutMs: 5000 });
    assert(got.message === 'Server is not running.', got.message);
});
await run.step('tells subscribers a listing changed, naming the directory', async () => {
    const since = socket.mark();
    assertStatus(await tagged('POST', `/servers/${id}/files/mkdir`, { name: 'ci-ws' }), [200, 201], 'mkdir');
    const msg = await socket.waitFor((m) => m.type === 'content-changed' && m.serverId === id, { since, what: 'content-changed' });
    assert(msg.scope === 'files' && msg.path === '' && msg.origin === CLIENT_ID, JSON.stringify(msg));
});

console.log('Running');
let running = false;
await run.step('streams state changes and console output from a start', async () => {
    const since = socket.mark();
    const pubSince = pub.mark();
    await withUpstream(['mojang'], async () => {
        assertStatus(await api('POST', `/servers/${id}/start`), 200, 'start');
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT, label: 'vanilla' });
    });
    running = true;
    const states = () => socket.messages.slice(since).filter((m) => m.type === 'state' && m.serverId === id).map((m) => m.state);
    await socket.waitFor((m) => m.type === 'state' && m.state === 'running', { since, what: 'state running' });
    assert(states().join() === 'starting,running', `states: ${states().join()}`);
    const done = await socket.waitFor((m) => m.type === 'console' && /Done \(/.test(m.line), { since, what: 'the "Done" line' });
    assert(done.serverId === id && done.timestamp, JSON.stringify(done));
    const started = await socket.waitFor((m) => m.type === 'event' && m.eventType === 'started', { since, what: 'started event' });
    assert(started.serverId === id && started.createdAt, JSON.stringify(started));

    await pub.waitFor((m) => m.type === 'state' && m.state === 'running', { since: pubSince, what: 'public state running' });
    await pub.waitFor((m) => m.type === 'event' && m.eventType === 'started', { since: pubSince, what: 'public started event' });
    assert(!pub.messages.slice(pubSince).some((m) => m.type === 'console'), 'console output reached the public socket');
});
if (running) {
    await run.step('runs a `command` message and streams the reply', async () => {
        const since = socket.mark();
        socket.send({ type: 'command', serverId: id, line: 'list' });
        await socket.waitFor((m) => m.type === 'console' && /There are \d+ (of a max of \d+ )?players online/i.test(m.line),
            { since, what: 'the reply to "list"' });
        socket.send({ type: 'command', serverId: id, line: 'say hello from the CI WebSocket test' });
        await socket.waitFor((m) => m.type === 'console' && /hello from the CI WebSocket test/.test(m.line), { since, what: 'the "say" echo' });
    });
    await run.step('refuses commands on the public socket', async () => {
        const since = pub.mark();
        pub.send({ type: 'command', serverId: id, line: 'op someone' });
        const got = await pub.waitFor((m) => m.type === 'error', { since, what: 'error', timeoutMs: 5000 });
        assert(got.message === 'Commands not available on public connections.', got.message);
        await sleep(1000);
        assert(!socket.messages.some((m) => m.type === 'console' && /someone/.test(m.line)), 'the command ran');
    });
    await run.step('streams the stop', async () => {
        const since = socket.mark();
        assertStatus(await api('POST', `/servers/${id}/stop`), 200, 'stop');
        await socket.waitFor((m) => m.type === 'state' && m.state === 'stopped', { since, what: 'state stopped', timeoutMs: 120_000 });
        const states = socket.messages.slice(since).filter((m) => m.type === 'state').map((m) => m.state);
        assert(states.join() === 'stopping,stopped', `states: ${states.join()}`);
        await socket.waitFor((m) => m.type === 'event' && m.eventType === 'stopped', { since, what: 'stopped event' });
    });
}

console.log('Operations');
await run.step('reports a backup as an `operation`', async () => {
    const since = socket.mark();
    assertStatus(await api('POST', `/servers/${id}/backups`, { name: 'CI WebSocket' }), 202, 'backup');
    const msg = await socket.waitFor((m) => m.type === 'operation' && m.operation === 'backup' && m.status !== 'progress',
        { since, what: 'backup operation', timeoutMs: 120_000 });
    assert(msg.status === 'complete' && msg.serverId === id, JSON.stringify(msg));
    const states = socket.messages.slice(since).filter((m) => m.type === 'state').map((m) => m.state);
    assert(states.join() === 'backing_up,stopped', `states: ${states.join()}`);
});
await run.step('tells subscribers when the event log is cleared', async () => {
    const since = socket.mark();
    assertStatus(await api('POST', `/servers/${id}/events/clear`), 200, 'clear');
    await socket.waitFor((m) => m.type === 'events_cleared' && m.serverId === id, { since, what: 'events_cleared' });
});
await run.step('stops sending after unsubscribe', async () => {
    socket.send({ type: 'unsubscribe', serverId: id });
    await sleep(500);
    const since = socket.mark();
    assertStatus(await api('POST', `/servers/${id}/files/mkdir`, { name: 'ci-ws-2' }), [200, 201], 'mkdir');
    await sleep(2000);
    const got = socket.messages.slice(since).filter((m) => m.serverId === id);
    assert(got.length === 0, `still received ${got.map((m) => m.type).join(', ')}`);
});

socket.close();
pub.close();
run.finish();
