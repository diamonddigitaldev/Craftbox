// Shared helpers for the CI checks. They drive a running Craftbox purely over
// HTTP, the way a third-party integration would, so they need nothing but Node
// (22+, for fetch/FormData) and the panel's URL.

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

export const BASE_URL = (process.env.CRAFTBOX_URL || 'http://localhost:6464').replace(/\/$/, '');
const API = `${BASE_URL}/api/v1`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Upstream services ──
//
// Creating a server makes Craftbox download from Mojang, PaperMC, the Forge
// and NeoForge Mavens, Fabric or Purpur, and some checks call Modrinth. Any of
// them can be down or slow for a while, which is no fault of Craftbox's, so
// such failures are retried and, if they persist, reported as an upstream
// outage (UpstreamError) rather than as a failed check.

export const UPSTREAMS = {
    mojang: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
    paper: 'https://fill.papermc.io/v3/projects/paper',
    folia: 'https://fill.papermc.io/v3/projects/folia',
    purpur: 'https://api.purpurmc.org/v2/purpur',
    fabric: 'https://meta.fabricmc.net/v2/versions/game',
    forge: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
    forgeMaven: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    neoforge: 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
    modrinth: 'https://api.modrinth.com/v2/'
};

// What each server type pulls from when it's created. Every type but custom
// also asks Mojang which Java its version needs.
export const TYPE_UPSTREAMS = {
    vanilla: ['mojang'],
    paper: ['paper', 'mojang'],
    folia: ['folia', 'mojang'],
    purpur: ['purpur', 'mojang'],
    fabric: ['fabric', 'mojang'],
    forge: ['forge', 'forgeMaven', 'mojang'],
    neoforge: ['neoforge', 'mojang'],
    custom: ['mojang'] // the tests point custom servers at Mojang's own jars
};

export class UpstreamError extends Error {
    constructor(service, detail) {
        super(`${service} unavailable: ${detail}`);
        this.name = 'UpstreamError';
        this.service = service;
    }
}

// Messages that point at the network or an upstream rather than Craftbox:
// Craftbox's own download errors (`HTTP 503`, `fetch failed`, `timed out`),
// Node's socket errors, and the Java exceptions a Forge/NeoForge installer
// prints when it can't fetch a library.
const TRANSIENT_RE = /\bHTTP (?:5\d\d|429)\b|response code: (?:5\d\d|429)|fetch failed|timed out|\btimeout\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up|UND_ERR|SocketTimeoutException|ConnectException|UnknownHostException|SSLHandshakeException|Connection reset/i;

export function looksTransient(err) {
    return err?.transient === true || TRANSIENT_RE.test(String(err?.message || err || ''));
}

// An error the check itself raises for something that may be an outage, such
// as Craftbox answering 500 when it couldn't list an upstream's versions.
export function transientError(message) {
    return Object.assign(new Error(message), { transient: true });
}

// fetch() for a service outside Craftbox. Network errors, timeouts, 429 and
// 5xx are retried with backoff and then thrown as an UpstreamError; any other
// response is returned for the caller to judge.
export async function upstreamFetch(url, init = {}, { attempts = 4, timeoutMs = 30_000 } = {}) {
    const host = new URL(url).host;
    let detail = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1) await sleep(2000 * 2 ** (attempt - 2)); // 2s, 4s, 8s
        try {
            const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
            if (res.status !== 429 && res.status < 500) return res;
            detail = `HTTP ${res.status}`;
            await res.body?.cancel();
        } catch (err) {
            detail = err.cause?.code || err.message;
        }
    }
    throw new UpstreamError(host, `${detail} (${attempts} attempts)`);
}

// The first of the named upstreams the runner can't reach, as an
// UpstreamError, or null when they all answer.
export async function probeUpstreams(names) {
    for (const name of names) {
        try {
            await (await upstreamFetch(UPSTREAMS[name], {}, { attempts: 3 })).body?.cancel();
        } catch (err) {
            if (err instanceof UpstreamError) return err;
            throw err;
        }
    }
    return null;
}

