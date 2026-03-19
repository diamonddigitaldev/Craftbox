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
        showEditOverlay('Duplicating server...', 'Copying server files. This may take a moment.');
    });
})();

// ── Template form (direct submit when server is stopped) ──
(function () {
    var form = document.getElementById('template-form');
    if (!form || document.getElementById('template-running-btn')) return;
    form.addEventListener('submit', function () {
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

            try {
                const res = await fetch('/api/servers/' + serverId + '/update-jar', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf
                    }
                });
                const data = await res.json();

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
                showResult('danger', 'Failed to update jar.');
                btn.disabled = false;
                btn.innerHTML =
                    '<span class="material-icons-outlined" style="font-size: 1rem;">download</span> Update Jar';
            }
        });

        actionsDiv.appendChild(btn);
    }
})();
