// Shared helpers for the CI checks. They drive a running Craftbox purely over
// HTTP, the way a third-party integration would, so they need nothing but Node
// (22+, for fetch/FormData) and the panel's URL.

import fs from 'node:fs';
import zlib from 'node:zlib';

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
        }
    };
}

function csrfFrom(html) {
    const match = /name="_csrf" value="([^"]+)"/.exec(html);
    if (!match) throw new Error('No CSRF token on the page.');
    return match[1];
}

// Run the first-run setup wizard on a fresh instance and mint an API key.
// Returns the raw `cbx_` key. Keys can only be created from a session, so this
// goes through the same forms a browser would.
export async function bootstrapApiKey(credentials) {
    return (await bootstrapPanel(credentials)).key;
}

// As bootstrapApiKey, plus `page(path)`: a GET on the logged-in session
// resolving to {status, html}, for checking what the panel's pages render.
export async function bootstrapPanel({ username = 'ci-admin', password = 'ci-password-123' } = {}) {
    const jar = cookieJar();
    const page = async (path) => {
        const res = await fetch(BASE_URL + path, { headers: { cookie: jar.header() }, redirect: 'manual' });
        jar.store(res);
        return res;
    };

    const setupPage = await page('/setup');
    if (setupPage.status !== 200) {
        throw new Error(`Expected a fresh instance, but /setup returned ${setupPage.status} (setup already done?).`);
    }
    const setupRes = await fetch(`${BASE_URL}/setup`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            _csrf: csrfFrom(await setupPage.text()),
            username,
            password,
            confirmPassword: password
        })
    });
    jar.store(setupRes);
    if (setupRes.status !== 302 || !/dashboard/.test(setupRes.headers.get('location') || '')) {
        throw new Error(`Setup failed: ${setupRes.status} → ${setupRes.headers.get('location')}`);
    }

    // Logging in regenerates the session, so fetch a token for the new one
    const account = await page('/account');
    const keyRes = await fetch(`${API}/account/apikeys`, {
        method: 'POST',
        headers: {
            cookie: jar.header(),
            'content-type': 'application/json',
            'x-csrf-token': csrfFrom(await account.text())
        },
        body: JSON.stringify({ name: 'CI' })
    });
    const body = await keyRes.json();
    if (keyRes.status !== 201 || !body.key) {
        throw new Error(`Could not create an API key: ${keyRes.status} ${JSON.stringify(body)}`);
    }
    return {
        key: body.key,
        page: async (path) => {
            const res = await page(path);
            return { status: res.status, html: await res.text() };
        }
    };
}

// ── API client ──

export function apiClient(key) {
    return async function api(method, path, body, { headers = {} } = {}) {
        const init = { method, headers: { ...headers } };
        if (key) init.headers.authorization = `Bearer ${key}`;
        if (body instanceof FormData) {
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

// ── Test fixtures ──

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
        async step(name, fn) {
            const started = Date.now();
            try {
                await fn();
                results.push({ name, ok: true, ms: Date.now() - started });
                console.log(`  ✔ ${name}`);
            } catch (err) {
                const upstream = err instanceof UpstreamError;
                results.push({ name, ok: false, upstream, ms: Date.now() - started, error: err.message });
                console.log(`  ${upstream ? '⚠ [upstream unavailable]' : '✘'} ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`);
                if (process.env.GITHUB_ACTIONS) {
                    const heading = upstream ? `Upstream unavailable (${err.service}), not a Craftbox failure` : title;
                    console.log(`::error title=${escapeProperty(`${heading}: ${name}`)}::${escapeData(err.message)}`);
                }
            }
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
                const row = (r) => `| ${r.ok ? '✅' : r.upstream ? '⚠️' : '❌'} | ${cell(r.name)} | ${(r.ms / 1000).toFixed(1)}s | ${r.ok ? '' : cell(r.error)} |`;
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
