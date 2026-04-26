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
    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        var btn = form.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        }
        showOverlay('Saving settings...', 'Please wait while your changes are applied.');

        var res = await apiFetch('/api/v1/servers/' + serverId + '/edit', { method: 'POST', body: _formToBody(form) });
        hideOverlay();
        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save settings.', 'danger');
            if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
            return;
        }
        // Reload with ?saved=1 so the restart-modal auto-shows
        window.location.href = '/servers/' + serverId + '/edit?saved=1';
    });
})();

// Toggle handlers for auto-restart and auto-start switches
(function () {
    document.querySelectorAll('.toggle-switch').forEach(function (el) {
        el.addEventListener('change', async function () {
            const serverId = el.dataset.serverId;
            const endpoint = el.dataset.endpoint;
            var res = await apiFetch('/api/v1/servers/' + serverId + '/' + endpoint, {
                method: 'POST',
                body: { enabled: el.checked }
            });
            if (!res.ok) el.checked = !el.checked;
        });
    });
})();

// ── Version Upgrade ──
(function () {
    var versionSelect = document.getElementById('version');
    if (!versionSelect) return;

    var serverType = versionSelect.dataset.serverType;
    var currentVersion = versionSelect.dataset.currentVersion;
    var upgradeAccepted = false;

    function compareVersions(a, b) {
        var aParts = a.split('.').map(Number);
        var bParts = b.split('.').map(Number);
        for (var i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            var diff = (aParts[i] || 0) - (bParts[i] || 0);
            if (diff !== 0) return diff > 0 ? 1 : -1;
        }
        return 0;
    }

    async function loadUpgradeVersions() {
        try {
            var res = await fetch('/api/v1/versions?type=' + encodeURIComponent(serverType));
            var data = await res.json();
            if (!data.versions || data.versions.length === 0) return;

            versionSelect.innerHTML = '';
            data.versions.forEach(function (v) {
                if (compareVersions(v.id, currentVersion) >= 0) {
                    var opt = document.createElement('option');
                    opt.value = v.id;
                    opt.textContent = v.id;
                    if (v.id === currentVersion) opt.selected = true;
                    versionSelect.appendChild(opt);
                }
            });
        } catch {
            // Keep the current version if loading fails
        }
    }

    loadUpgradeVersions();

    var modalEl = document.getElementById('versionUpgradeModal');
    if (!modalEl) return;
    var modal = new bootstrap.Modal(modalEl);
    var revertBtn = document.getElementById('revert-version-btn');
    var acceptBtn = document.getElementById('accept-version-btn');

    versionSelect.addEventListener('change', function () {
        if (versionSelect.value === currentVersion) {
            upgradeAccepted = false;
            return;
        }
        document.getElementById('upgrade-from').textContent = currentVersion;
        document.getElementById('upgrade-to').textContent = versionSelect.value;
        modal.show();
    });

    revertBtn.addEventListener('click', function () {
        versionSelect.value = currentVersion;
        upgradeAccepted = false;
        modal.hide();
    });

    acceptBtn.addEventListener('click', function () {
        upgradeAccepted = true;
        modal.hide();
    });

    modalEl.addEventListener('hidden.bs.modal', function () {
        if (!upgradeAccepted && versionSelect.value !== currentVersion) {
            versionSelect.value = currentVersion;
        }
    });
})();

