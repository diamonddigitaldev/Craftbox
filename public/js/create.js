// Enable submit only when EULA is checked
const eulaCheck = document.getElementById('eula');
const createBtn = document.getElementById('create-btn');
eulaCheck.addEventListener('change', () => {
    createBtn.disabled = !eulaCheck.checked;
});

// Show progress overlay on form submit and disable button
const form = document.getElementById('create-server-form');
form.addEventListener('submit', () => {
    const overlay = document.getElementById('create-overlay');
    overlay.classList.remove('d-none');
    createBtn.disabled = true;
    createBtn.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status"></span> Creating...';

    // Set overlay title with version
    const version = document.getElementById('version');
    const title = document.getElementById('create-overlay-title');
    if (title && version && version.value) {
        title.textContent = 'Setting up your Vanilla ' + version.value + ' server...';
    }
});

// Fetch Minecraft versions
(async () => {
    const select = document.getElementById('version');
    try {
        const res = await fetch('/api/versions');
        const data = await res.json();
        select.innerHTML = '';
        if (data.versions && data.versions.length > 0) {
            data.versions.forEach((v, i) => {
                const opt = document.createElement('option');
                opt.value = v.id;
                opt.textContent = v.id;
                if (i === 0) opt.selected = true;
                select.appendChild(opt);
            });
        } else {
            select.innerHTML = '<option value="">No versions available</option>';
        }
    } catch {
        select.innerHTML = '<option value="">Failed to load versions</option>';
    }
})();
