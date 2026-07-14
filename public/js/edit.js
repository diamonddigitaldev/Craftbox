// Initialize Bootstrap tooltips
document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function (el) {
    new bootstrap.Tooltip(el);
});

function _formToBody(form) {
    var body = {};
    new FormData(form).forEach(function (v, k) {
        if (k === '_csrf') return;
        body[k] = v;
    });
    // Checkboxes are sent only when checked — explicitly record boolean state
    form.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        if (cb.name && cb.name !== '_csrf') body[cb.name] = cb.checked;
    });
    return body;
}

// ── Edit settings form ──
(function () {
    var form = document.getElementById('edit-server-form');
    if (!form) return;
    var serverId = form.dataset.serverId;
    var backupCheck = document.getElementById('saveBackup');
    var SAVE_BTN_HTML = '<span class="material-icons-outlined" style="font-size: 1.2rem;">save</span> Save Changes';

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        var btn = form.querySelector('button[type="submit"]');
        var wantBackup = !!(backupCheck && backupCheck.checked);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> ' +
                (wantBackup ? 'Backing up & saving...' : 'Saving...');
        }

        var body = _formToBody(form);
        body.backup = wantBackup;

        // With a backup, the save is a long background operation (stop → back up →
        // apply → restart): no blocking overlay, the state badge tracks it live.
        if (wantBackup) return saveWithRestorePoint(btn, body);

        showOverlay('Saving settings...', 'Please wait while your changes are applied.');
        var res = await apiFetch('/api/v1/servers/' + serverId + '/edit', { method: 'POST', body: body });
        hideOverlay();
        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save settings.', 'danger');
            if (btn) { btn.disabled = false; btn.innerHTML = SAVE_BTN_HTML; }
            return;
        }
        flashToast('Settings saved.', 'success');
        // Reload with ?saved=1 so the restart-modal auto-shows
        window.location.href = '/servers/' + serverId + '/edit?saved=1';
    });

    async function saveWithRestorePoint(btn, body) {
        showToast('Creating a backup, then saving your changes...', 'info');

        // Attach before the POST — the backend may finish first on a small server.
        var done = awaitOperation(serverId, 'settings-save');

        var res = await apiFetch('/api/v1/servers/' + serverId + '/edit', { method: 'POST', body: body });
        if (!res.ok) {
            done.cancel();
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save settings.', 'danger');
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
            flashToast('Backup created and settings saved.' +
                (payload.restarted ? ' Server restarted.' : ''), 'success');
        }
        window.location.href = '/servers/' + serverId + '/edit';
    }
})();

// Toggle handlers for auto-restart and auto-start switches
(function () {
    document.querySelectorAll('.toggle-switch').forEach(function (el) {
        el.addEventListener('change', async function () {
            const serverId = el.dataset.serverId;
            const endpoint = el.dataset.endpoint;
            const friendlyName = el.dataset.label || endpoint;
            var res = await apiFetch('/api/v1/servers/' + serverId + '/' + endpoint, {
                method: 'POST',
                body: { enabled: el.checked }
            });
            if (!res.ok) {
                el.checked = !el.checked;
                showToast('Failed to update ' + friendlyName + '.', 'danger');
                return;
            }
            showToast(friendlyName.charAt(0).toUpperCase() + friendlyName.slice(1) + ' ' + (el.checked ? 'enabled.' : 'disabled.'), 'success');
        });
    });
})();

