// Browser test: the panel in headless Chrome, so the pages' own scripts run.
// Every page must load without an uncaught exception, a console error, a CSP
// violation, a failed request or an error toast; then the main flows are
// driven through the real UI: signing in, creating a server from the create
// page, starting it and sending a console command, and saving a file,
// Properties (plainly and with a restore-point backup) and Settings.
//
//   CRAFTBOX_URL=http://localhost:6464 node test/ci/browser.mjs
//
// Chrome is found on PATH or at its usual install path; CHROME_PATH overrides.

import {
    waitForPanel, openPanel, apiClient, provisionServer, waitForState, withUpstream, panelPages,
    CI_USER, createRunner, assert, assertStatus
} from './lib.mjs';
import { launchChrome } from './chrome.mjs';

const PROVISION_TIMEOUT = 10 * 60_000;
const START_TIMEOUT = 5 * 60_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const run = createRunner('Browser test');
await waitForPanel();
const { key } = await openPanel();
const api = apiClient(key);
const browser = await launchChrome();
const page = await browser.newPage();

// Whatever went wrong on the page since the last check, plus any error toast
// its scripts are showing
async function pageProblems() {
    const toasts = await page.eval(`[...document.querySelectorAll('.toast.text-bg-danger')]
        .map((t) => 'error toast: ' + t.textContent.trim().replace(/\\s+/g, ' '))`);
    return [...page.takeProblems(), ...toasts];
}
async function assertClean(what) {
    const problems = await pageProblems();
    assert(problems.length === 0, `${what}:\n${problems.join('\n')}`);
}
const readFile = async (id, path) => (await api('GET', `/servers/${id}/file?path=${encodeURIComponent(path)}`)).body?.file?.content;

let vanilla = null;
let fabric = null;
await run.step('sets up servers to show (over the API)', async () => {
    const base = { version: 'latest', memory: 1024, eula: true };
    vanilla = await provisionServer(api, { ...base, name: 'CI Browser', serverType: 'vanilla', port: 25565, group: 'CI Group' },
        { timeoutMs: PROVISION_TIMEOUT, label: 'vanilla' });
    fabric = await provisionServer(api, { ...base, name: 'CI Browser Fabric', serverType: 'fabric', port: 25566 },
        { timeoutMs: PROVISION_TIMEOUT, label: 'fabric' });
    assertStatus(await api('POST', `/servers/${vanilla.id}/files/mkdir`, { name: 'ci-dir' }), [200, 201], 'mkdir');
});

console.log('Signing in');
let signedIn = false;
await run.step('signs in through the login form', async () => {
    assert(await page.goto('/dashboard') === '/login', 'not sent to sign in');
    await page.type('#username', CI_USER.username);
    await page.type('#password', CI_USER.password);
    await page.waitFor(`!document.querySelector('button[type="submit"]').disabled`, { what: 'the Sign In button to enable' });
    const landed = await page.navigation(() => page.click('button[type="submit"]'));
    assert(landed === '/dashboard', `landed on ${landed}`);
    await assertClean('the dashboard after signing in');
    signedIn = true;
});