// Run `fn`, which has Craftbox call out to the `names` upstreams. A failure
// that looks like the network's is retried after a pause. If it persists and
// the runner can't reach one of those upstreams either, it's rethrown as an
// UpstreamError; if they all answer, the failure is Craftbox's to explain.
export async function withUpstream(names, fn, { attempts = 2, pauseMs = 20_000 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            if (err instanceof UpstreamError || !looksTransient(err)) throw err;
            lastErr = err;
            if (attempt < attempts) {
                console.log(`    retrying in ${pauseMs / 1000}s: ${err.message.split('\n')[0]}`);
                await sleep(pauseMs);
            }
        }
    }
    const down = await probeUpstreams(names);
    if (down) {
        down.message += `\n${lastErr.message}`;
        throw down;
    }
    lastErr.message += `\n(${names.join(', ')} answered the runner, so this is not an outage there)`;
    throw lastErr;
}

// ── Panel bootstrap ──

// Wait until the panel answers at all (a container takes a few seconds to boot).
export async function waitForPanel(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const res = await fetch(`${BASE_URL}/login`, { redirect: 'manual' });
            if (res.status < 500) return;
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error(`Craftbox did not come up at ${BASE_URL}`);
        await sleep(1000);
    }
}

// Minimal cookie jar: key management only accepts a logged-in session.
function cookieJar() {
    const cookies = new Map();
    return {
        store(res) {
            for (const line of res.headers.getSetCookie?.() || []) {
                const [pair] = line.split(';');
                const eq = pair.indexOf('=');
                cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
        },
        header() {
            return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        },
        load(header) {
            for (const pair of header.split(/;\s*/).filter(Boolean)) {
                const eq = pair.indexOf('=');
                cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
            }
        }
    };
}

// The token pages embed for forms (`_csrf`) or for scripts (#csrf-token)
function csrfFrom(html) {
    return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] || /id="csrf-token" value="([^"]+)"/.exec(html)?.[1] || null;
}

// A browser-like session: it keeps its cookies, doesn't follow redirects,
// and remembers the CSRF token of the last page it rendered, which it sends
// with its next form post (`_csrf`) or API call (X-CSRF-Token), unless given
// `csrf: null` for none or a `csrf` of its own. Responses resolve to
// {status, headers, location, text, body} with `body` parsed when JSON.
// `cookie` picks up a session saved from another one.
export function createSession(cookie = '') {
    const jar = cookieJar();
    jar.load(cookie);
    let token = null;
    const session = {
        get csrf() { return token; },
        get cookie() { return jar.header(); },
        async request(method, path, { form, json, headers = {}, csrf = token } = {}) {
            const init = { method, redirect: 'manual', headers: { cookie: jar.header(), ...headers } };
            if (form) {
                init.headers['content-type'] = 'application/x-www-form-urlencoded';
                init.body = new URLSearchParams(csrf ? { _csrf: csrf, ...form } : form);
            } else {
                if (method !== 'GET' && csrf) init.headers['x-csrf-token'] = csrf;
                if (json instanceof FormData) {
                    init.body = json;
                } else if (json !== undefined) {
                    init.headers['content-type'] = 'application/json';
                    init.body = JSON.stringify(json);
                }
            }
            const res = await fetch(BASE_URL + path, init);
            jar.store(res);
            const text = await res.text();
            token = csrfFrom(text) || token;
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch { /* a page */ }
            return { status: res.status, headers: res.headers, location: res.headers.get('location') || '', text, body };
        },
        get: (path, opts) => session.request('GET', path, opts),
        post: (path, form, opts) => session.request('POST', path, { form, ...opts }),
        api: (method, path, json, opts) => session.request(method, `/api/v1${path}`, { json, ...opts })
    };
    return session;
}

export const CI_USER = { username: 'ci-admin', password: 'ci-password-123' };