// ── Version Upgrade ──
// Accept Risk applies the upgrade immediately via POST /upgrade-jar
// {version, backup?}: the server enters the upgrading_jar state (preceded by
// backing_up when a pre-upgrade backup was requested) and completion arrives
// over the WebSocket as operation "jar-upgrade" (dispatched as
// craftbox:operation).
(function () {
    var versionHidden = document.getElementById('version');
    var versionDisplay = document.getElementById('version-display');
    var browseBtn = document.getElementById('version-browse-btn');
    if (!versionHidden || !versionDisplay || !browseBtn) return;

    var form = document.getElementById('edit-server-form');
    var serverId = form ? form.dataset.serverId : null;
    var serverType = versionHidden.dataset.serverType;
    var currentVersion = versionHidden.dataset.currentVersion;
    var upgradeAccepted = false;

    var modalEl = document.getElementById('versionUpgradeModal');
    if (!modalEl) return;
    var modal = new bootstrap.Modal(modalEl);
    var revertBtn = document.getElementById('revert-version-btn');
    var acceptBtn = document.getElementById('accept-version-btn');

    function setVersionField(id) {
        versionHidden.value = id;
        versionDisplay.value = id;
    }

    // Only the current version and newer are offered (upgradeOnly); the
    // backend re-validates and rejects downgrades regardless.
    var picker = CraftboxVersionPicker({
        onSelect: function (v) {
            if (v.id === currentVersion) {
                setVersionField(currentVersion);
                upgradeAccepted = false;
                return;
            }
            setVersionField(v.id);
            document.getElementById('upgrade-from').textContent = currentVersion;
            document.getElementById('upgrade-to').textContent = v.id;
            // Pre-upgrade backup defaults to on for every new upgrade prompt
            var backupCheck = document.getElementById('upgradeBackup');
            if (backupCheck) backupCheck.checked = true;
            modal.show();
        }
    });

    function openPicker() {
        if (browseBtn.disabled) return;
        picker.open(serverType, {
            selectedVersion: versionHidden.value,
            upgradeOnly: true,
            currentVersion: currentVersion
        });
    }

    browseBtn.addEventListener('click', openPicker);
    versionDisplay.addEventListener('click', openPicker);

    function resetToCurrent() {
        setVersionField(currentVersion);
        upgradeAccepted = false;
        browseBtn.disabled = false;
    }

    function onUpgradeOperation(e) {
        var msg = e.detail || {};
        if (msg.serverId !== serverId || msg.operation !== 'jar-upgrade') return;
        document.removeEventListener('craftbox:operation', onUpgradeOperation);

        if (msg.status === 'failed') {
            showToast('Upgrade failed: ' + (msg.error || 'unknown error'), 'danger');
            resetToCurrent();
        } else {
            var version = (msg.payload && msg.payload.version) || versionHidden.value;
            // flashToast — the reload below would wipe a regular toast.
            flashToast('Server upgraded to ' + version + '.', 'success');
            window.location.reload();
        }
    }

    async function startUpgrade(newVersion, backupFirst) {
        browseBtn.disabled = true;
        showToast(backupFirst
            ? 'Backing up, then upgrading to version ' + newVersion + '...'
            : 'Upgrading to version ' + newVersion + '. Downloading the new server jar...', 'info');

        // Listen for completion before kicking off — the backend may finish
        // very quickly and broadcast before our listener attaches if we did
        // it after the POST.
        document.addEventListener('craftbox:operation', onUpgradeOperation);

        var res = await apiFetch('/api/v1/servers/' + serverId + '/upgrade-jar', {
            method: 'POST',
            body: { version: newVersion, backup: backupFirst }
        });
        if (!res.ok) {
            document.removeEventListener('craftbox:operation', onUpgradeOperation);
            showToast((res.data && res.data.error) || 'Failed to start the upgrade.', 'danger');
            resetToCurrent();
        }
        // 202 Accepted: the live state badge shows "Backing Up" and/or
        // "Upgrading Jar"; onUpgradeOperation handles completion.
    }

    revertBtn.addEventListener('click', function () {
        resetToCurrent();
        modal.hide();
    });

    acceptBtn.addEventListener('click', function () {
        upgradeAccepted = true;
        modal.hide();
        var backupCheck = document.getElementById('upgradeBackup');
        startUpgrade(versionHidden.value, !backupCheck || backupCheck.checked);
    });

    modalEl.addEventListener('hidden.bs.modal', function () {
        if (!upgradeAccepted && versionHidden.value !== currentVersion) {
            setVersionField(currentVersion);
        }
    });
})();

