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

// ── EULA gating ──
createBtn.disabled = !eulaCheck.checked;
eulaCheck.addEventListener('change', () => {
    createBtn.disabled = !eulaCheck.checked;
});

// ── Form submit overlay ──
form.addEventListener('submit', () => {
    const overlay = document.getElementById('create-overlay');
    overlay.classList.remove('d-none');
    createBtn.disabled = true;
    createBtn.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status"></span> Creating...';

    const title = document.getElementById('create-overlay-title');
    const typeName = typesData.find(t => t.id === selectedType)?.name || selectedType;
    const ver = selectedType === 'custom' ? '' : ' ' + (versionSelect.value || '');
    title.textContent = `Setting up your ${typeName}${ver} server...`;
});

// ── Load server types ──
(async () => {
    try {
        const res = await fetch('/api/server-types');
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
        card.innerHTML = `
            <span class="material-icons-outlined mb-1" style="font-size: 2rem;">${t.icon}</span>
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
    } else {
        versionGroup.classList.remove('d-none');
        customUrlGroup.classList.add('d-none');
        versionSelect.setAttribute('required', '');
        await loadVersions(typeId);
    }
}

async function loadVersions(typeId) {
    versionSelect.innerHTML = '<option value="" disabled selected>Loading versions...</option>';
    try {
        const res = await fetch(`/api/versions?type=${encodeURIComponent(typeId)}`);
        const data = await res.json();

        versionSelect.innerHTML = '';
        if (data.versions && data.versions.length > 0) {
            data.versions.forEach((v, i) => {
                const opt = document.createElement('option');
                opt.value = v.id;
                opt.textContent = v.id;
                if (i === 0) opt.selected = true;
                versionSelect.appendChild(opt);
            });
        } else {
            versionSelect.innerHTML = '<option value="">No versions available</option>';
        }
    } catch {
        versionSelect.innerHTML = '<option value="">Failed to load versions</option>';
    }
}