// Run the first-run setup wizard on a fresh instance and mint an API key.
// Keys can only be created from a session, so this goes through the same
// forms a browser would. Resolves to the raw `cbx_` key, the logged-in
// `session`, and `page(path)`, a GET on it resolving to {status, html}, for
// checking what the panel's pages render.
export async function bootstrapPanel({ username, password } = CI_USER) {
    const session = createSession();
    const setupPage = await session.get('/setup');
    if (setupPage.status !== 200) {
        throw new Error(`Expected a fresh instance, but /setup returned ${setupPage.status} (setup already done?).`);
    }
    const setupRes = await session.post('/setup', { username, password, confirmPassword: password });
    if (setupRes.status !== 302 || !/dashboard/.test(setupRes.location)) {
        throw new Error(`Setup failed: ${setupRes.status} → ${setupRes.location}`);
    }
    return { key: await mintApiKey(session), session, page: (path) => pageOf(session, path) };
}

// Log in to a panel that's already set up (each attempt counts towards the
// login rate limit of 5 per 15 minutes) and mint an API key.
export async function loginPanel({ username, password } = CI_USER) {
    const session = createSession();
    await session.get('/login');
    const res = await session.post('/login', { username, password });
    if (res.status !== 302 || /login/.test(res.location)) {
        throw new Error(`Login failed: ${res.status} → ${res.location}`);
    }
    return { key: await mintApiKey(session), session, page: (path) => pageOf(session, path) };
}

// Set up a fresh panel, or sign in to one another script already set up.
// With CRAFTBOX_SESSION_FILE, scripts run one after another share a single
// signed-in session and API key through that file instead of each signing
// in, since the login rate limit allows only 5 sign-ins in 15 minutes.
export async function openPanel(credentials = CI_USER) {
    const file = process.env.CRAFTBOX_SESSION_FILE;
    if (file && fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const session = createSession(saved.cookie);
        if ((await session.get('/account')).status === 200) {
            return { key: saved.key, session, page: (path) => pageOf(session, path) };
        }
    }
    const res = await fetch(`${BASE_URL}/setup`, { redirect: 'manual' });
    await res.arrayBuffer();
    const opened = res.status === 200 ? await bootstrapPanel(credentials) : await loginPanel(credentials);
    if (file) fs.writeFileSync(file, JSON.stringify({ cookie: opened.session.cookie, key: opened.key }));
    return opened;
}

async function pageOf(session, path) {
    const res = await session.get(path);
    return { status: res.status, html: res.text };
}

async function mintApiKey(session) {
    // Logging in regenerates the session, so fetch a token for the new one
    await session.get('/account');
    const res = await session.api('POST', '/account/apikeys', { name: 'CI' });
    if (res.status !== 201 || !res.body?.key) {
        throw new Error(`Could not create an API key: ${res.status} ${res.text}`);
    }
    return res.body.key;
}

// Every page of the panel, as [path, title before " | Craftbox"], for a
// provisioned vanilla server (in group "CI Group", with a ci-dir folder) and a
// Fabric one, whose Mods page stands in for the plugins page
export function panelPages(vanilla, fabric) {
    const v = `/servers/${vanilla.id}`;
    return [
        ['/dashboard', 'Dashboard'],
        ['/dashboard/groups/CI%20Group', 'CI Group'],
        ['/servers/create', 'Create Server'],
        [v, `${vanilla.name} Console`],
        [`${v}/edit`, `${vanilla.name} Settings`],
        [`${v}/properties`, `${vanilla.name} Properties`],
        [`${v}/files`, `${vanilla.name} Files`],
        [`${v}/files/ci-dir`, `${vanilla.name} Files`],
        [`${v}/edit-file?path=server.properties`, `${vanilla.name} | Edit server.properties`],
        [`${v}/backups`, `${vanilla.name} Backups`],
        [`${v}/events`, `${vanilla.name} Events`],
        [`/servers/${fabric.id}/plugins`, `${fabric.name} Mods`],
        ['/modpacks', 'Modpacks'],
        ['/templates', 'Templates'],
        ['/account', 'Account Settings'],
        ['/status', 'Server Status'],
        [`/status/${vanilla.id}`, `${vanilla.name} Status`]
    ];
}

