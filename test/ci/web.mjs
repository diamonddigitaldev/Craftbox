// Web test: the panel as a browser sees it, over plain HTTP on a fresh
// instance. The setup wizard's validation, then every page rendering (and
// every script and stylesheet they load), signing in and out, CSRF, the
// session cookie and its expiry, the public status pages, and last, because
// it locks this address out of signing in for 15 minutes, the login rate
// limit.
//
//   CRAFTBOX_URL=http://localhost:6464 CRAFTBOX_CONTAINER=craftbox node test/ci/web.mjs
//
// CRAFTBOX_CONTAINER is optional; without it the session-expiry check, which
// ages the session in the container's database, is skipped.

import {
    BASE_URL, CONTAINER, CI_USER, waitForPanel, createSession, apiClient, provisionServer, panelPages,
    containerExec, makeModJar, zipEntries, createRunner, assert, assertStatus
} from './lib.mjs';

const PROVISION_TIMEOUT = 10 * 60_000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

const run = createRunner('Web test');
await waitForPanel();

const anon = createSession();
const title = (html) => /<title>([^<]*)<\/title>/.exec(html)?.[1]?.replace(/&amp;/g, '&');
const flash = (html) => /text-bg-danger[\s\S]*?<\/span>\s*([^<]+?)\s*<\/div>/.exec(html)?.[1];
const sidOf = (cookie) => /connect\.sid=([^;]+)/.exec(cookie)?.[1];

console.log('Before setup');
await run.step('sends every page to the setup wizard and refuses the API', async () => {
    for (const path of ['/', '/dashboard', '/login', '/servers/create']) {
        const res = await anon.get(path);
        assert(res.status === 302 && res.location === '/setup', `${path}: ${res.status} → ${res.location}`);
    }
    const api = await anon.get('/api/v1/servers');
    assert(api.status === 503 && api.body?.error === 'setup_required', `API: ${api.status} ${api.text}`);
    assertStatus(await anon.get('/status'), 200, 'the status index needs no setup');
});

const setup = createSession();
await run.step('validates the setup form', async () => {
    assertStatus(await setup.get('/setup'), 200, 'setup page');
    const cases = [
        ['nothing', { username: '', password: '', confirmPassword: '' }, 'All fields are required.'],
        ['a short username', { username: 'ab', password: 'long-enough-1', confirmPassword: 'long-enough-1' }, 'Username must be 3-32 characters.'],
        ['a long username', { username: 'a'.repeat(33), password: 'long-enough-1', confirmPassword: 'long-enough-1' }, 'Username must be 3-32 characters.'],
        ['a bad character', { username: 'bad name', password: 'long-enough-1', confirmPassword: 'long-enough-1' }, 'Username can only contain letters, numbers, hyphens, and underscores.'],
        ['a short password', { username: 'ci-admin', password: 'short', confirmPassword: 'short' }, 'Password must be at least 8 characters.'],
        ['mismatched passwords', { username: 'ci-admin', password: 'long-enough-1', confirmPassword: 'long-enough-2' }, 'Passwords do not match.']
    ];
    for (const [what, form, message] of cases) {
        const res = await setup.post('/setup', form);
        assert(res.status === 302 && res.location === '/setup', `${what}: ${res.status} → ${res.location}`);
        const shown = flash((await setup.get('/setup')).text);
        assert(shown === message, `${what}: showed ${JSON.stringify(shown)}, expected ${JSON.stringify(message)}`);
    }
});
await run.step('refuses a setup form posted without its CSRF token', async () => {
    const res = await setup.post('/setup', { username: 'intruder', password: 'long-enough-1', confirmPassword: 'long-enough-1' }, { csrf: null });
    assert(res.status === 302 && res.location === '/login', `${res.status} → ${res.location}`);
    assertStatus(await anon.get('/setup'), 200, 'setup still open');
});

