// ── State ──
let selectedType = 'vanilla';
let typesData = [];

// ── DOM refs ──
const eulaCheck = document.getElementById('eula');
const createBtn = document.getElementById('create-btn');
// Original markup (icon + label) — restored after a failed submit; assigning
// textContent instead would silently drop the "+" icon.
const CREATE_BTN_HTML = createBtn.innerHTML;
const form = document.getElementById('create-server-form');
const typeInput = document.getElementById('serverType');
const typeSelector = document.getElementById('type-selector');
const versionGroup = document.getElementById('version-group');
const versionHidden = document.getElementById('version');
const versionDisplay = document.getElementById('version-display');
const versionBrowseBtn = document.getElementById('version-browse-btn');
const customUrlGroup = document.getElementById('custom-url-group');
const customTypeNotice = document.getElementById('custom-type-notice');
const typeSelectGroup = document.getElementById('type-select-group');
const modpackSummary = document.getElementById('modpack-summary');
const mrpackFileGroup = document.getElementById('mrpack-file-group');
const mrpackFileInput = document.getElementById('mrpack-file');
const createSourceGroup = document.getElementById('create-source-group');
const sourceCards = document.querySelectorAll('#create-source-group .type-card');
const sourceTemplateCard = document.getElementById('source-template-card');

// ── Creation mode ──
// 'modpack' when arriving from the browse page with a chosen pack
// (?modpack=ID&version=ID); otherwise 'normal', where the in-page
// Template/Modpack source cards drive what the form shows (neither
// selected = create from scratch).
const _createParams = new URLSearchParams(window.location.search);
const createMode = (_createParams.get('modpack') && _createParams.get('version')) ? 'modpack' : 'normal';

let selectedSource = 'scratch';
function currentSource() {
    return selectedSource;
}

// ── Version picker ──
const versionPicker = CraftboxVersionPicker({
    onSelect: (v) => {
        setVersionField(v.id);
        validateCreateForm();
    }
});

function setVersionField(id) {
    versionHidden.value = id || '';
    versionDisplay.value = id || '';
}

function openVersionPicker() {
    if (selectedType === 'custom') return;
    versionPicker.open(selectedType, { selectedVersion: versionHidden.value });
}

versionBrowseBtn.addEventListener('click', openVersionPicker);
versionDisplay.addEventListener('click', openVersionPicker);

function setCustomNoticeVisible(visible) {
    if (!customTypeNotice) return;
    customTypeNotice.classList.toggle('d-none', !visible);
    customTypeNotice.classList.toggle('d-flex', visible);
}

// ── Center form fields left alone on their row ──
// A row whose other columns are hidden (e.g. the port field once the version
// picker is gone in modpack mode, or the group picker on its own row) looks
// lopsided half-width on the left; center it instead.
function centerLoneRowItems() {
    form.querySelectorAll('.row').forEach(function (row) {
        var cols = row.querySelectorAll(':scope > [class*="col-"]');
        if (cols.length === 0) return;
        var visible = Array.prototype.filter.call(cols, function (c) {
            return !c.classList.contains('d-none');
        });
        row.classList.toggle('justify-content-center', visible.length === 1);
    });
}

// ── Required field validation + EULA gating ──
function validateCreateForm() {
    centerLoneRowItems();
    if (!eulaCheck.checked) { createBtn.disabled = true; return; }
    var fields = form.querySelectorAll('[required]');
    var allFilled = true;
    fields.forEach(function (f) {
        if (f.type === 'checkbox') {
            if (!f.checked) allFilled = false;
        } else if (f.classList.contains('d-none') || f.closest('.d-none')) {
            // Skip hidden fields (e.g. version when custom type selected)
        } else if (!f.value.trim()) {
            allFilled = false;
        }
    });
    createBtn.disabled = !allFilled;
}

validateCreateForm();
eulaCheck.addEventListener('change', validateCreateForm);
form.addEventListener('input', validateCreateForm);
form.addEventListener('change', validateCreateForm);

// A rejected file clears the input, and the re-fired change event bubbles to the
// form listener above, so the Create button goes back to disabled.
guardFileInput(mrpackFileInput, ['.mrpack'], 'Only .mrpack modpack files can be used here.');