if (signedIn && vanilla && fabric) {
    console.log('Pages');
    await run.step('loads every page without a script error', async () => {
        const failures = [];
        for (const [path] of panelPages(vanilla, fabric)) {
            await page.goto(path);
            const problems = await pageProblems();
            if (problems.length) failures.push(`${path}\n    ${problems.join('\n    ')}`);
        }
        assert(failures.length === 0, failures.join('\n'));
    });

    console.log('Flows');
    let created = null;
    await run.step('creates a server from the create page', async () => {
        await page.goto('/servers/create');
        await page.waitFor(`document.getElementById('version').value`, { what: 'the newest version to be filled in' });
        await page.type('#name', 'CI Browser Created');
        await page.type('#port', '25567');
        await page.click('#eula');
        await page.waitFor(`!document.getElementById('create-btn').disabled`, { what: 'the Create button to enable' });
        const landed = await page.navigation(() => page.click('#create-btn'));
        created = new RegExp(`^/servers/(${UUID})$`).exec(landed)?.[1];
        assert(created, `landed on ${landed}`);
        await assertClean('the new server\'s console page');
        const server = await waitForState(api, created, ['stopped'], { timeoutMs: PROVISION_TIMEOUT, label: 'created' });
        const latest = (await api('GET', '/versions?type=vanilla')).body?.latest;
        assert(server.name === 'CI Browser Created' && server.port === 25567 && server.serverType === 'vanilla' && server.version === latest,
            `created ${JSON.stringify({ name: server.name, port: server.port, type: server.serverType, version: server.version })}`);
    });

    if (created) {
        await run.step('starts it from its page and runs a console command', async () => {
            await page.goto(`/servers/${created}`);
            await withUpstream(['mojang'], async () => {
                await page.waitFor(`!document.querySelector('[data-action="start"]').disabled`, { what: 'Start to enable' });
                await page.click('[data-action="start"]');
                await waitForState(api, created, ['running'], { timeoutMs: START_TIMEOUT, label: 'created' });
            });
            await page.waitFor(`!document.getElementById('console-input').disabled`, { what: 'the console input to enable' });
            await page.waitFor(`/Done \\(/.test(document.getElementById('console-output').textContent)`, { what: 'the "Done" line' });
            await page.type('#console-input', 'list');
            await page.press('Enter');
            await page.waitFor(`/There are \\d+ (of a max of \\d+ )?players online/i.test(document.getElementById('console-output').textContent)`,
                { what: 'the reply to "list"' });
            assert(await page.eval(`document.getElementById('console-input').value`) === '', 'the input kept the command');
            await page.click('[data-action="stop"]');
            await waitForState(api, created, ['stopped'], { timeoutMs: 120_000, label: 'created' });
            await page.waitFor(`!document.querySelector('[data-action="start"]').disabled`, { what: 'Start to enable after stopping' });
            await assertClean('the console page');
        });
    }

    await run.step('saves a file in the editor', async () => {
        assertStatus(await api('POST', `/servers/${vanilla.id}/edit-file`, { filePath: 'ci-dir/notes.txt', content: 'before\n' }), 200, 'seed file');
        await page.goto(`/servers/${vanilla.id}/edit-file?path=ci-dir/notes.txt`);
        await page.type('#file-editor', 'after, from the browser\n');
        const landed = await page.navigation(() => page.click('button[type="submit"][form="editor-form"]'));
        assert(landed === `/servers/${vanilla.id}/files/ci-dir`, `landed on ${landed}`);
        const content = await readFile(vanilla.id, 'ci-dir/notes.txt');
        assert(content === 'after, from the browser\n', `file holds ${JSON.stringify(content)}`);
        await assertClean('the file editor');
    });

    await run.step('saves Properties', async () => {
        await page.goto(`/servers/${vanilla.id}/properties`);
        await page.type('#properties-form [name="max-players"]', '12');
        // It reloads with ?saved=1, which restart-modal.js reads and drops
        const landed = await page.navigation(() => page.click('#properties-form button[type="submit"]'));
        assert(landed === `/servers/${vanilla.id}/properties`, `landed on ${landed}`);
        const props = await readFile(vanilla.id, 'server.properties');
        assert(/^max-players=12$/m.test(props), 'max-players not saved');
        assert(/^online-mode=true$/m.test(props) && /^pvp=true$/m.test(props), 'the save switched other toggles off');
        await assertClean('the Properties page');
    });

    await run.step('saves Properties behind a restore-point backup', async () => {
        const before = (await api('GET', `/servers/${vanilla.id}/backups`)).body.backups.length;
        await page.goto(`/servers/${vanilla.id}/properties`);
        await page.type('#properties-form [name="max-players"]', '13');
        await page.click('#saveBackup');
        const landed = await page.navigation(() => page.click('#properties-form button[type="submit"]'), { timeoutMs: 120_000 });
        assert(landed === `/servers/${vanilla.id}/properties`, `landed on ${landed}`);
        assert(/^max-players=13$/m.test(await readFile(vanilla.id, 'server.properties')), 'max-players not saved');
        const backups = (await api('GET', `/servers/${vanilla.id}/backups`)).body.backups;
        assert(backups.length === before + 1 && backups.some((b) => b.name === 'Pre-properties backup'),
            `backups: ${backups.map((b) => b.name).join(', ')}`);
        await assertClean('the Properties page after a restore-point save');
    });

    await run.step('saves Settings', async () => {
        await page.goto(`/servers/${vanilla.id}/edit`);
        await page.click('a[href="#advancedOptions"]');
        await page.waitFor(`document.getElementById('advancedOptions').classList.contains('show')`, { what: 'Advanced Options to open' });
        await page.type('#memory', '1536');
        const landed = await page.navigation(() => page.click('#edit-server-form button[type="submit"]'));
        assert(landed === `/servers/${vanilla.id}/edit`, `landed on ${landed}`);
        const server = (await api('GET', `/servers/${vanilla.id}`)).body.server;
        assert(server.memory === 1536 && server.name === 'CI Browser', `memory ${server.memory}, name ${server.name}`);
        await assertClean('the Settings page');
    });
}

await browser.close();
run.finish();
