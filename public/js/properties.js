// Save properties via /api/v1/servers/:id/properties
(function () {
    var form = document.getElementById('properties-form');
    if (!form) return;
    var serverId = form.dataset.serverId;

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = form.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        }
        showOverlay('Saving properties...', 'Please wait while your changes are applied.');

        // Build a body including boolean checkbox state (unchecked boxes are absent from FormData)
        var body = {};
        new FormData(form).forEach(function (v, k) {
            if (k === '_csrf') return;
            body[k] = v;
        });
        form.querySelectorAll('input[type="checkbox"].prop-toggle').forEach(function (cb) {
            if (cb.name) body[cb.name] = cb.checked ? 'true' : 'false';
        });

        var res = await apiFetch('/api/v1/servers/' + serverId + '/properties', { method: 'POST', body: body });
        hideOverlay();
        if (!res.ok) {
            alert((res.data && (res.data.message || res.data.error)) || 'Failed to save properties.');
            if (btn) { btn.disabled = false; btn.textContent = 'Save Properties'; }
            return;
        }
        window.location.href = '/servers/' + serverId + '/properties?saved=1';
    });
})();

// Update Enabled/Disabled label text when boolean toggles are changed
(function () {
    document.querySelectorAll('.prop-toggle').forEach(function (input) {
        input.addEventListener('change', function () {
            var label = input.parentElement.querySelector('.prop-toggle-label');
            if (label) {
                label.textContent = input.checked ? 'Enabled' : 'Disabled';
            }
        });
    });
})();