// ── Custom JAR URL Change ──
(function () {
    var jarUrlInput = document.getElementById('customJarUrl');
    if (!jarUrlInput) return;

    var currentUrl = jarUrlInput.dataset.currentUrl || '';
    var jarAccepted = false;

    var modalEl = document.getElementById('jarUrlChangeModal');
    if (!modalEl) return;
    var modal = new bootstrap.Modal(modalEl);
    var revertBtn = document.getElementById('revert-jar-url-btn');
    var acceptBtn = document.getElementById('accept-jar-url-btn');

    jarUrlInput.addEventListener('change', function () {
        var newUrl = jarUrlInput.value.trim();
        if (newUrl === currentUrl || newUrl === '') {
            jarAccepted = false;
            return;
        }
        modal.show();
    });

    revertBtn.addEventListener('click', function () {
        jarUrlInput.value = currentUrl;
        jarAccepted = false;
        modal.hide();
    });

    acceptBtn.addEventListener('click', function () {
        jarAccepted = true;
        modal.hide();
    });

    modalEl.addEventListener('hidden.bs.modal', function () {
        if (!jarAccepted && jarUrlInput.value.trim() !== currentUrl) {
            jarUrlInput.value = currentUrl;
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
    async function uploadFile(file) {
        if (!file || uploading) return;
        uploading = true;
        if (file.type !== 'image/png') {
            showStatus('danger', 'Only PNG files are allowed.');
            uploading = false;
            return;
        }

        var formData = new FormData();
        formData.append('icon', file);

        showSpinner();
        resetBtn.disabled = true;
        showStatus('body-secondary', 'Uploading...');

        var res = await apiFetch('/api/v1/servers/' + serverId + '/icon', { method: 'POST', body: formData });
        hideSpinner();
        if (res.ok && res.data && res.data.success) {
            showStatus('success', 'Icon updated. Restart the server for changes to take effect.');
            preview.src = '/api/v1/servers/' + serverId + '/icon?t=' + Date.now();
            showRestartModal();
        } else {
            showStatus('danger', (res.data && res.data.error) || 'Upload failed.');
            showPlaceholder();
        }
        resetBtn.disabled = false;
        uploading = false;
    }

    dropArea.addEventListener('click', function () {
        fileInput.click();
    });

    fileInput.addEventListener('change', function () {
        uploadFile(fileInput.files[0]);
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
        if (file) uploadFile(file);
    });

    deleteBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        deleteBtn.disabled = true;
        resetBtn.disabled = true;
        showStatus('body-secondary', 'Removing...');
        var res = await apiFetch('/api/v1/servers/' + serverId + '/icon', { method: 'DELETE' });
        if (res.ok && res.data && res.data.success) {
            showStatus('success', 'Icon removed. Restart the server for changes to take effect.');
            showPlaceholder();
            showRestartModal();
        } else {
            showStatus('danger', (res.data && res.data.error) || 'Delete failed.');
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
                preview.src = '/api/v1/servers/' + serverId + '/icon?t=' + Date.now();
                showRestartModal();
            } else {
                showStatus('danger', (res.data && res.data.error) || 'Reset failed.');
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

// ── Update Checker ──
(function () {
    const checkBtn = document.getElementById('check-update-btn');
    if (!checkBtn) return;

    const serverId = checkBtn.dataset.serverId;
    const resultDiv = document.getElementById('update-result');
    const actionsDiv = document.getElementById('update-actions');
    const statusEl = document.getElementById('update-status');

    checkBtn.addEventListener('click', async function () {
        checkBtn.disabled = true;
        checkBtn.innerHTML =
            '<span class="spinner-border spinner-border-sm" role="status"></span> Checking...';
        resultDiv.classList.add('d-none');

        try {
            const res = await fetch('/api/v1/servers/' + serverId + '/check-update');
            const data = await res.json();

            if (!res.ok) {
                showResult('danger', data.error || 'Failed to check for updates.');
                return;
            }

            if (data.updateAvailable) {
                showResult('warning',
                    'Update available: build #' + data.currentBuild + ' → #' + data.latestBuild);
                showUpdateButton();
            } else if (data.reason) {
                showResult('secondary', data.reason);
            } else {
                showResult('success', 'Server jar is up to date.' +
                    (data.currentBuild ? ' (build #' + data.currentBuild + ')' : ''));
            }
        } catch {
            showResult('danger', 'Failed to check for updates.');
        } finally {
            checkBtn.disabled = false;
            checkBtn.innerHTML =
                '<span class="material-icons-outlined" style="font-size: 1rem;">refresh</span> Check for Updates';
        }
    });

    function showResult(type, message) {
        resultDiv.className = 'alert alert-' + type + ' py-2 px-3 mb-0 mt-2 small';
        resultDiv.textContent = message;
        resultDiv.classList.remove('d-none');
    }

    function showUpdateButton() {
        if (document.getElementById('update-jar-btn')) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'update-jar-btn';
        btn.className = 'btn btn-warning btn-sm d-flex align-items-center gap-1';
        btn.innerHTML =
            '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Update Jar';

        btn.addEventListener('click', async function () {
            btn.disabled = true;
            btn.innerHTML =
                '<span class="spinner-border spinner-border-sm" role="status"></span> Updating...';
            showOverlay('Updating server jar...', 'Downloading the latest build. This may take a moment.');

            var res = await apiFetch('/api/v1/servers/' + serverId + '/update-jar', { method: 'POST', body: {} });
            hideOverlay();
            if (res.ok && res.data && res.data.success) {
                showResult('success', 'Jar updated to build #' + (res.data.build || 'latest') + '.');
                if (statusEl && res.data.build) {
                    statusEl.textContent = 'Current build: #' + res.data.build;
                }
                btn.remove();
            } else {
                showResult('danger', (res.data && res.data.error) || 'Failed to update jar.');
                btn.disabled = false;
                btn.innerHTML =
                    '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Update Jar';
            }
        });

        actionsDiv.appendChild(btn);
    }
})();
