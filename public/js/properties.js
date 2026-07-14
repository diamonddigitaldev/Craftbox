// Save properties via /api/v1/servers/:id/properties
(function () {
    var form = document.getElementById('properties-form');
    if (!form) return;
    var serverId = form.dataset.serverId;
    var backupCheck = document.getElementById('saveBackup');
    var SAVE_BTN_HTML = '<span class="material-icons-outlined" style="font-size: 1.2rem;">save</span> Save Properties';

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = form.querySelector('button[type="submit"]');
        var wantBackup = !!(backupCheck && backupCheck.checked);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> ' +
                (wantBackup ? 'Backing up & saving...' : 'Saving...');
        }

        // Build a body including boolean checkbox state (unchecked boxes are absent from FormData)
        var body = {};
        new FormData(form).forEach(function (v, k) {
            if (k === '_csrf') return;
            body[k] = v;
        });
        form.querySelectorAll('input[type="checkbox"].prop-toggle').forEach(function (cb) {
            if (cb.name) body[cb.name] = cb.checked ? 'true' : 'false';
        });
        // The backup toggle carries no name, so it never lands in the property map
        body.backup = wantBackup;

        // With a backup, the save is a long background operation (stop → back up →
        // apply → restart): no blocking overlay, the state badge tracks it live.
        if (wantBackup) return saveWithRestorePoint(btn, body);

        showOverlay('Saving properties...', 'Please wait while your changes are applied.');
        var res = await apiFetch('/api/v1/servers/' + serverId + '/properties', { method: 'POST', body: body });
        hideOverlay();
        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save properties.', 'danger');
            if (btn) { btn.disabled = false; btn.innerHTML = SAVE_BTN_HTML; }
            return;
        }
        flashToast('Properties saved.', 'success');
        window.location.href = '/servers/' + serverId + '/properties?saved=1';
    });

    async function saveWithRestorePoint(btn, body) {
        showToast('Creating a backup, then saving your properties...', 'info');

        // Attach before the POST — the backend may finish first on a small server.
        var done = awaitOperation(serverId, 'settings-save');

        var res = await apiFetch('/api/v1/servers/' + serverId + '/properties', { method: 'POST', body: body });
        if (!res.ok) {
            done.cancel();
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save properties.', 'danger');
            if (btn) { btn.disabled = false; btn.innerHTML = SAVE_BTN_HTML; }
            return;
        }

        var msg = await done;
        if (msg.status === 'failed') {
            showToast('Save failed: ' + (msg.error || 'unknown error'), 'danger');
            if (btn) { btn.disabled = false; btn.innerHTML = SAVE_BTN_HTML; }
            return;
        }
        // The server was already restarted (if it had been running), so there is
        // nothing left for the restart modal to offer — reload without ?saved=1.
        var payload = msg.payload || {};
        if (payload.warning) {
            flashToast(payload.warning, 'warning');
        } else {
            flashToast('Backup created and properties saved.' +
                (payload.restarted ? ' Server restarted.' : ''), 'success');
        }
        window.location.href = '/servers/' + serverId + '/properties';
    }
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