// ── Form submit — create via /api/v1/servers (or the modpack routes) ──
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;

    createBtn.disabled = true;
    createBtn.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status"></span> Creating...';

    if (createMode === 'modpack') return submitFromModpack();
    if (currentSource() === 'modpack') return submitFromMrpack();

    const typeName = typesData.find(t => t.id === selectedType)?.name || selectedType;
    const ver = selectedType === 'custom' ? '' : ' ' + (versionHidden.value || '');
    showOverlay(`Setting up your ${typeName}${ver} server...`, 'Getting everything ready. This may take a minute.');

    var body = {};
    new FormData(form).forEach(function (v, k) {
        if (k === '_csrf') return;
        // Checkboxes only appear when checked
        body[k] = v;
    });
    // EULA checkbox — explicit boolean
    body.eula = !!document.getElementById('eula').checked;

    var res = await apiFetch('/api/v1/servers', { method: 'POST', body: body });
    if (!res.ok) {
        hideOverlay();
        showToast((res.data && (res.data.message || res.data.error)) || 'Failed to create server.', 'danger');
        restoreCreateBtn();
        return;
    }
    var newId = res.data && res.data.server && res.data.server.id;
    window.location.href = newId ? '/servers/' + newId : '/dashboard';
});

// ── Load server types ──
(async () => {
    // Modpack modes hide the type/version selectors entirely
    if (createMode !== 'normal') return;
    try {
        const res = await fetch('/api/v1/server-types');
        const data = await res.json();
        typesData = data.types || [];
        renderTypeCards(typesData);
    } catch {
        typeSelector.innerHTML = '<div class="col-12 text-danger">Failed to load server types.</div>';
    }

    // Load initial versions (vanilla)
    await setDefaultVersion('vanilla');
})();

function renderTypeCards(types) {
    typeSelector.innerHTML = '';
    for (const t of types) {
        const col = document.createElement('div');
        col.className = 'col-6 col-md-4 col-lg-3';

        const card = document.createElement('div');
        card.className = 'card type-card text-center p-2' + (t.id === selectedType ? ' selected' : '');
        card.dataset.type = t.id;
        card.setAttribute('role', 'button');
        const iconHtml = t.logo
            ? `<img src="${t.logo}" alt="${t.name}" class="type-card-logo mb-1">`
            : `<span class="material-icons-outlined mb-1" style="font-size: 2rem;">${t.icon}</span>`;
        card.innerHTML = `
            ${iconHtml}
            <div class="small fw-semibold">${t.name}</div>
            <div class="text-body-secondary" style="font-size: 0.7rem;">${t.description}</div>
        `;

        card.addEventListener('click', () => selectType(t.id));
        col.appendChild(card);
        typeSelector.appendChild(col);
    }
}

async function selectType(typeId) {
    if (typeId === selectedType) return;
    selectedType = typeId;
    typeInput.value = typeId;

    // Update card visuals
    typeSelector.querySelectorAll('.type-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.type === typeId);
    });

    // Toggle version vs custom URL
    if (typeId === 'custom') {
        versionGroup.classList.add('d-none');
        customUrlGroup.classList.remove('d-none');
        versionDisplay.removeAttribute('required');
        setCustomNoticeVisible(true);
        centerLoneRowItems();
    } else {
        versionGroup.classList.remove('d-none');
        customUrlGroup.classList.add('d-none');
        versionDisplay.setAttribute('required', '');
        setCustomNoticeVisible(false);
        await setDefaultVersion(typeId);
    }
}

// Fill the version field with `preselect` (template/duplicate flows) when the
// type offers it, otherwise the newest stable version. The picker caches the
// version list per type, so this shares its fetch with the browse modal.
async function setDefaultVersion(typeId, preselect) {
    setVersionField('');
    versionDisplay.placeholder = 'Loading versions...';
    // Disable submit while versions are loading to prevent empty version submission
    createBtn.disabled = true;
    try {
        const data = await versionPicker.getVersions(typeId);
        const preselected = preselect && data.versions.some(v => v.id === preselect) ? preselect : null;
        setVersionField(preselected || data.latest || data.versions[0]?.id || '');
        versionDisplay.placeholder = versionHidden.value ? 'Select a version...' : 'No versions available';
    } catch {
        versionDisplay.placeholder = 'Failed to load versions';
    } finally {
        validateCreateForm();
    }
}

// ── Template loading ──
const templateSelect = document.getElementById('template-select');
const templateGroup = document.getElementById('template-group');

