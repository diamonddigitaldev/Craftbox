// ── State ──
let selectedType = 'vanilla';
let typesData = [];

// ── DOM refs ──
const eulaCheck = document.getElementById('eula');
const createBtn = document.getElementById('create-btn');
const form = document.getElementById('create-server-form');
const typeInput = document.getElementById('serverType');
const typeSelector = document.getElementById('type-selector');
const versionGroup = document.getElementById('version-group');
const versionSelect = document.getElementById('version');
const customUrlGroup = document.getElementById('custom-url-group');
const customTypeNotice = document.getElementById('custom-type-notice');

function setCustomNoticeVisible(visible) {
    if (!customTypeNotice) return;
    customTypeNotice.classList.toggle('d-none', !visible);
    customTypeNotice.classList.toggle('d-flex', visible);
}

// ── Required field validation + EULA gating ──
function validateCreateForm() {
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

// ── Form submit — create via /api/v1/servers ──
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;

    createBtn.disabled = true;
    createBtn.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status"></span> Creating...';

    const typeName = typesData.find(t => t.id === selectedType)?.name || selectedType;
    const ver = selectedType === 'custom' ? '' : ' ' + (versionSelect.value || '');
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
        createBtn.disabled = false;
        createBtn.textContent = 'Create Server';
        return;
    }
    var newId = res.data && res.data.server && res.data.server.id;
    window.location.href = newId ? '/servers/' + newId : '/dashboard';
});

// ── Load server types ──
(async () => {
    try {
        const res = await fetch('/api/v1/server-types');
        const data = await res.json();
        typesData = data.types || [];
        renderTypeCards(typesData);
    } catch {
        typeSelector.innerHTML = '<div class="col-12 text-danger">Failed to load server types.</div>';
    }

    // Load initial versions (vanilla)
    await loadVersions('vanilla');
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
        versionSelect.removeAttribute('required');
        setCustomNoticeVisible(true);
    } else {
        versionGroup.classList.remove('d-none');
        customUrlGroup.classList.add('d-none');
        versionSelect.setAttribute('required', '');
        setCustomNoticeVisible(false);
        await loadVersions(typeId);
    }
}

async function loadVersions(typeId, preselect) {
    versionSelect.innerHTML = '<option value="" disabled selected>Loading versions...</option>';
    // Disable submit while versions are loading to prevent empty version submission
    const wasEnabled = !createBtn.disabled;
    createBtn.disabled = true;
    try {
        const res = await fetch(`/api/v1/versions?type=${encodeURIComponent(typeId)}`);
        const data = await res.json();

        versionSelect.innerHTML = '';
        if (data.versions && data.versions.length > 0) {
            data.versions.forEach((v, i) => {
                const opt = document.createElement('option');
                opt.value = v.id;
                opt.textContent = v.id;
                if (preselect ? v.id === preselect : i === 0) opt.selected = true;
                versionSelect.appendChild(opt);
            });
        } else {
            versionSelect.innerHTML = '<option value="">No versions available</option>';
        }
    } catch {
        versionSelect.innerHTML = '<option value="">Failed to load versions</option>';
    } finally {
        validateCreateForm();
    }
}

// ── Template loading ──
const templateSelect = document.getElementById('template-select');
const templateGroup = document.getElementById('template-group');

(async () => {
    try {
        const res = await fetch('/api/v1/templates');
        const data = await res.json();
        if (data.templates && data.templates.length > 0) {
            templateGroup.classList.remove('d-none');
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

    // Lock version select visually but keep it submittable
    // (disabled fields are excluded from form submission)
    if (locked) {
        versionSelect.style.pointerEvents = 'none';
        versionSelect.style.opacity = '0.5';
    } else {
        versionSelect.style.pointerEvents = '';
        versionSelect.style.opacity = '';
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
                versionSelect.removeAttribute('required');
                setCustomNoticeVisible(true);
                if (t.customJarUrl) {
                    document.getElementById('customJarUrl').value = t.customJarUrl;
                }
            } else {
                versionGroup.classList.remove('d-none');
                customUrlGroup.classList.add('d-none');
                versionSelect.setAttribute('required', '');
                setCustomNoticeVisible(false);
                await loadVersions(t.serverType, t.version);
            }
        } else if (t.serverType === 'custom' && t.customJarUrl) {
            document.getElementById('customJarUrl').value = t.customJarUrl;
        } else if (t.serverType !== 'custom' && t.version) {
            await loadVersions(t.serverType, t.version);
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