// ── WebSocket ──

// A panel socket that keeps every message it receives, so a check can wait
// for the one it expects (already arrived or still to come) rather than
// racing the server. `cookie` is a logged-in session's; `path` '/ws/status'
// opens the public socket.
export async function openSocket({ cookie, path = '/' } = {}) {
    const ws = new WebSocket(BASE_URL.replace(/^http/, 'ws') + path, cookie ? { headers: { cookie } } : undefined);
    const messages = [];
    const waiters = new Set();
    ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        messages.push(msg);
        for (const waiter of waiters) {
            if (waiter.match(msg)) {
                waiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(msg);
            }
        }
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error(`WebSocket ${path} did not open`)), { once: true });
    });
    return {
        messages,
        send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
        // Where the message list is now, to wait only for what comes after
        mark: () => messages.length,
        waitFor(match, { timeoutMs = 30_000, what = 'matching message', since = 0 } = {}) {
            const found = messages.slice(since).find(match);
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                const waiter = { match, resolve };
                waiter.timer = setTimeout(() => {
                    if (waiters.delete(waiter)) reject(new Error(`no ${what} within ${timeoutMs / 1000}s`));
                }, timeoutMs);
                waiters.add(waiter);
            });
        },
        close: () => ws.close()
    };
}

// The HTTP status a WebSocket upgrade request gets, for checking refusals
export function upgradeStatus(path = '/', headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE_URL + path, {
            headers: {
                connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
                'sec-websocket-key': crypto.randomBytes(16).toString('base64'), ...headers
            }
        });
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
    });
}

// ── API client ──

export function apiClient(key) {
    return async function api(method, path, body, { headers = {} } = {}) {
        const init = { method, headers: { ...headers } };
        if (key) init.headers.authorization = `Bearer ${key}`;
        if (body instanceof FormData || body instanceof Uint8Array) {
            init.body = body;
        } else if (body !== undefined) {
            init.headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        const res = await fetch(API + path, init);
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        return { status: res.status, body: json, text };
    };
}

// Upload `data` as `filename` through an endpoint's chunked (DGUP) route at
// `base` (e.g. /servers/:id/files/upload), as the panel's dgup.js does, with
// `fields` in the complete request. Chunks go last to first, since the
// protocol lets them arrive in any order. Resolves to the complete response,
// plus `uploadId` and `chunks`.
export async function dgupUpload(api, base, filename, data, fields = {}) {
    const init = await api('POST', `${base}/init`, { filename, totalSize: data.length });
    assertStatus(init, 200, `${base}/init`);
    const { uploadId, chunkSize, totalChunks } = init.body;
    for (let index = totalChunks - 1; index >= 0; index--) {
        const chunk = data.subarray(index * chunkSize, (index + 1) * chunkSize);
        const res = await api('POST', `${base}/chunk`, chunk, { headers: chunkHeaders(uploadId, index, chunk) });
        assertStatus(res, 200, `${base}/chunk ${index}`);
    }
    const complete = await api('POST', `${base}/complete`, { uploadId, ...fields });
    return Object.assign(complete, { uploadId, chunks: totalChunks });
}

export function chunkHeaders(uploadId, index, chunk, hash = crypto.createHash('sha256').update(chunk).digest('hex')) {
    return {
        'content-type': 'application/octet-stream',
        'x-upload-id': uploadId,
        'x-chunk-index': String(index),
        'x-chunk-hash': hash
    };
}

// Poll GET /servers/:id until its state is one of `states`. A server that
// disappears (a failed provision is auto-removed) or lands in `crashed` when
// that wasn't asked for fails immediately rather than waiting out the clock.
export async function waitForState(api, id, states, { timeoutMs, label = id } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
        const res = await api('GET', `/servers/${id}`);
        if (res.status === 404) throw new Error(`${label}: server was removed (failed provisioning?)`);
        const server = res.body?.server;
        if (server) {
            last = server;
            if (states.includes(server.state)) return server;
            if (server.state === 'crashed' && !states.includes('crashed')) {
                throw new Error(`${label}: crashed — ${server.crashReason || 'no reason recorded'}`);
            }
        }
        if (Date.now() > deadline) {
            throw new Error(`${label}: still "${last?.state}" after ${Math.round(timeoutMs / 1000)}s, wanted ${states.join('/')}`);
        }
        await sleep(2000);
    }
}