(async () => {
    // Templates pick a type/version themselves — not applicable to modpack modes
    if (createMode !== 'normal') return;
    try {
        const res = await fetch('/api/v1/templates');
        const data = await res.json();
        if (data.templates && data.templates.length > 0) {
            // Unlock the Template card in the Create From picker; the select
            // itself only shows once that source is picked.
            sourceTemplateCard.classList.remove('type-card-disabled');
            sourceTemplateCard.removeAttribute('title');
            for (const t of data.templates) {
                const opt = document.createElement('option');
                opt.value = t.id;
                const typeName = (t.serverType || 'vanilla').charAt(0).toUpperCase() + (t.serverType || 'vanilla').slice(1);
                opt.textContent = `${t.name} (${typeName}${t.serverType === 'custom' ? '' : ` ${t.version}` || ''})`.trim();
                templateSelect.appendChild(opt);
            }
        }
    } catch { /* ignore — templates are optional */ }
})();

function setTypeAndVersionLocked(locked) {
    // Disable/enable type cards
    typeSelector.querySelectorAll('.type-card').forEach(c => {
        if (locked) {
            c.style.pointerEvents = 'none';
            c.style.opacity = '0.5';
        } else {
            c.style.pointerEvents = '';
            c.style.opacity = '';
        }
    });

    // Lock the version field visually — the hidden input keeps the value
    // submittable (disabled fields are excluded from form submission)
    if (locked) {
        versionDisplay.style.pointerEvents = 'none';
        versionDisplay.style.opacity = '0.5';
        versionBrowseBtn.disabled = true;
        versionBrowseBtn.style.opacity = '0.5';
    } else {
        versionDisplay.style.pointerEvents = '';
        versionDisplay.style.opacity = '';
        versionBrowseBtn.disabled = false;
        versionBrowseBtn.style.opacity = '';
    }

    // Lock custom URL input visually but keep it submittable
    const customUrlInput = document.getElementById('customJarUrl');
    if (customUrlInput) {
        if (locked) {
            customUrlInput.style.pointerEvents = 'none';
            customUrlInput.style.opacity = '0.5';
        } else {
            customUrlInput.style.pointerEvents = '';
            customUrlInput.style.opacity = '';
        }
    }
}

templateSelect.addEventListener('change', async () => {
    const id = templateSelect.value;

    // "None" selected — unlock type/version and reset
    if (!id) {
        setTypeAndVersionLocked(false);
        return;
    }

    try {
        const res = await fetch(`/api/v1/templates/${id}`);
        const data = await res.json();
        const t = data.template;
        if (!t) return;

        // Set server type
        if (t.serverType && t.serverType !== selectedType) {
            // Update card selection visually
            selectedType = t.serverType;
            typeInput.value = t.serverType;
            typeSelector.querySelectorAll('.type-card').forEach(c => {
                c.classList.toggle('selected', c.dataset.type === t.serverType);
            });

            if (t.serverType === 'custom') {
                versionGroup.classList.add('d-none');
                customUrlGroup.classList.remove('d-none');
                versionDisplay.removeAttribute('required');
                setCustomNoticeVisible(true);
                if (t.customJarUrl) {
                    document.getElementById('customJarUrl').value = t.customJarUrl;
                }
            } else {
                versionGroup.classList.remove('d-none');
                customUrlGroup.classList.add('d-none');
                versionDisplay.setAttribute('required', '');
                setCustomNoticeVisible(false);
                await setDefaultVersion(t.serverType, t.version);
            }
        } else if (t.serverType === 'custom' && t.customJarUrl) {
            document.getElementById('customJarUrl').value = t.customJarUrl;
        } else if (t.serverType !== 'custom' && t.version) {
            await setDefaultVersion(t.serverType, t.version);
        }

        // Lock type and version selection
        setTypeAndVersionLocked(true);

        // Fill form fields
        if (t.port) document.getElementById('port').value = t.port;
        if (t.gamemode) document.getElementById('gamemode').value = t.gamemode;
        if (t.difficulty) document.getElementById('difficulty').value = t.difficulty;

        // Advanced options
        if (t.memory && t.memory !== 2048) {
            document.getElementById('memory').value = t.memory;
            const collapse = document.getElementById('advancedOptions');
            if (!collapse.classList.contains('show')) {
                new bootstrap.Collapse(collapse, { toggle: true });
            }
        }
        if (t.javaArgs) {
            document.getElementById('javaArgs').value = t.javaArgs;
            const collapse = document.getElementById('advancedOptions');
            if (!collapse.classList.contains('show')) {
                new bootstrap.Collapse(collapse, { toggle: true });
            }
        }
    } catch { /* ignore */ }
});

// ══════════════════════════════════════════════
// Modpack / .mrpack creation modes
// ══════════════════════════════════════════════

const LOADER_DISPLAY_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };

function restoreCreateBtn() {
    createBtn.disabled = false;
    createBtn.innerHTML = CREATE_BTN_HTML;
    validateCreateForm();
}

