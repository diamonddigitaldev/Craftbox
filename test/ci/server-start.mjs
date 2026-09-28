// Server start test: for each server type, create a server at the newest
// stable Minecraft version through the API, start it, wait for the "Done"
// line, round-trip a console command, stop it and delete it.
//
//   CRAFTBOX_URL=http://localhost:6464 node test/ci/server-start.mjs paper fabric
//
// With no arguments every type except `custom` is tested, one after another.
// CRAFTBOX_API_KEY reuses a key instead of running the setup wizard, so several
// invocations can share one panel.

import {
    waitForPanel, bootstrapApiKey, apiClient, waitForState, provisionServer,
    withUpstream, transientError, TYPE_UPSTREAMS,
    createRunner, assert, assertStatus, sleep
} from './lib.mjs';

const ALL_TYPES = ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'forge', 'neoforge'];
const types = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL_TYPES;

// Forge/NeoForge run an installer while provisioning, and their first start
// is the slowest of the lot; a cold runner can take a few minutes for either.
const PROVISION_TIMEOUT = 15 * 60_000;
const START_TIMEOUT = 10 * 60_000;
const STOP_TIMEOUT = 3 * 60_000;

async function consoleTail(api, id, limit = 60) {
    const res = await api('GET', `/servers/${id}/console?limit=${limit}`);
    return (res.body?.lines || []).map((l) => l.line).join('\n');
}

async function waitForConsole(api, id, pattern, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pattern.test(await consoleTail(api, id, 200))) return;
        await sleep(1000);
    }
    throw new Error(`console never matched ${pattern}`);
}

const run = createRunner('Server start test');
await waitForPanel();
const api = apiClient(process.env.CRAFTBOX_API_KEY || await bootstrapApiKey());

for (const type of types) {
    console.log(`\n${type}`);
    let version = null;
    let id = null;
    let started = false;

    await run.step(`${type}: resolve the latest stable version`, async () => {
        await withUpstream(TYPE_UPSTREAMS[type], async () => {
            const res = await api('GET', `/versions?type=${encodeURIComponent(type)}`);
            // Craftbox answers 500 when it couldn't reach the upstream
            if (res.status === 500) throw transientError(`versions: HTTP 500 ${res.text}`);
            assertStatus(res, 200, 'versions');
            version = res.body.latest;
        });
        assert(version, 'no stable version published');
        console.log(`    latest: ${version}`);
    });
    if (!version) continue;

    await run.step(`${type} ${version}: provision`, async () => {
        const server = await provisionServer(api, {
            name: `CI ${type}`, serverType: type, version,
            port: 25565, memory: 2048, eula: true
        }, { timeoutMs: PROVISION_TIMEOUT, label: type });
        id = server.id;
        console.log(`    build: ${server.build ?? 'n/a'}, Java ${server.javaMajor ?? '?'}`);
    });
    if (!id) continue;

    await run.step(`${type} ${version}: start and reach "Done"`, async () => {
        // Paper and its forks fetch Mojang's jar on their first start
        await withUpstream(['mojang'], async () => {
            assertStatus(await api('POST', `/servers/${id}/start`), 200, 'start');
            try {
                await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT, label: type });
            } catch (err) {
                throw new Error(`${err.message}\n--- console (tail) ---\n${await consoleTail(api, id, 30)}`);
            }
        });
        started = true;
    });

    if (started) {
        await run.step(`${type} ${version}: answer a console command`, async () => {
            assertStatus(await api('POST', `/servers/${id}/command`, { command: 'list' }), 200, 'command');
            await waitForConsole(api, id, /There are \d+ (of a max of \d+ )?players online/i, 30_000);
        });

        await run.step(`${type} ${version}: stop cleanly`, async () => {
            assertStatus(await api('POST', `/servers/${id}/stop`), 200, 'stop');
            await waitForState(api, id, ['stopped'], { timeoutMs: STOP_TIMEOUT, label: type });
        });
    }

    // Always clean up, so a failure doesn't hold the port for the next type
    await run.step(`${type}: delete`, async () => {
        const state = (await api('GET', `/servers/${id}`)).body?.server?.state;
        if (!['stopped', 'crashed'].includes(state)) {
            await api('POST', `/servers/${id}/kill`);
            await waitForState(api, id, ['stopped', 'crashed'], { timeoutMs: 60_000, label: type });
        }
        assertStatus(await api('DELETE', `/servers/${id}`), 200, 'delete');
    });
}

run.finish();
