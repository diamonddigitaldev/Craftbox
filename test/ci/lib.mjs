// Shared helpers for the CI checks. They drive a running Craftbox purely over
// HTTP, the way a third-party integration would, so they need nothing but Node
// (22+, for fetch/FormData) and the panel's URL.

import fs from 'node:fs';

export const BASE_URL = (process.env.CRAFTBOX_URL || 'http://localhost:6464').replace(/\/$/, '');
const API = `${BASE_URL}/api/v1`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
export async function bootstrapApiKey({ username = 'ci-admin', password = 'ci-password-123' } = {}) {
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
    return body.key;
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

// ── Tiny test runner ──

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
                results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
                console.log(`  ✘ ${name}\n      ${err.message}`);
                // GitHub annotation, so the failure shows on the run summary
                if (process.env.GITHUB_ACTIONS) console.log(`::error title=${title}: ${name}::${err.message.replace(/\r?\n/g, ' ')}`);
            }
        },
        get failed() {
            return results.filter((r) => !r.ok).length;
        },
        finish() {
            const failed = this.failed;
            console.log(`\n${title}: ${results.length - failed}/${results.length} passed`);
            if (process.env.GITHUB_STEP_SUMMARY) {
                const rows = results.map((r) =>
                    `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${(r.ms / 1000).toFixed(1)}s | ${r.ok ? '' : (r.error || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
                fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
                    `### ${title}\n\n| | Check | Time | Error |\n|---|---|---|---|\n${rows.join('\n')}\n\n`);
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