// ── Custom JAR URL Change ──
// Accept Risk replaces the jar immediately via POST /upgrade-jar
// {jarUrl, backup?} — the custom-server counterpart of the version upgrade
// flow: same upgrading_jar state and "jar-upgrade" completion operation.
(function () {
    var jarUrlInput = document.getElementById('customJarUrl');
    if (!jarUrlInput) return;

    var form = document.getElementById('edit-server-form');
    var serverId = form ? form.dataset.serverId : null;
    var currentUrl = jarUrlInput.dataset.currentUrl || '';
    var jarAccepted = false;

    var modalEl = document.getElementById('jarUrlChangeModal');
    if (!modalEl) return;
    var modal = new bootstrap.Modal(modalEl);
    var revertBtn = document.getElementById('revert-jar-url-btn');
    var acceptBtn = document.getElementById('accept-jar-url-btn');

    function resetToCurrent() {
        jarUrlInput.value = currentUrl;
        jarAccepted = false;
    }

    jarUrlInput.addEventListener('change', function () {
        var newUrl = jarUrlInput.value.trim();
        if (newUrl === currentUrl || newUrl === '') {
            jarAccepted = false;
            return;
        }
        // Pre-replace backup defaults to on for every new prompt
        var backupCheck = document.getElementById('jarUrlBackup');
        if (backupCheck) backupCheck.checked = true;
        modal.show();
    });

    function onReplaceOperation(e) {
        var msg = e.detail || {};
        if (msg.serverId !== serverId || msg.operation !== 'jar-upgrade') return;
        document.removeEventListener('craftbox:operation', onReplaceOperation);

        if (msg.status === 'failed') {
            showToast('Jar replacement failed: ' + (msg.error || 'unknown error'), 'danger');
            resetToCurrent();
        } else {
            // flashToast — the reload below would wipe a regular toast.
            flashToast('Server jar replaced.', 'success');
            window.location.reload();
        }
    }

    async function startReplace(newUrl, backupFirst) {
        showToast(backupFirst
            ? 'Backing up, then replacing the server jar...'
            : 'Replacing the server jar. Downloading from the new URL...', 'info');

        // Listen for completion before kicking off — the backend may finish
        // very quickly and broadcast before our listener attaches if we did
        // it after the POST.
        document.addEventListener('craftbox:operation', onReplaceOperation);

        var res = await apiFetch('/api/v1/servers/' + serverId + '/upgrade-jar', {
            method: 'POST',
            body: { jarUrl: newUrl, backup: backupFirst }
        });
        if (!res.ok) {
            document.removeEventListener('craftbox:operation', onReplaceOperation);
            showToast((res.data && res.data.error) || 'Failed to start the jar replacement.', 'danger');
            resetToCurrent();
        }
        // 202 Accepted: the live state badge shows "Backing Up" and/or
        // "Upgrading Jar"; onReplaceOperation handles completion.
    }

    revertBtn.addEventListener('click', function () {
        resetToCurrent();
        modal.hide();
    });

    acceptBtn.addEventListener('click', function () {
        jarAccepted = true;
        modal.hide();
        var backupCheck = document.getElementById('jarUrlBackup');
        startReplace(jarUrlInput.value.trim(), !backupCheck || backupCheck.checked);
    });

    modalEl.addEventListener('hidden.bs.modal', function () {
        if (!jarAccepted && jarUrlInput.value.trim() !== currentUrl) {
            resetToCurrent();
        }
    });
})();

// ── Status Page Visibility label ──
(function () {
    var toggle = document.getElementById('statusPagePublic');
    var label = document.getElementById('statusPageLabel');
    if (!toggle || !label) return;
    toggle.addEventListener('change', function () {
        label.textContent = toggle.checked ? 'Public' : 'Unlisted';
    });
})();

// ── Advertised IP save on button click ──
(function () {
    var input = document.getElementById('advertisedIp');
    var btn = document.getElementById('save-advertised-ip');
    if (!input || !btn) return;
    var serverId = btn.dataset.serverId;

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
    });

    btn.addEventListener('click', async function () {
        var value = input.value.trim();

        btn.disabled = true;
        input.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

        var res = await apiFetch('/api/v1/servers/' + serverId + '/advertisedip', {
            method: 'POST',
            body: { value: value }
        });
        btn.textContent = res.ok ? 'Saved!' : 'Error';
        if (res.ok) {
            showToast(value ? 'Advertised IP saved.' : 'Advertised IP cleared.', 'success');
        } else {
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save advertised IP.', 'danger');
        }
        setTimeout(function () {
            btn.textContent = 'Save';
            btn.disabled = false;
            input.disabled = false;
        }, 2000);
    });
})();

