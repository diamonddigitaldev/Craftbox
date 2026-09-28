// Modrinth test: Craftbox's Modrinth integration against the real Modrinth,
// so it runs weekly rather than on every PR. The proxied search and
// lookups, installing a mod with its required dependency into a Fabric
// server and starting it with them loaded, a plugin into Paper, and a whole
// server created from a published modpack, then started.
//
//   CRAFTBOX_URL=http://localhost:6464 node test/ci/modrinth.mjs

import {
    waitForPanel, openPanel, apiClient, provisionServer, waitForState, withUpstream, transientError,
    createRunner, assert, assertStatus
} from './lib.mjs';

const PROVISION_TIMEOUT = 15 * 60_000;
const START_TIMEOUT = 10 * 60_000;
const FABRIC_API = 'P7dR8mSH';
// Simply Optimized: a small (a dozen or so server-side mods) Fabric pack
// built to run on servers too
const MODPACK = 'BYfVnHa7';

const run = createRunner('Modrinth test');
await waitForPanel();
const api = apiClient((await openPanel()).key);

// A Modrinth lookup through Craftbox, which answers 502 or 429 when
// Modrinth is down or rate limiting
async function modrinth(method, path, body) {
    return withUpstream(['modrinth'], async () => {
        const res = await api(method, path, body);
        if (res.status === 502 || res.status === 429) throw transientError(`${path}: HTTP ${res.status} ${res.text}`);
        return res;
    });
}
async function startAndStop(id, label) {
    await withUpstream(['mojang'], async () => {
        assertStatus(await api('POST', `/servers/${id}/start`), 200, 'start');
        await waitForState(api, id, ['running'], { timeoutMs: START_TIMEOUT, label });
    });
    assertStatus(await api('POST', `/servers/${id}/stop`), 200, 'stop');
    await waitForState(api, id, ['stopped'], { timeoutMs: 180_000, label });
}

console.log('Search and lookups');
await run.step('searches modpacks, mods and plugins', async () => {
    const packs = await modrinth('GET', '/modrinth/search?projectType=modpack&limit=5');
    assert(packs.status === 200 && packs.body.hits.length === 5 && packs.body.totalHits > 5, `modpacks: ${packs.status} ${packs.text.slice(0, 200)}`);
    const mods = await modrinth('GET', '/modrinth/search?projectType=mod&loader=fabric&query=lithium');
    assert(mods.body.hits?.some((h) => h.slug === 'lithium'), `lithium not found: ${mods.text.slice(0, 200)}`);
    const plugins = await modrinth('GET', '/modrinth/search?projectType=mod&loader=paper&query=luckperms');
    assert(plugins.body.hits?.some((h) => h.slug === 'luckperms'), `luckperms not found: ${plugins.text.slice(0, 200)}`);
    assertStatus(await api('GET', '/modrinth/search?projectType=mod&query=lithium'), 400, 'a mod search without a loader');
});
await run.step('looks up a project and only the versions asked for', async () => {
    const project = (await modrinth('GET', '/modrinth/projects/lithium')).body?.project;
    assert(project?.slug === 'lithium' && project.projectType === 'mod', JSON.stringify(project));
    const mc = (await api('GET', '/versions?type=fabric')).body.latest;
    const versions = (await modrinth('GET', `/modrinth/projects/lithium/versions?loader=fabric&gameVersion=${mc}`)).body.versions;
    assert(versions.length > 0, `no Lithium for Fabric ${mc}`);
    const off = versions.filter((v) => !v.loaders.includes('fabric') || !v.gameVersions.includes(mc));
    assert(off.length === 0, `versions outside the filter: ${off.map((v) => v.versionNumber).join(', ')}`);
    assertStatus(await modrinth('GET', '/modrinth/projects/no-such-project-ci-0000'), 404, 'an unknown project');
});

console.log('Installs');
await run.step('installs a mod with its required dependency, and starts with them', async () => {
    const server = await provisionServer(api, {
        name: 'CI Modrinth Fabric', serverType: 'fabric', version: 'latest', port: 25565, memory: 2048, eula: true
    }, { timeoutMs: PROVISION_TIMEOUT, label: 'fabric' });
    const res = await modrinth('POST', `/servers/${server.id}/modrinth-install`, { projectId: 'appleskin' });
    assert(res.status === 200, `install: ${res.status} ${res.text}`);
    const projects = res.body.installed.map((i) => i.projectId);
    assert(projects.length === 2 && projects.includes(FABRIC_API), `installed ${JSON.stringify(res.body.installed)}`);
    const installed = (await modrinth('GET', `/servers/${server.id}/modrinth-installed`)).body.projects;
    assert(Object.keys(installed).length === 2 && installed[FABRIC_API], `recognised: ${JSON.stringify(installed)}`);
    assertStatus(await modrinth('POST', `/servers/${server.id}/modrinth-install`, { projectId: 'appleskin' }), 409, 'installing it again');
    await startAndStop(server.id, 'fabric with mods');
    const log = (await api('GET', `/servers/${server.id}/console?limit=400`)).body.lines.map((l) => l.line).join('\n');
    assert(/appleskin/i.test(log) && /fabric-api|fabric api/i.test(log), 'the mods weren\'t loaded');
});
await run.step('installs a plugin into a Paper server', async () => {
    const server = await provisionServer(api, {
        name: 'CI Modrinth Paper', serverType: 'paper', version: 'latest', port: 25566, memory: 2048, eula: true
    }, { timeoutMs: PROVISION_TIMEOUT, label: 'paper' });
    const res = await modrinth('POST', `/servers/${server.id}/modrinth-install`, { projectId: 'luckperms' });
    assert(res.status === 200 && res.body.installed.length === 1, `install: ${res.status} ${res.text}`);
    const files = (await api('GET', `/servers/${server.id}/plugins`)).body.files.map((f) => f.name);
    assert(files.includes(res.body.installed[0].filename), `plugins: ${files.join(', ')}`);
});

console.log('Modpacks');
await run.step('creates a server from a Modrinth modpack, and starts it', async () => {
    const versions = (await modrinth('GET', `/modrinth/projects/${MODPACK}/versions?loader=fabric`)).body.versions;
    const version = versions?.[0];
    assert(version, 'no Fabric version of the modpack');
    const server = await provisionServer(api, {
        projectId: MODPACK, versionId: version.id, name: 'CI Modpack', port: 25567, memory: 3072, eula: true
    }, { path: '/servers/from-modpack', timeoutMs: PROVISION_TIMEOUT, label: 'modpack', upstreams: ['modrinth', 'fabric', 'mojang'] });
    assert(server.modpack?.projectId === MODPACK && server.modpack.versionId === version.id && server.modpack.source === 'modrinth',
        `modpack record: ${JSON.stringify(server.modpack)}`);
    assert(server.serverType === 'fabric' && version.gameVersions.includes(server.version), `${server.serverType} ${server.version}`);
    const mods = (await api('GET', `/servers/${server.id}/plugins`)).body.files;
    assert(mods.length > 3, `only ${mods.length} mods installed`);
    console.log(`    ${version.name}: ${mods.length} mods, ${mods.filter((m) => m.environment === 'client').length} client-only`);
    await startAndStop(server.id, 'modpack');
});

run.finish();