// Create a server (POST `path` with `body`, JSON or FormData) and wait for it
// to finish provisioning, retrying through a short upstream outage. A failed
// attempt's server is deleted before the next. `onCreated` sees the 201
// response of each attempt. Resolves to the provisioned server.
export async function provisionServer(api, body, {
    path = '/servers', timeoutMs, label, upstreams = TYPE_UPSTREAMS[body.serverType] || ['mojang'], onCreated
} = {}) {
    return withUpstream(upstreams, async () => {
        const res = await api('POST', path, typeof body === 'function' ? body() : body);
        assertStatus(res, 201, `create ${label || ''}`.trim());
        await onCreated?.(res);
        const id = res.body.server.id;
        try {
            return await waitForState(api, id, ['stopped'], { timeoutMs, label: label || id });
        } catch (err) {
            await api('DELETE', `/servers/${id}`).catch(() => {});
            throw err;
        }
    });
}

// ── The container ──

// Checks that reach inside the panel's container (killing a JVM, restarting
// the panel, ageing a session) need its name in CRAFTBOX_CONTAINER, and are
// skipped without it.
export const CONTAINER = process.env.CRAFTBOX_CONTAINER || null;

export function docker(args) {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Run a command in the container as the panel's own user, from /app, so a
// `node -e` there can require the panel's modules
export function containerExec(args) {
    return docker(['exec', '-u', 'craftbox', '-w', '/app', CONTAINER, ...args]);
}

// ── Test fixtures ──

// A jar that passes for a plugin or mod of `serverType`'s loader: the
// loader's metadata file and nothing else. Enough for uploads, listings and
// downloads, not for a server to load.
export function makeModJar(serverType, id = 'ci_mod') {
    const metadata = {
        fabric: ['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', name: 'CI Mod', environment: '*' })],
        forge: ['META-INF/mods.toml', `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="${id}"\nversion="1.0.0"\n`],
        neoforge: ['META-INF/neoforge.mods.toml', `modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="${id}"\nversion="1.0.0"\n`],
        paper: ['plugin.yml', `name: ${id}\nversion: 1.0.0\nmain: ci.${id}.Plugin\napi-version: '1.20'\n`]
    };
    const [name, content] = metadata[serverType] || metadata[{ purpur: 'paper', folia: 'paper' }[serverType]];
    return makeZip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n', [name]: content });
}

// The names in a zip's central directory, for checking what an archive holds
export function zipEntries(buf) {
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw new Error('not a zip: no end of central directory');
    const count = buf.readUInt16LE(end + 10);
    let offset = buf.readUInt32LE(end + 16);
    const names = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return names;
}

// A solid-colour RGB PNG of the given size
export function makePng(width, height) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(zlib.crc32(body), body.length + 4);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.writeUInt8(8, 8);   // bit depth
    header.writeUInt8(2, 9);   // truecolour
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x4c)]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// A PNG's dimensions, read off its header
export function pngSize(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// A zip of `entries` ({name: string | Buffer}), stored uncompressed: enough for
// a test .mrpack without a zip dependency (zlib.crc32 needs Node 22.2+).
export function makeZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(entries)) {
        const data = Buffer.from(content);
        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);          // local file header
        local.writeUInt16LE(20, 4);                  // version needed
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);        // compressed = stored size
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        parts.push(local, nameBuf, data);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);          // central directory entry
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(nameBuf.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);                // end of central directory
    end.writeUInt16LE(central.length / 2, 8);
    end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
}

// ── Tiny test runner ──