// ── Server Icon Upload, Drag-and-Drop, Delete & Reset ──
(function () {
    var dropZone = document.getElementById('icon-drop-zone');
    var fileInput = document.getElementById('icon-upload');
    var resetBtn = document.getElementById('icon-reset-btn');
    var deleteBtn = document.getElementById('icon-delete-btn');
    var preview = document.getElementById('icon-preview');
    var placeholder = document.getElementById('icon-placeholder');
    var statusEl = document.getElementById('icon-status');
    var dropArea = dropZone ? dropZone.querySelector('.icon-drop-area') : null;
    if (!dropZone || !fileInput) return;

    var serverId = dropZone.dataset.serverId;
    var hasIcon = false;

    function showRestartModal() {
        var modalEl = document.getElementById('restartModal');
        if (modalEl) {
            var state = modalEl.dataset.serverState;
            if (state !== 'stopped' && state !== 'crashed') {
                new bootstrap.Modal(modalEl).show();
            }
        }
    }

    function showIcon() {
        hasIcon = true;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
        deleteBtn.classList.remove('d-none');
        deleteBtn.classList.add('d-flex');
    }

    function showPlaceholder() {
        hasIcon = false;
        preview.style.display = 'none';
        placeholder.style.display = 'flex';
        deleteBtn.classList.add('d-none');
        deleteBtn.classList.remove('d-flex');
    }

    function showSpinner() {
        preview.style.display = 'none';
        placeholder.innerHTML =
            '<div class="spinner-border text-body-secondary" style="width: 2rem; height: 2rem; opacity: 0.5;"></div>';
        placeholder.style.display = 'flex';
        deleteBtn.classList.add('d-none');
        deleteBtn.classList.remove('d-flex');
        dropArea.style.pointerEvents = 'none';
    }

    function hideSpinner() {
        placeholder.innerHTML =
            '<span class="material-icons-outlined" style="font-size: 2.5rem; opacity: 0.35;">image</span>' +
            '<small style="font-size: 0.65rem; opacity: 0.5; margin-top: 2px;">Click or drop PNG</small>';
        dropArea.style.pointerEvents = '';
    }

    preview.addEventListener('load', showIcon);
    preview.addEventListener('error', showPlaceholder);
    if (preview.src) {
        var src = preview.src;
        preview.src = '';
        preview.src = src;
    }

    function showStatus(type, msg) {
        statusEl.className = 'mt-2 small text-' + type;
        statusEl.textContent = msg;
    }

    var uploading = false;
    // Named uploadIcon so it does not shadow the global uploadFile (dgup.js).
    async function uploadIcon(file) {
        if (!file || uploading) return;
        uploading = true;
        if (file.type !== 'image/png') {
            showStatus('danger', 'Only PNG files are allowed.');
            uploading = false;
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            showStatus('danger', 'Icon exceeds the 20 MB limit.');
            uploading = false;
            return;
        }

        showSpinner();
        resetBtn.disabled = true;
        showStatus('body-secondary', 'Uploading...');

        // Chunks icons over the threshold; small ones stay a single request.
        var res = await uploadFile('/api/v1/servers/' + serverId + '/icon', file, { fieldName: 'icon' });
        hideSpinner();
        if (res.ok && res.data && res.data.success) {
            showStatus('success', 'Icon updated. Restart the server for changes to take effect.');
            showToast('Icon updated.', 'success');
            preview.src = '/api/v1/servers/' + serverId + '/icon?t=' + Date.now();
            showRestartModal();
        } else {
            showStatus('danger', (res.data && res.data.error) || 'Upload failed.');
            showToast((res.data && res.data.error) || 'Failed to update icon.', 'danger');
            showPlaceholder();
        }
        resetBtn.disabled = false;
        uploading = false;
    }

    dropArea.addEventListener('click', function () {
        fileInput.click();
    });

    fileInput.addEventListener('change', function () {
        uploadIcon(fileInput.files[0]);
        fileInput.value = '';
    });

    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });

    dropArea.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (uploading) return;
        dropArea.style.borderColor = 'var(--craftbox-green)';
        dropArea.style.boxShadow = '0 0 0 2px rgba(76, 175, 80, 0.3)';
    });

    dropArea.addEventListener('dragleave', function () {
        if (uploading) return;
        dropArea.style.borderColor = '';
        dropArea.style.boxShadow = '';
    });

    dropArea.addEventListener('drop', function (e) {
        e.preventDefault();
        if (uploading) return;
        dropArea.style.borderColor = '';
        dropArea.style.boxShadow = '';
        var file = e.dataTransfer.files[0];
        if (file) uploadIcon(file);
    });

    deleteBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        deleteBtn.disabled = true;
        resetBtn.disabled = true;
        showStatus('body-secondary', 'Removing...');
        var res = await apiFetch('/api/v1/servers/' + serverId + '/icon', { method: 'DELETE' });
        if (res.ok && res.data && res.data.success) {
            showStatus('success', 'Icon removed. Restart the server for changes to take effect.');
            showToast('Icon removed.', 'success');
            showPlaceholder();
            showRestartModal();
        } else {
            showStatus('danger', (res.data && res.data.error) || 'Delete failed.');
            showToast((res.data && res.data.error) || 'Failed to remove icon.', 'danger');
        }
        deleteBtn.disabled = false;
        resetBtn.disabled = false;
    });

    if (resetBtn) {
        resetBtn.addEventListener('click', async function () {
            resetBtn.disabled = true;
            showStatus('body-secondary', 'Resetting...');
            var res = await apiFetch('/api/v1/servers/' + serverId + '/icon/reset', { method: 'POST', body: {} });
            if (res.ok && res.data && res.data.success) {
                showStatus('success', 'Icon reset to default. Restart the server for changes to take effect.');
                showToast('Icon reset to default.', 'success');
                preview.src = '/api/v1/servers/' + serverId + '/icon?t=' + Date.now();
                showRestartModal();
            } else {
                showStatus('danger', (res.data && res.data.error) || 'Reset failed.');
                showToast((res.data && res.data.error) || 'Failed to reset icon.', 'danger');
            }
            resetBtn.disabled = false;
        });
    }
})();