// Common base fields for both modpack submit paths
function collectBaseFields() {
    return {
        name: document.getElementById('name').value.trim(),
        port: document.getElementById('port').value,
        memory: document.getElementById('memory').value,
        javaArgs: document.getElementById('javaArgs').value,
        gamemode: document.getElementById('gamemode').value,
        difficulty: document.getElementById('difficulty').value,
        seed: document.getElementById('seed').value,
        group: document.getElementById('group').value
    };
}

// Hide the type/version pickers — the pack decides both
function hideTypeAndVersionPickers() {
    templateGroup.classList.add('d-none');
    typeSelectGroup.classList.add('d-none');
    versionGroup.classList.add('d-none');
    versionDisplay.removeAttribute('required');
    customUrlGroup.classList.add('d-none');
}

// Modpacks are heavy — suggest more memory than the 2 GB default. The
// suggestion is undone by revertModpackMemory() when the Modpack source is
// deselected, unless the user has edited the value themselves since.
let memorySuggestion = null; // { previousValue, previousHint, expandedAdvanced }

function suggestModpackMemory() {
    const memoryInput = document.getElementById('memory');
    if (memorySuggestion || parseInt(memoryInput.value, 10) >= 4096) return;
    const hint = memoryInput.parentElement.querySelector('.form-text');
    const collapse = document.getElementById('advancedOptions');
    const expandAdvanced = !!(collapse && !collapse.classList.contains('show'));
    memorySuggestion = {
        previousValue: memoryInput.value,
        previousHint: hint ? hint.textContent : null,
        expandedAdvanced: expandAdvanced
    };
    memoryInput.value = 4096;
    if (hint) hint.textContent = 'RAM allocated to the server (-Xmx). Modpacks usually need 4-8 GB.';
    if (expandAdvanced) new bootstrap.Collapse(collapse, { toggle: true });
}

function revertModpackMemory() {
    if (!memorySuggestion) return;
    const memoryInput = document.getElementById('memory');
    const hint = memoryInput.parentElement.querySelector('.form-text');
    // Only undo what is still untouched — a user-edited value stays put.
    if (memoryInput.value === '4096') {
        memoryInput.value = memorySuggestion.previousValue;
        if (memorySuggestion.expandedAdvanced) {
            const collapse = document.getElementById('advancedOptions');
            if (collapse && collapse.classList.contains('show')) {
                new bootstrap.Collapse(collapse, { toggle: true });
            }
        }
    }
    if (hint && memorySuggestion.previousHint) hint.textContent = memorySuggestion.previousHint;
    memorySuggestion = null;
}

async function enterModpackMode() {
    // The pack was already chosen on the browse page — no source toggle here
    createSourceGroup.classList.add('d-none');
    hideTypeAndVersionPickers();
    modpackSummary.classList.remove('d-none');
    suggestModpackMemory();
    validateCreateForm();

    const projectId = _createParams.get('modpack');
    const versionId = _createParams.get('version');
    document.getElementById('modpackProject').value = projectId;
    document.getElementById('modpackVersion').value = versionId;

    // Back out to a clean create page ("choose a different setup")
    document.getElementById('modpack-clear').addEventListener('click', () => {
        window.location.href = '/servers/create';
    });

    // Fill the summary card from the proxy (authoritative data lives server-side;
    // this is display only)
    const [projRes, versRes] = await Promise.all([
        apiFetch('/api/v1/modrinth/projects/' + encodeURIComponent(projectId)),
        apiFetch('/api/v1/modrinth/projects/' + encodeURIComponent(projectId) + '/versions')
    ]);
    const project = projRes.ok && projRes.data && projRes.data.project;
    const version = versRes.ok && versRes.data
        && (versRes.data.versions || []).find(v => v.id === versionId);
    if (!project || !version) {
        showToast('Failed to load modpack details.', 'danger');
        window.location.href = '/servers/create';
        return;
    }

    document.getElementById('modpack-title').textContent = project.title;
    document.getElementById('modpack-subtitle').textContent = 'Version ' + version.versionNumber;

    const badges = document.getElementById('modpack-badges');
    (version.loaders || []).forEach(l => {
        if (!LOADER_DISPLAY_NAMES[l]) return;
        const badge = document.createElement('span');
        badge.className = 'badge bg-info';
        badge.textContent = LOADER_DISPLAY_NAMES[l];
        badges.appendChild(badge);
    });
    (version.gameVersions || []).slice(0, 1).forEach(gv => {
        const badge = document.createElement('span');
        badge.className = 'badge bg-secondary';
        badge.textContent = 'MC ' + gv;
        badges.appendChild(badge);
    });

    if (project.iconUrl) {
        const icon = document.getElementById('modpack-icon');
        icon.addEventListener('error', () => {
            icon.classList.add('d-none');
            document.getElementById('modpack-icon-placeholder').classList.remove('d-none');
        });
        icon.src = project.iconUrl;
        icon.classList.remove('d-none');
        document.getElementById('modpack-icon-placeholder').classList.add('d-none');
    }

    // Suggest the pack title as the server name (filtered to the allowed charset)
    const nameInput = document.getElementById('name');
    if (!nameInput.value.trim()) {
        const suggested = (project.title || '')
            .replace(/[^a-zA-Z0-9 _\-]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50);
        if (suggested) nameInput.value = suggested;
    }
    validateCreateForm();
}

