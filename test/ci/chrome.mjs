// A small headless Chrome driver over the DevTools protocol, using Node's
// own WebSocket: no Puppeteer, no Playwright. It launches the Chrome already
// on the machine (the GitHub runners have one), opens pages, and records
// everything a page does wrong: uncaught exceptions, console errors, CSP
// violations, failed requests and error responses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { BASE_URL, sleep } from './lib.mjs';

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        process.env.CHROME_BIN,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean);
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        try {
            return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch { /* not on PATH */ }
    }
    throw new Error('No Chrome found: set CHROME_PATH.');
}

export async function launchChrome() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'craftbox-chrome-'));
    const args = [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
        '--window-size=1400,1000', 'about:blank'
    ];
    // Ubuntu 24.04's AppArmor rules leave CI runners without a usable sandbox
    if (process.platform === 'linux' && process.env.GITHUB_ACTIONS) args.unshift('--no-sandbox');
    const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const endpoint = await new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`Chrome didn't start:\n${stderr}`)), 30_000);
        proc.stderr.on('data', (chunk) => {
            stderr += chunk;
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${stderr}`)));
    });

    const cdp = await connect(endpoint);
    return {
        newPage: () => openPage(cdp),
        async close() {
            cdp.close();
            proc.kill();
            await sleep(500);
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still letting go */ }
        }
    };
}

async function connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('could not connect to Chrome')), { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id) {
            const call = pending.get(msg.id);
            if (!call) return;
            pending.delete(msg.id);
            if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
            else call.resolve(msg.result);
            return;
        }
        for (const l of listeners) if (l.method === msg.method && l.sessionId === msg.sessionId) l.fn(msg.params);
    });
    return {
        send(method, params = {}, sessionId) {
            const id = ++nextId;
            ws.send(JSON.stringify({ id, method, params, sessionId }));
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
        },
        on(method, sessionId, fn) {
            listeners.push({ method, sessionId, fn });
        },
        close: () => ws.close()
    };
}

async function openPage(cdp) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    const on = (method, fn) => cdp.on(method, sessionId, fn);

    let problems = [];
    let loads = 0;
    const inflight = new Map();
    let lastActivity = Date.now();
    const origin = new URL(BASE_URL).origin;

    on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
        problems.push(`uncaught ${(d.exception?.description || d.text).split('\n')[0]}`);
    });
    on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (type === 'error' || type === 'assert') {
            problems.push(`console.${type}: ${args.map((a) => a.value ?? a.description).join(' ')}`);
        }
    });
    on('Log.entryAdded', ({ entry }) => {
        // Error responses are reported below with their URL instead
        if (entry.level === 'error' && entry.source !== 'network') problems.push(`${entry.source}: ${entry.text}`);
    });
    on('Network.requestWillBeSent', ({ requestId, request }) => {
        inflight.set(requestId, request.url);
        lastActivity = Date.now();
    });
    on('Network.responseReceived', ({ response, type }) => {
        if (response.status >= 400 && response.url.startsWith(origin)) {
            problems.push(`HTTP ${response.status} for ${type} ${response.url.slice(origin.length)}`);
        }
    });
    on('Network.loadingFinished', ({ requestId }) => {
        inflight.delete(requestId);
        lastActivity = Date.now();
    });
    on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
        const url = inflight.get(requestId);
        inflight.delete(requestId);
        lastActivity = Date.now();
        // Leaving a page cancels what it still had in flight
        if (!canceled && errorText !== 'net::ERR_ABORTED') problems.push(`request failed: ${errorText} ${url}`);
    });
    on('Page.loadEventFired', () => { loads++; });
    // Leaving a page with unsaved edits asks first; anything else is a problem
    on('Page.javascriptDialogOpening', ({ type, message }) => {
        if (type !== 'beforeunload') problems.push(`${type} dialog: ${message}`);
        send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });

    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map((m) => send(m)));
    // CSP violations as the page itself sees them, alongside Chrome's report
    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `document.addEventListener('securitypolicyviolation', (e) =>
            console.error('CSP violation: ' + e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline code')));`
    });

    const page = {
        // Everything recorded since the last call
        takeProblems() {
            const taken = problems;
            problems = [];
            return taken;
        },
        async eval(expression) {
            const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (exceptionDetails) throw new Error(`in the page: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
            return result.value;
        },
        async waitFor(expression, { timeoutMs = 30_000, what = expression } = {}) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const value = await page.eval(expression).catch(() => null);
                if (value) return value;
                if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
                await sleep(250);
            }
        },
        // Wait until nothing has been in flight for a moment
        async settle({ quietMs = 750, timeoutMs = 15_000 } = {}) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (inflight.size === 0 && Date.now() - lastActivity >= quietMs) return;
                await sleep(100);
            }
        },
        // Resolve once the page has loaded a new document, after `action`
        async navigation(action, { timeoutMs = 30_000 } = {}) {
            const before = loads;
            await action();
            const deadline = Date.now() + timeoutMs;
            while (loads === before) {
                if (Date.now() > deadline) throw new Error('no page load');
                await sleep(100);
            }
            await page.settle();
            return page.eval('location.pathname + location.search');
        },
        async goto(pathname) {
            return page.navigation(async () => {
                const { errorText } = await send('Page.navigate', { url: BASE_URL + pathname });
                if (errorText) throw new Error(`navigating to ${pathname}: ${errorText}`);
            });
        },
        click: (selector) => page.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('no ${selector.replace(/'/g, "\\'")}');
            el.click();
            return true;
        })()`),
        // Replace a field's value as typing would, firing the input events. A
        // field a user couldn't type into (hidden, collapsed) is an error.
        async type(selector, text) {
            await page.eval(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) throw new Error('no ${selector.replace(/'/g, "\\'")}');
                el.focus();
                if (document.activeElement !== el) throw new Error('${selector.replace(/'/g, "\\'")} can\\'t take focus (hidden?)');
                el.value = '';
                return true;
            })()`);
            await send('Input.insertText', { text });
        },
        async press(key) {
            const codes = { Enter: 13 };
            const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
            await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key === 'Enter' ? '\r' : undefined });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        },
        close: () => cdp.send('Target.closeTarget', { targetId })
    };
    return page;
}
