// Show overlay on save
(function () {
    var form = document.querySelector('form[action$="/edit"]');
    if (!form) return;
    form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        }
        showOverlay('Saving settings...', 'Please wait while your changes are applied.');
    });
})();

// Toggle handlers for auto-restart and auto-start switches
(function () {
    document.querySelectorAll('.toggle-switch').forEach(function (el) {
        el.addEventListener('change', async function () {
            const serverId = el.dataset.serverId;
            const csrf = el.dataset.csrf;
            const endpoint = el.dataset.endpoint;
            try {
                const res = await fetch('/api/servers/' + serverId + '/' + endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf
                    },
                    body: JSON.stringify({ enabled: el.checked })
                });
                if (!res.ok) el.checked = !el.checked;
            } catch {
                el.checked = !el.checked;
            }
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

    // Compare two version strings numerically (returns -1, 0, or 1)
    function compareVersions(a, b) {
        var aParts = a.split('.').map(Number);
        var bParts = b.split('.').map(Number);
        for (var i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            var diff = (aParts[i] || 0) - (bParts[i] || 0);
            if (diff !== 0) return diff > 0 ? 1 : -1;
        }
        return 0;
    }

    // Load versions from API and populate dropdown (only >= current)
    async function loadUpgradeVersions() {
        try {
            var res = await fetch('/api/versions?type=' + encodeURIComponent(serverType));
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

    // Show warning modal when version changes
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
        // Show the warning modal
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

    // If modal is dismissed (backdrop click, escape), revert
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

    // If modal is dismissed (backdrop click, escape), revert
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

// ── Overlay helper ──
function showEditOverlay(title, desc) {
    showOverlay(title, desc);
}

// ── Duplicate form (direct submit when server is stopped) ──
(function () {
    var form = document.getElementById('duplicate-form');
    // Only wire direct submit if there's no "running" button (server is stopped)
    if (!form || document.getElementById('duplicate-running-btn')) return;
    form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Duplicating...';
        }
        showEditOverlay('Duplicating server...', 'Copying server files. This may take a moment.');
    });
})();

// ── Template form (direct submit when server is stopped) ──
(function () {
    var form = document.getElementById('template-form');
    if (!form || document.getElementById('template-running-btn')) return;
    form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        }
        showEditOverlay('Saving template...', 'This may take a moment.');
    });
})();

// ── Stop & Duplicate Modal ──
(function () {
    var btn = document.getElementById('duplicate-running-btn');
    if (!btn) return;

    var modal = new bootstrap.Modal(document.getElementById('stopDuplicateModal'));
    var confirmBtn = document.getElementById('confirm-stop-duplicate-btn');
    var startAfterCheckbox = document.getElementById('dupStartAfter');
    var form = document.getElementById('duplicate-form');

    btn.addEventListener('click', function () { modal.show(); });

    startAfterCheckbox.addEventListener('change', function () {
        document.getElementById('dup-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
    });

    confirmBtn.addEventListener('click', function () {
        document.getElementById('dup-stop-first').value = 'true';
        document.getElementById('dup-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Stopping...';
        modal.hide();
        showEditOverlay('Stopping server & duplicating...', 'Copying server files. This may take a moment.');
        form.submit();
    });
})();

// ── Stop & Save Template Modal ──
(function () {
    var btn = document.getElementById('template-running-btn');
    if (!btn) return;

    var modal = new bootstrap.Modal(document.getElementById('stopTemplateModal'));
    var confirmBtn = document.getElementById('confirm-stop-template-btn');
    var startAfterCheckbox = document.getElementById('tmplStartAfter');
    var form = document.getElementById('template-form');

    btn.addEventListener('click', function () { modal.show(); });

    startAfterCheckbox.addEventListener('change', function () {
        document.getElementById('tmpl-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
    });

    confirmBtn.addEventListener('click', function () {
        document.getElementById('tmpl-stop-first').value = 'true';
        document.getElementById('tmpl-start-after').value = startAfterCheckbox.checked ? 'true' : 'false';
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Stopping...';
        modal.hide();
        showEditOverlay('Stopping server & saving template...', 'This may take a moment.');
        form.submit();
    });
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
            const res = await fetch('/api/servers/' + serverId + '/check-update');
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
        // Only add if not already present
        if (document.getElementById('update-jar-btn')) return;

        const csrf = document.querySelector('[name="_csrf"]')?.value;
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

            try {
                const res = await fetch('/api/servers/' + serverId + '/update-jar', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf
                    }
                });
                const data = await res.json();

                hideOverlay();
                if (res.ok && data.success) {
                    showResult('success', 'Jar updated to build #' + (data.build || 'latest') + '.');
                    if (statusEl && data.build) {
                        statusEl.textContent = 'Current build: #' + data.build;
                    }
                    btn.remove();
                } else {
                    showResult('danger', data.error || 'Failed to update jar.');
                    btn.disabled = false;
                    btn.innerHTML =
                        '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Update Jar';
                }
            } catch {
                hideOverlay();
                showResult('danger', 'Failed to update jar.');
                btn.disabled = false;
                btn.innerHTML =
                    '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Update Jar';
            }
        });

        actionsDiv.appendChild(btn);
    }
})();