// Workflow-command escaping: the message may span lines, and a property
// (the title) may hold none of `:` or `,` unescaped.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// Checks that couldn't run because an upstream was down fail the run as
// well, but are labelled as such everywhere: the log, the annotation and a
// section of their own in the step summary.
export function createRunner(title) {
    const results = [];

    return {
        // `knownIssue` marks a check for a bug that's been reported but not
        // fixed: while it fails it's a warning, and once it passes it fails,
        // so the marker comes off.
        async step(name, fn, { knownIssue } = {}) {
            const started = Date.now();
            let err = null;
            try {
                await fn();
            } catch (caught) {
                err = caught;
            }
            const ms = Date.now() - started;
            const upstream = err instanceof UpstreamError;
            const indent = (s) => s.replace(/\n/g, '\n      ');

            if (knownIssue && err && !upstream) {
                results.push({ name, ok: true, known: `${knownIssue}: ${err.message}`, ms });
                console.log(`  ! ${name} (known issue: ${knownIssue})\n      ${indent(err.message)}`);
                if (process.env.GITHUB_ACTIONS) {
                    console.log(`::warning title=${escapeProperty(`Known issue: ${name}`)}::${escapeData(`${knownIssue}\n${err.message}`)}`);
                }
                return;
            }
            if (knownIssue && !err) {
                err = new Error(`Passes now, so this looks fixed (${knownIssue}): remove its knownIssue marker.`);
            }
            if (!err) {
                results.push({ name, ok: true, ms });
                console.log(`  ✔ ${name}`);
                return;
            }
            results.push({ name, ok: false, upstream, ms, error: err.message });
            console.log(`  ${upstream ? '⚠ [upstream unavailable]' : '✘'} ${name}\n      ${indent(err.message)}`);
            if (process.env.GITHUB_ACTIONS) {
                const heading = upstream ? `Upstream unavailable (${err.service}), not a Craftbox failure` : title;
                console.log(`::error title=${escapeProperty(`${heading}: ${name}`)}::${escapeData(err.message)}`);
            }
        },
        // A check that can't run in this environment, such as one that needs
        // the container when the panel isn't running in Docker
        skip(name, why) {
            results.push({ name, ok: true, skipped: why, ms: 0 });
            console.log(`  - ${name} (skipped: ${why})`);
        },
        get failed() {
            return results.filter((r) => !r.ok).length;
        },
        finish() {
            const failed = this.failed;
            const outages = results.filter((r) => r.upstream).length;
            console.log(`\n${title}: ${results.length - failed}/${results.length} passed` +
                (outages ? ` (${outages} blocked by an upstream outage, not Craftbox)` : ''));
            if (process.env.GITHUB_STEP_SUMMARY) {
                const cell = (s) => (s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
                const row = (r) => `| ${r.skipped ? '⏭️' : r.known ? '🐞' : r.ok ? '✅' : r.upstream ? '⚠️' : '❌'} | ${cell(r.name)} | ` +
                    `${(r.ms / 1000).toFixed(1)}s | ${r.skipped ? `skipped: ${cell(r.skipped)}` : r.known ? `known issue: ${cell(r.known)}` : r.ok ? '' : cell(r.error)} |`;
                const table = (rows) => `| | Check | Time | Error |\n|---|---|---|---|\n${rows.map(row).join('\n')}\n\n`;
                let md = `### ${title}\n\n${table(results.filter((r) => !r.upstream))}`;
                if (outages) {
                    md += `#### ⚠️ Upstream unavailable\n\nThese checks couldn't run because a service outside Craftbox ` +
                        `was down, even after retries. They are not Craftbox failures; re-run the job once it's back.\n\n` +
                        table(results.filter((r) => r.upstream));
                }
                fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
            }
            process.exitCode = failed > 0 ? 1 : 0;
        }
    };
}

export function assert(condition, message) {
    if (!condition) throw new Error(message);
}

export function assertStatus(res, expected, what) {
    const list = Array.isArray(expected) ? expected : [expected];
    if (!list.includes(res.status)) {
        throw new Error(`${what}: expected HTTP ${list.join('/')}, got ${res.status} ${res.text?.slice(0, 300) || ''}`);
    }
}