console.log('Setup');
let session = null;
let api = null;
await run.step('creates the admin account and signs in', async () => {
    const before = sidOf(setup.cookie);
    const res = await setup.post('/setup', { ...CI_USER, confirmPassword: CI_USER.password });
    assert(res.status === 302 && res.location === '/dashboard', `${res.status} → ${res.location}`);
    assert(sidOf(setup.cookie) !== before, 'signing in kept the pre-login session id');
    assertStatus(await setup.get('/dashboard'), 200, 'dashboard after setup');
    session = setup;
    await session.get('/account');
    const key = await session.api('POST', '/account/apikeys', { name: 'CI' });
    assertStatus(key, 201, 'API key');
    api = apiClient(key.body.key);
});
if (!api) {
    run.finish();
    process.exit();
}
await run.step('won\'t run setup a second time', async () => {
    const fresh = createSession();
    assert((await fresh.get('/setup')).location === '/dashboard', 'setup page still offered');
    await fresh.get('/login');
    const res = await fresh.post('/setup', { username: 'second-admin', password: 'long-enough-1', confirmPassword: 'long-enough-1' });
    assert(res.status === 302 && res.location !== '/setup', `second setup: ${res.status} → ${res.location}`);
});

console.log('Pages');
let vanilla = null;
let fabric = null;
await run.step('creates a vanilla and a Fabric server to show', async () => {
    const base = { version: 'latest', memory: 1024, eula: true };
    vanilla = await provisionServer(api, { ...base, name: 'CI Web', serverType: 'vanilla', port: 25565, group: 'CI Group' },
        { timeoutMs: PROVISION_TIMEOUT, label: 'vanilla' });
    let sawStoppedWhileProvisioning = null;
    fabric = await provisionServer(api, { ...base, name: 'CI Web Fabric', serverType: 'fabric', port: 25566 }, {
        timeoutMs: PROVISION_TIMEOUT, label: 'fabric',
        // The public view reports internal states as stopped
        onCreated: async (res) => {
            sawStoppedWhileProvisioning = (await anon.get(`/status/${res.body.server.id}/api`)).body?.server?.state;
        }
    });
    assert(sawStoppedWhileProvisioning === 'stopped', `a provisioning server showed publicly as "${sawStoppedWhileProvisioning}"`);
    assertStatus(await api('POST', `/servers/${vanilla.id}/files/mkdir`, { name: 'ci-dir' }), [200, 201], 'mkdir');
});

const pages = () => vanilla && fabric ? panelPages(vanilla, fabric) : [];