// ── Duplicate form ──
(function () {
    var form = document.getElementById('duplicate-form');
    if (!form) return;
    var serverId = form.dataset.serverId;

    async function submitDuplicate() {
        var btn = form.querySelector('button[type="submit"]') || document.getElementById('duplicate-running-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Duplicating...';
        }
        showOverlay('Duplicating server...', 'Copying server files. This may take a moment.');

        var res = await apiFetch('/api/v1/servers/' + serverId + '/duplicate', { method: 'POST', body: _formToBody(form) });
        if (!res.ok) {
            hideOverlay();
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to duplicate server.', 'danger');
            if (btn) { btn.disabled = false; btn.textContent = 'Duplicate'; }
            return;
        }
        flashToast('Server duplicated.', 'success');
        var newId = res.data && res.data.server && res.data.server.id;
        window.location.href = newId ? '/servers/' + newId : '/dashboard';
    }

    // Direct submit (server already stopped)
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        submitDuplicate();
    });

    // Stop-then-duplicate modal flow
    var dupRunningBtn = document.getElementById('duplicate-running-btn');
    if (dupRunningBtn) {
        var modal = new bootstrap.Modal(document.getElementById('stopDuplicateModal'));
        var confirmBtn = document.getElementById('confirm-stop-duplicate-btn');
        var startAfterCheckbox = document.getElementById('dupStartAfter');

        dupRunningBtn.addEventListener('click', function () {
            if (!form.reportValidity()) return;
            modal.show();
        });
        startAfterCheckbox.addEventListener('change', function () {
            document.getElementById('dup-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
        });
        confirmBtn.addEventListener('click', function () {
            document.getElementById('dup-stop-first').value = 'true';
            document.getElementById('dup-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
            modal.hide();
            submitDuplicate();
        });
    }
})();

