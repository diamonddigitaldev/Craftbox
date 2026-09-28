// Server start test: for each server type, create a server through the API,
// start it, wait for the "Done" line, round-trip a console command, stop it
// and delete it.
//
//   CRAFTBOX_URL=http://localhost:6464 node test/ci/server-start.mjs paper fabric
//   CRAFTBOX_URL=... node test/ci/server-start.mjs vanilla@1.12.2 forge@1.20.1
//
// A bare type runs the newest stable version; `type@version` pins one, and
// vanilla@snapshot takes the newest snapshot. custom@<version> creates a
// custom server from Mojang's own jar for that version. With no arguments
// every type except `custom` is tested, one after another.
//
// It runs the setup wizard on a fresh panel and signs in to one already set
// up, so several invocations can share one panel; CRAFTBOX_API_KEY skips
// both. With CRAFTBOX_CONTAINER and CRAFTBOX_EXPECT_JAVA (a major version)
// set, it also checks which of the image's Java runtimes the server runs
// on. CRAFTBOX_KNOWN_ISSUE marks the provision step as a known issue (see
// createRunner in lib.mjs).

import {
    CONTAINER, waitForPanel, openPanel, apiClient, waitForState, provisionServer,
    withUpstream, upstreamFetch, transientError, docker, TYPE_UPSTREAMS, UPSTREAMS,
    createRunner, assert, assertStatus, sleep
} from './lib.mjs';

const ALL_TYPES = ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'forge', 'neoforge'];
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL_TYPES;
const EXPECT_JAVA = process.env.CRAFTBOX_EXPECT_JAVA || null;

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

// The version to create, as Craftbox lists it
async function resolveVersion(api, type, pinned) {
    if (pinned && pinned !== 'snapshot') return pinned;
    return withUpstream(TYPE_UPSTREAMS[type], async () => {
        const channel = pinned === 'snapshot' ? 'all' : 'stable';
        const res = await api('GET', `/versions?type=${encodeURIComponent(type)}&channel=${channel}`);
        // Craftbox answers 500 when it couldn't reach the upstream
        if (res.status === 500) throw transientError(`versions: HTTP 500 ${res.text}`);
        assertStatus(res, 200, 'versions');
        return pinned === 'snapshot' ? res.body.versions.find((v) => v.channel === 'snapshot')?.id : res.body.latest;
    });
}

// Mojang's server jar for `version`, for a custom server to download
async function mojangServerJar(version) {
    const manifest = await (await upstreamFetch(UPSTREAMS.mojang)).json();
    const entry = manifest.versions.find((v) => v.id === version);
    assert(entry, `Mojang has no ${version}`);
    return (await (await upstreamFetch(entry.url)).json()).downloads.server.url;
}

const run = createRunner('Server start test');
await waitForPanel();
const api = apiClient(process.env.CRAFTBOX_API_KEY || (await openPanel()).key);

for (const target of targets) {
    const [type, pinned] = target.split('@');
    console.log(`\n${target}`);
    let version = null;
    let id = null;
    let started = false;

    await run.step(`${type}: resolve ${pinned ? `version ${pinned}` : 'the latest stable version'}`, async () => {
        version = await resolveVersion(api, type === 'custom' ? 'vanilla' : type, pinned);
        assert(version, pinned === 'snapshot' ? 'no snapshot listed' : 'no stable version published');
        console.log(`    version: ${version}`);
    });
    if (!version) continue;
    const label = `${type} ${version}`;

    await run.step(`${label}: provision`, async () => {
        const body = { name: `CI ${type}`, serverType: type, version, port: 25565, memory: 2048, eula: true };
        if (type === 'custom') {
            body.customJarUrl = await mojangServerJar(version);
            delete body.version;
        }
        const server = await provisionServer(api, body, { timeoutMs: PROVISION_TIMEOUT, label: type });
        id = server.id;
        console.log(`    build: ${server.build ?? 'n/a'}, Java ${server.javaMajor ?? '?'}`);
    }, { knownIssue: process.env.CRAFTBOX_KNOWN_ISSUE || undefined });
    if (!id) continue;

    await run.step(`${label}: start and reach "Done"`, async () => {
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
        if (EXPECT_JAVA && CONTAINER) {
            await run.step(`${label}: runs on Java ${EXPECT_JAVA}`, async () => {
                const jvms = docker(['exec', CONTAINER, 'ps', '-eo', 'args']).split('\n').filter((l) => /\/java\s/.test(l));
                assert(jvms.length > 0, 'no JVM running');
                assert(jvms.every((l) => l.includes(`/temurin-${EXPECT_JAVA}-`)), `JVM: ${jvms.map((l) => l.split(' ')[0]).join(', ')}`);
            });
        }

        await run.step(`${label}: answer a console command`, async () => {
            assertStatus(await api('POST', `/servers/${id}/command`, { command: 'list' }), 200, 'command');
            // "There are 0 of a max of 20 players online", or "0/20" before 1.13
            await waitForConsole(api, id, /There are \d+(\/\d+| of a max of \d+)? players online/i, 30_000);
        });

        await run.step(`${label}: stop cleanly`, async () => {
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