// ── Create From toggle (Scratch / Template / Modpack) ──
function applySource(source) {
    // Template select only for the Template source
    templateGroup.classList.toggle('d-none', source !== 'template');
    if (source !== 'template' && templateSelect.value) {
        templateSelect.value = '';
        setTypeAndVersionLocked(false);
    }

    // Modpack source: the pack decides the loader + version, so those pickers go
    mrpackFileGroup.classList.toggle('d-none', source !== 'modpack');
    if (source === 'modpack') {
        mrpackFileInput.setAttribute('required', '');
        typeSelectGroup.classList.add('d-none');
        versionGroup.classList.add('d-none');
        versionDisplay.removeAttribute('required');
        customUrlGroup.classList.add('d-none');
        setCustomNoticeVisible(false);
        suggestModpackMemory();
    } else {
        mrpackFileInput.removeAttribute('required');
        typeSelectGroup.classList.remove('d-none');
        if (selectedType === 'custom') {
            customUrlGroup.classList.remove('d-none');
            setCustomNoticeVisible(true);
        } else {
            versionGroup.classList.remove('d-none');
            versionDisplay.setAttribute('required', '');
        }
        revertModpackMemory();
    }
    validateCreateForm();
}

sourceCards.forEach(function (card) {
    card.addEventListener('click', function () {
        // Toggle: clicking the active card deselects it (back to from-scratch)
        selectedSource = (selectedSource === card.dataset.source) ? 'scratch' : card.dataset.source;
        sourceCards.forEach(function (c) {
            c.classList.toggle('selected', c.dataset.source === selectedSource);
        });
        applySource(selectedSource);
    });
});

async function submitFromModpack() {
    const packName = document.getElementById('modpack-title').textContent || 'modpack';
    showOverlay('Setting up "' + packName + '"...',
        'Downloading the modpack and mod loader. This can take several minutes.');

    const body = collectBaseFields();
    body.eula = !!eulaCheck.checked;
    body.projectId = document.getElementById('modpackProject').value;
    body.versionId = document.getElementById('modpackVersion').value;

    const res = await apiFetch('/api/v1/servers/from-modpack', { method: 'POST', body: body });
    if (!res.ok) {
        hideOverlay();
        showToast((res.data && (res.data.message || res.data.error)) || 'Failed to create server from modpack.', 'danger');
        restoreCreateBtn();
        return;
    }
    const newId = res.data && res.data.server && res.data.server.id;
    window.location.href = newId ? '/servers/' + newId : '/dashboard';
}

async function submitFromMrpack() {
    const file = mrpackFileInput.files[0];
    if (!file) { restoreCreateBtn(); return; }

    showOverlay('Preparing upload...', file.name + ' (0%)');

    const fields = collectBaseFields();
    fields.eula = eulaCheck.checked ? 'true' : 'false';

    const res = await uploadFile('/api/v1/servers/from-mrpack', file, {
        fieldName: 'mrpack',
        fields: fields,
        onProgress: (loaded, total) => {
            const pct = total ? Math.round((loaded / total) * 100) : 0;
            showOverlay('Uploading...', file.name + ' (' + pct + '%)');
        }
    });
    if (res.aborted) { hideOverlay(); restoreCreateBtn(); return; }
    if (!res.ok) {
        hideOverlay();
        showToast((res.data && (res.data.message || res.data.error)) || 'Failed to upload modpack.', 'danger');
        restoreCreateBtn();
        return;
    }
    flashToast('Modpack uploaded. Installing...', 'info');
    const newId = res.data && res.data.server && res.data.server.id;
    window.location.href = newId ? '/servers/' + newId : '/dashboard';
}

if (createMode === 'modpack') enterModpackMode();