// ── Template form ──
(function () {
    var form = document.getElementById('template-form');
    if (!form) return;

    async function submitTemplate() {
        var btn = form.querySelector('button[type="submit"]') || document.getElementById('template-running-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        }
        showOverlay('Saving template...', 'This may take a moment.');

        var res = await apiFetch('/api/v1/templates', { method: 'POST', body: _formToBody(form) });
        hideOverlay();
        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save template.', 'danger');
            if (btn) { btn.disabled = false; btn.textContent = 'Save as Template'; }
            return;
        }
        flashToast('Template saved.', 'success');
        window.location.href = '/templates';
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        submitTemplate();
    });

    var tmplRunningBtn = document.getElementById('template-running-btn');
    if (tmplRunningBtn) {
        var modal = new bootstrap.Modal(document.getElementById('stopTemplateModal'));
        var confirmBtn = document.getElementById('confirm-stop-template-btn');
        var startAfterCheckbox = document.getElementById('tmplStartAfter');

        tmplRunningBtn.addEventListener('click', function () {
            if (!form.reportValidity()) return;
            modal.show();
        });
        startAfterCheckbox.addEventListener('change', function () {
            document.getElementById('tmpl-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
        });
        confirmBtn.addEventListener('click', function () {
            document.getElementById('tmpl-stop-first').value = 'true';
            document.getElementById('tmpl-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
            modal.hide();
            submitTemplate();
        });
    }
})();

// ── Export / Transfer ──
(function () {
    var controls = document.getElementById('export-controls');
    if (!controls) return;
    var serverId = controls.dataset.serverId;
    var exportBtn = document.getElementById('export-btn');

    function exportUrl(startAfter) {
        var backups = document.getElementById('export-backups').checked ? 'true' : 'false';
        var events = document.getElementById('export-events').checked ? 'true' : 'false';
        var url = '/servers/' + serverId + '/export?backups=' + backups + '&events=' + events;
        if (startAfter) url += '&start=true';
        return url;
    }

    function startDownload(startAfter) {
        showToast('Export download starting...', 'info');
        window.location.href = exportUrl(startAfter);
    }

    async function stopThenExport() {
        var startAfter = document.getElementById('exportStartAfter')?.checked || false;
        showOverlay('Stopping server...', 'The export download will begin once the server has stopped.');
        var res = await apiFetch('/api/v1/servers/' + serverId + '/stop', { method: 'POST', body: {} });
        if (!res.ok) {
            hideOverlay();
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to stop server.', 'danger');
            return;
        }

        var deadline = Date.now() + 60000;
        (function poll() {
            setTimeout(async function () {
                var stateRes = await apiFetch('/api/v1/servers/' + serverId);
                var state = stateRes.ok && stateRes.data && stateRes.data.server && stateRes.data.server.state;
                if (state === 'stopped' || state === 'crashed') {
                    hideOverlay();
                    startDownload(startAfter);
                    return;
                }
                if (Date.now() > deadline) {
                    hideOverlay();
                    showToast('Server did not stop in time. Try exporting again once it has stopped.', 'danger');
                    return;
                }
                poll();
            }, 2000);
        })();
    }

    var stopExportModalEl = document.getElementById('stopExportModal');
    var confirmStopExportBtn = document.getElementById('confirm-stop-export-btn');
    confirmStopExportBtn?.addEventListener('click', function () {
        bootstrap.Modal.getInstance(stopExportModalEl)?.hide();
        stopThenExport();
    });
    stopExportModalEl?.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        confirmStopExportBtn?.click();
    });

    exportBtn.addEventListener('click', function () {
        if (exportBtn.dataset.serverStopped === 'true') {
            startDownload(false);
        } else {
            new bootstrap.Modal(stopExportModalEl).show();
        }
    });
})();