const rendered = new Map();
await run.step('renders every page', async () => {
    const wrong = [];
    for (const [path, want] of pages()) {
        const res = await session.get(path);
        rendered.set(path, res);
        if (res.status !== 200) wrong.push(`${path}: HTTP ${res.status} ${res.location}`);
        else if (title(res.text) !== `${want} | Craftbox`) wrong.push(`${path}: title "${title(res.text)}"`);
        else if (!/<\/html>\s*$/.test(res.text)) wrong.push(`${path}: page cut short`);
    }
    assert(wrong.length === 0, wrong.join('\n'));
});
await run.step('serves every script, stylesheet and image the pages use', async () => {
    const assets = new Set();
    for (const res of rendered.values()) {
        for (const [, url] of res.text.matchAll(/<(?:script|img)[^>]+src="(\/[^"/][^"]*)"/g)) assets.add(url);
        for (const [, url] of res.text.matchAll(/<link[^>]+href="(\/[^"/][^"]*)"/g)) assets.add(url);
    }
    assert(assets.size > 10, `only found ${assets.size} assets`);
    const types = { js: /javascript/, css: /text\/css/, png: /image\/png/, svg: /image\/svg/, ico: /image\//, json: /json/ };
    const broken = [];
    for (const url of assets) {
        const res = await fetch(BASE_URL + url, { headers: { cookie: session.cookie } });
        const ext = url.split('?')[0].split('.').pop();
        await res.arrayBuffer();
        if (res.status !== 200) broken.push(`${url}: HTTP ${res.status}`);
        else if (types[ext] && !types[ext].test(res.headers.get('content-type') || '')) broken.push(`${url}: ${res.headers.get('content-type')}`);
    }
    assert(broken.length === 0, broken.join('\n'));
    console.log(`    ${assets.size} assets`);
});
await run.step('sends the security headers, with a nonce the inline script carries', async () => {
    const res = rendered.get('/dashboard');
    assert(res, 'dashboard not rendered');
    const csp = res.headers.get('content-security-policy') || '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert(nonce && /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), `CSP: ${csp}`);
    const inline = [...res.text.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
    assert(inline.length > 0 && inline.every((attrs) => attrs.includes(`nonce="${nonce}"`)), `inline scripts: ${JSON.stringify(inline)}`);
    for (const [header, want] of [['x-frame-options', 'DENY'], ['x-content-type-options', 'nosniff']]) {
        assert(res.headers.get(header) === want, `${header}: ${res.headers.get(header)}`);
    }
});
await run.step('answers bad addresses with the error pages', async () => {
    const cases = vanilla ? [
        ['/no-such-page', 404, 'Not Found'],
        [`/servers/${UNKNOWN_ID}`, 404, 'Not Found'],
        ['/servers/not-a-uuid', 404, 'Not Found'],
        [`/servers/${vanilla.id}/plugins`, 404, 'Not Found'],
        [`/servers/${vanilla.id}/edit-file?path=../../craftbox.sqlite`, 403, 'Forbidden'],
        [`/servers/${vanilla.id}/files/no-such-dir`, 404, 'Not Found']
    ] : [];
    const wrong = [];
    for (const [path, status, want] of cases) {
        const res = await session.get(path);
        if (res.status !== status || title(res.text) !== `${want} | Craftbox`) wrong.push(`${path}: ${res.status} "${title(res.text)}"`);
    }
    assert(wrong.length === 0, wrong.join('\n'));
});
await run.step('sends signed-out visitors to sign in', async () => {
    for (const [path] of pages().filter(([p]) => !p.startsWith('/status'))) {
        const res = await anon.get(path);
        assert(res.status === 302 && res.location === '/login', `${path}: ${res.status} → ${res.location}`);
    }
    const res = await anon.get('/api/v1/servers');
    assert(res.status === 401 && res.body?.error === 'unauthorized', `API: ${res.status} ${res.text}`);
});

console.log('Signing in');
await run.step('turns away a wrong password', async () => {
    const visitor = createSession();
    await visitor.get('/login');
    const res = await visitor.post('/login', { username: CI_USER.username, password: 'not-the-password' });
    assert(res.status === 302 && res.location === '/login', `${res.status} → ${res.location}`);
    const shown = flash((await visitor.get('/login')).text);
    assert(shown === 'Invalid username or password.', `showed ${JSON.stringify(shown)}`);
    assert((await visitor.get('/dashboard')).location === '/login', 'signed in anyway');
});
let second = null;
await run.step('signs in and returns to the page that asked', async () => {
    second = createSession();
    const asked = await second.get('/servers/create');
    assert(asked.location === '/login', `${asked.status} → ${asked.location}`);
    await second.get('/login');
    const before = sidOf(second.cookie);
    const res = await second.post('/login', CI_USER);
    assert(res.status === 302 && res.location === '/servers/create', `${res.status} → ${res.location}`);
    assert(sidOf(second.cookie) !== before, 'signing in kept the pre-login session id');
    assertStatus(await second.get('/servers/create'), 200, 'create page');
    assert((await second.get('/login')).location === '/dashboard', 'login page shown while signed in');
});
await run.step('keeps the session cookie HttpOnly, SameSite=Strict and an hour from last use', async () => {
    const res = await fetch(`${BASE_URL}/dashboard`, { headers: { cookie: session.cookie }, redirect: 'manual' });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('connect.sid='));
    assert(cookie, 'no cookie refresh on a page load');
    assert(/;\s*HttpOnly/i.test(cookie) && /;\s*SameSite=Strict/i.test(cookie), cookie);
    const expires = Date.parse(/Expires=([^;]+)/i.exec(cookie)?.[1]);
    const lifetime = (expires - Date.parse(res.headers.get('date'))) / 1000;
    assert(lifetime > 3590 && lifetime <= 3600, `cookie expires in ${lifetime}s`);
});

console.log('CSRF');
await run.step('the API takes a session, but its changes need the page\'s token', async () => {
    assertStatus(await session.api('GET', '/servers'), 200, 'GET with a session');
    const path = `/servers/${vanilla?.id}/motd`;
    const missing = await session.api('POST', path, { motd: 'no token' }, { csrf: null });
    assert(missing.status === 403 && missing.body?.error === 'forbidden', `no token: ${missing.status} ${missing.text}`);
    const wrong = await session.api('POST', path, { motd: 'wrong token' }, { csrf: 'f'.repeat(64) });
    assert(wrong.status === 403, `wrong token: ${wrong.status}`);
    const other = await session.api('POST', path, { motd: 'another session\'s token' }, { csrf: second?.csrf || 'e'.repeat(64) });
    assert(other.status === 403, `another session's token: ${other.status}`);
    await session.get('/dashboard');
    assertStatus(await session.api('POST', path, { motd: 'CI web' }), 200, 'with the token');
});
await run.step('a signed-in form posted without the token is a 403 page', async () => {
    const res = await session.post('/account', { currentPassword: CI_USER.password, newUsername: 'renamed' }, { csrf: null });
    assert(res.status === 403 && title(res.text) === 'Forbidden | Craftbox', `${res.status} "${title(res.text)}"`);
    assert(res.text.includes('Invalid or missing CSRF token'), 'no explanation on the page');
});

console.log('Signing out and expiry');
await run.step('signing out needs the token, then ends the session', async () => {
    const refused = await second.post('/logout', {}, { csrf: null });
    assertStatus(refused, 403, 'logout without a token');
    await second.get('/dashboard');
    const res = await second.post('/logout', {});
    assert(res.status === 302 && res.location === '/login', `${res.status} → ${res.location}`);
    assert((await second.get('/dashboard')).location === '/login', 'still signed in after logout');
    assertStatus(await second.api('GET', '/servers'), 401, 'API after logout');
});
if (CONTAINER) {
    await run.step('an expired session is signed out, and its forms go to sign in', async () => {
        const stale = createSession();
        await stale.get('/login');
        const login = await stale.post('/login', CI_USER);
        assert(login.status === 302 && login.location === '/dashboard', `login: ${login.status} → ${login.location}`);
        await stale.get('/account');
        // Push the stored session past its expiry, as an hour's idle would
        const sid = decodeURIComponent(sidOf(stale.cookie)).slice(2).split('.')[0];
        const out = containerExec(['node', '-e', `
            const db = new (require('better-sqlite3'))('data/craftbox.sqlite');
            const row = db.prepare('SELECT json FROM sessions WHERE ID = ?').get('sess_' + process.argv[1]);
            if (!row) { console.log('missing'); process.exit(); }
            const value = JSON.parse(row.json);
            value.expires = Date.now() - 1000;
            db.prepare('UPDATE sessions SET json = ? WHERE ID = ?').run(JSON.stringify(value), 'sess_' + process.argv[1]);
            console.log('aged');`, sid]).trim();
        assert(out === 'aged', `could not age the session: ${out}`);
        assert((await stale.get('/dashboard')).location === '/login', 'expired session still signed in');
        const form = await stale.post('/account', { currentPassword: CI_USER.password, newUsername: 'renamed' });
        assert(form.status === 302 && form.location === '/login', `form from an expired session: ${form.status} → ${form.location}`);
    });
} else {
    run.skip('an expired session is signed out, and its forms go to sign in', 'CRAFTBOX_CONTAINER not set');
}

console.log('Status pages');
await run.step('lists only servers whose status page is public', async () => {
    assertStatus(await api('POST', `/servers/${vanilla.id}/statuspublic`, { enabled: true }), 200, 'statuspublic on');
    assertStatus(await api('POST', `/servers/${fabric.id}/statuspublic`, { enabled: false }), 200, 'statuspublic off');
    const html = (await anon.get('/status')).text;
    assert(html.includes(`href="/status/${vanilla.id}"`), 'public server not listed');
    assert(!html.includes(fabric.id), 'non-public server listed');
});
await run.step('shows any server by its link, with nothing internal in it', async () => {
    // Listing is all the flag controls; the UUID is the capability (docs/API.md)
    const page = await anon.get(`/status/${fabric.id}`);
    assert(page.status === 200 && title(page.text) === 'CI Web Fabric Status | Craftbox', `${page.status} "${title(page.text)}"`);
    const res = await anon.get(`/status/${vanilla.id}/api`);
    assertStatus(res, 200, 'status JSON');
    const keys = Object.keys(res.body.server).sort().join();
    const documented = ['advertisedIp', 'id', 'name', 'playerCount', 'players', 'port', 'serverType', 'state', 'statusPagePublic',
        'uptime', 'uptimeFormatted', 'version'].sort().join();
    assert(keys === documented, `keys: ${keys}`);
    for (const path of [`/status/${UNKNOWN_ID}`, '/status/not-a-uuid', `/status/${UNKNOWN_ID}/api`, `/status/${UNKNOWN_ID}/mods`]) {
        assertStatus(await anon.get(path), 404, path);
    }
});
await run.step('offers players the client-side mods as a zip', async () => {
    assertStatus(await anon.get(`/status/${fabric.id}/mods`), 404, 'no mods yet');
    const form = new FormData();
    form.append('file', new Blob([makeModJar('fabric', 'ci_client')]), 'ci-client.jar');
    form.append('file', new Blob([makeModJar('fabric', 'ci_server')]), 'ci-server.jar');
    const upload = await api('POST', `/servers/${fabric.id}/plugins/upload`, form);
    assert(upload.status === 200 && upload.body.count === 2, `upload: ${upload.status} ${upload.text}`);
    assertStatus(await api('POST', `/servers/${fabric.id}/plugins/environment`, { filename: 'ci-server.jar', environment: 'server' }), 200, 'server-only');

    const res = await fetch(`${BASE_URL}/status/${fabric.id}/mods`);
    const zip = Buffer.from(await res.arrayBuffer());
    assert(res.status === 200, `mods zip: HTTP ${res.status}`);
    assert(Number(res.headers.get('content-length')) === zip.length, `Content-Length ${res.headers.get('content-length')}, body ${zip.length}`);
    assert(zipEntries(zip).join() === 'mods/ci-client.jar', `zip holds ${zipEntries(zip).join(', ')}`);
    const page = (await anon.get(`/status/${fabric.id}`)).text;
    assert(page.includes(`/status/${fabric.id}/mods`), 'status page has no mods download');
});

console.log('Rate limiting');
await run.step('doesn\'t count successful sign-ins toward the limit', async () => {
    // Each attempt is counted as it arrives and a success is taken back off
    // after, so every one of these sees the same number left
    const left = [];
    for (let attempt = 0; attempt < 6; attempt++) {
        const visitor = createSession();
        await visitor.get('/login');
        const res = await visitor.post('/login', CI_USER);
        assert(res.status === 302 && res.location === '/dashboard', `sign-in ${attempt + 1}: ${res.status} → ${res.location}`);
        left.push(res.headers.get('ratelimit-remaining'));
    }
    assert(new Set(left).size === 1, `attempts left after each: ${left.join(', ')}`);
});
// Last: from here on this address can't sign in for 15 minutes
await run.step('refuses a sign-in after five failed ones inside 15 minutes, even with the right password', async () => {
    const visitor = createSession();
    await visitor.get('/login');
    let remaining = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        const res = await visitor.post('/login', { username: CI_USER.username, password: 'not-the-password' });
        if (res.status === 429) break;
        assert(res.headers.get('ratelimit-limit') === '5', `RateLimit-Limit ${res.headers.get('ratelimit-limit')}`);
        remaining = Number(res.headers.get('ratelimit-remaining'));
    }
    assert(remaining === 0, `the limit ran out with ${remaining} attempts left`);
    const res = await visitor.post('/login', CI_USER);
    assert(res.status === 429 && title(res.text) === 'Too Many Requests | Craftbox', `right password: ${res.status} "${title(res.text)}"`);
    assert(res.text.includes('Too many login attempts'), 'no explanation on the page');
    assertStatus(await session.get('/dashboard'), 200, 'a session already signed in is unaffected');
});

run.finish();