// ── Upgrade Checker ──
(function () {
    const checkBtn = document.getElementById('check-upgrade-btn');
    if (!checkBtn) return;

    const serverId = checkBtn.dataset.serverId;
    const resultDiv = document.getElementById('upgrade-result');
    const actionsDiv = document.getElementById('upgrade-actions');
    const statusEl = document.getElementById('upgrade-status');

    // Page-load resilience: if the server is mid-upgrade, show the overlay
    // and listen for completion (in case the user reloaded mid-operation).
    var navHeader = document.getElementById('server-nav-header');
    if (navHeader && navHeader.dataset.state === 'upgrading_jar') {
        showOverlay('Upgrading server jar...', 'Downloading the new jar. This may take a moment.');
        document.addEventListener('craftbox:operation', function reloadOnComplete(e) {
            var msg = e.detail || {};
            if (msg.serverId !== serverId || msg.operation !== 'jar-upgrade') return;
            document.removeEventListener('craftbox:operation', reloadOnComplete);
            hideOverlay();
            if (msg.status === 'failed') {
                showToast('Jar upgrade failed: ' + (msg.error || 'unknown error'), 'danger');
            } else {
                // flashToast — the reload below would wipe a regular toast.
                flashToast('Jar upgraded successfully.', 'success');
                window.location.reload();
            }
        });
    }

    checkBtn.addEventListener('click', async function () {
        checkBtn.disabled = true;
        checkBtn.innerHTML =
            '<span class="spinner-border spinner-border-sm" role="status"></span> Checking...';
        resultDiv.classList.add('d-none');

        try {
            const res = await fetch('/api/v1/servers/' + serverId + '/check-upgrade');
            const data = await res.json();

            if (!res.ok) {
                showResult('danger', data.error || 'Failed to check for upgrades.');
                return;
            }

            if (data.upgradeAvailable) {
                showResult('warning',
                    'Upgrade available: build #' + data.currentBuild + ' → #' + data.latestBuild);
                showUpgradeButton();
            } else if (data.reason) {
                showResult('secondary', data.reason);
            } else {
                showResult('success', 'Server jar is up to date.' +
                    (data.currentBuild ? ' (build #' + data.currentBuild + ')' : ''));
            }
        } catch {
            showResult('danger', 'Failed to check for upgrades.');
        } finally {
            checkBtn.disabled = false;
            checkBtn.innerHTML =
                '<span class="material-icons-outlined" style="font-size: 1rem;">refresh</span> Check for Upgrades';
        }
    });

    function showResult(type, message) {
        resultDiv.className = 'alert alert-' + type + ' py-2 px-3 mb-0 mt-2 small';
        resultDiv.textContent = message;
        resultDiv.classList.remove('d-none');
    }

    function showUpgradeButton() {
        if (document.getElementById('upgrade-jar-btn')) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'upgrade-jar-btn';
        btn.className = 'btn btn-warning btn-sm d-flex align-items-center gap-1';
        btn.innerHTML =
            '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Upgrade Jar';

        function onJarUpgradeOperation(e) {
            var msg = e.detail || {};
            if (msg.serverId !== serverId || msg.operation !== 'jar-upgrade') return;

            hideOverlay();
            document.removeEventListener('craftbox:operation', onJarUpgradeOperation);

            if (msg.status === 'complete') {
                var build = msg.payload && msg.payload.build;
                showResult('success', 'Jar upgraded to build #' + (build || 'latest') + '.');
                if (statusEl && build) {
                    statusEl.textContent = 'Current build: #' + build;
                }
                btn.remove();
            } else {
                showResult('danger', msg.error || 'Failed to upgrade jar.');
                btn.disabled = false;
                btn.innerHTML =
                    '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Upgrade Jar';
            }
        }

        btn.addEventListener('click', async function () {
            btn.disabled = true;
            btn.innerHTML =
                '<span class="spinner-border spinner-border-sm" role="status"></span> Upgrading...';
            showOverlay('Upgrading server jar...', 'Downloading the latest build. This may take a moment.');

            // Listen for completion before kicking off — the backend may finish
            // very quickly and broadcast before our listener attaches if we did
            // it after the POST.
            document.addEventListener('craftbox:operation', onJarUpgradeOperation);

            var res = await apiFetch('/api/v1/servers/' + serverId + '/upgrade-jar', { method: 'POST', body: {} });
            if (!res.ok) {
                hideOverlay();
                document.removeEventListener('craftbox:operation', onJarUpgradeOperation);
                showResult('danger', (res.data && res.data.error) || 'Failed to start jar upgrade.');
                btn.disabled = false;
                btn.innerHTML =
                    '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Upgrade Jar';
                return;
            }
            // 202 Accepted: keep overlay; onJarUpgradeOperation handles completion.
        });

        actionsDiv.appendChild(btn);
    }
})();
