// Backups page JavaScript
(function () {
    var serverId = window.location.pathname.split('/')[2];

    // ── Page-load resilience: if state is backing_up or restoring, show the
    // overlay so a user reloading mid-operation sees the right thing.
    var navHeader = document.getElementById('server-nav-header');
    var initialState = navHeader ? navHeader.dataset.state : '';
    if (initialState === 'backing_up') {
        showOverlay('Creating backup...', 'Compressing server files. This may take a moment.');
    } else if (initialState === 'restoring') {
        showOverlay('Restoring backup...', 'Extracting backup files. This may take a moment.');
    }

    // ── Async operation completion via WebSocket ──
    // serverState.js maintains the WebSocket subscription on this page and
    // dispatches `craftbox:operation` events for backup/restore/jar-update
    // outcomes. We listen here to drive the overlay + toasts after firing
    // long operations.
    function handleOperation(e) {
        var msg = e.detail || {};
        if (msg.serverId !== serverId) return;

        if (msg.operation === 'backup') {
            if (msg.status === 'complete') {
                hideOverlay();
                var warning = msg.payload && msg.payload.warning;
                // flashToast (not showToast) — the immediate reload below
                // would wipe a regular toast before it became visible.
                if (warning) {
                    flashToast(warning, 'warning');
                } else {
                    flashToast('Backup created successfully.', 'success');
                }
                window.location.reload();
            } else if (msg.status === 'failed') {
                hideOverlay();
                showToast('Backup failed: ' + (msg.error || 'unknown error'), 'danger');
                resetBackupButton();
            }
        } else if (msg.operation === 'restore') {
            if (msg.status === 'complete') {
                hideOverlay();
                var rWarning = msg.payload && msg.payload.warning;
                if (rWarning) {
                    flashToast(rWarning, 'warning');
                } else {
                    flashToast('Backup restored successfully.', 'success');
                }
                window.location.reload();
            } else if (msg.status === 'failed') {
                hideOverlay();
                showToast('Restore failed: ' + (msg.error || 'unknown error'), 'danger');
                resetRestoreButton();
            }
        }
    }
    document.addEventListener('craftbox:operation', handleOperation);

    function resetBackupButton() {
        var btn = document.getElementById('confirm-backup-btn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = needsStop ? 'Stop & Backup' : 'Create Backup';
        }
    }
    function resetRestoreButton() {
        var btn = document.getElementById('confirm-restore-btn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Restore';
        }
    }

    // ── Create Backup Modal ──
    var createBackupModal = new bootstrap.Modal(document.getElementById('createBackupModal'));
    var createBackupBtn = document.getElementById('create-backup-btn');
    var backupForm = document.getElementById('backup-form');
    var backupNameInput = document.getElementById('backupName');
    var backupStartAfterInput = document.getElementById('backupStartAfter');
    var startAfterBackupCheckbox = document.getElementById('startAfterBackup');
    var stopFirstInput = document.getElementById('backupStopFirst');
    var needsStop = stopFirstInput && stopFirstInput.value === 'true';

    if (createBackupBtn) {
        createBackupBtn.addEventListener('click', function () {
            if (backupNameInput) backupNameInput.value = '';
            createBackupModal.show();
        });
    }

    // Focus the name field once the modal has fully opened (after Bootstrap's own focus logic).
    var createBackupModalEl = document.getElementById('createBackupModal');
    if (createBackupModalEl && backupNameInput) {
        createBackupModalEl.addEventListener('shown.bs.modal', function () {
            backupNameInput.focus();
        });
    }

    if (startAfterBackupCheckbox && backupStartAfterInput) {
        startAfterBackupCheckbox.addEventListener('change', function () {
            backupStartAfterInput.value = startAfterBackupCheckbox.checked ? 'true' : 'false';
        });
    }

    if (backupForm) {
        backupForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!backupForm.reportValidity()) return;

            var btn = document.getElementById('confirm-backup-btn');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Creating...';
            }
            createBackupModal.hide();
            var overlayTitle = needsStop ? 'Stopping server & creating backup...' : 'Creating backup...';
            showOverlay(overlayTitle, 'Compressing server files. This may take a moment.');

            var name = backupNameInput ? backupNameInput.value.trim() : 'Manual Backup';
            var res = await apiFetch('/api/v1/servers/' + serverId + '/backups', {
                method: 'POST',
                body: {
                    name: name || 'Manual Backup',
                    stopFirst: stopFirstInput ? stopFirstInput.value : 'false',
                    startAfter: backupStartAfterInput ? backupStartAfterInput.value : 'false'
                }
            });
            if (!res.ok) {
                hideOverlay();
                showToast((res.data && (res.data.message || res.data.error)) || 'Backup failed.', 'danger');
                resetBackupButton();
                return;
            }
            // 202 Accepted: keep the overlay up; completion arrives via the
            // craftbox:operation listener at the top of this file.
        });
    }

    // ── Restore Modal ──
    var restoreModal = new bootstrap.Modal(document.getElementById('restoreModal'));
    var restoreForm = document.getElementById('restore-form');
    var startAfterCheckbox = document.getElementById('startAfterRestore');
    var startAfterInput = document.getElementById('startAfterInput');
    var pendingRestoreId = null;

    document.querySelectorAll('.restore-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            pendingRestoreId = btn.dataset.backupId;
            if (startAfterCheckbox) startAfterCheckbox.checked = true;
            if (startAfterInput) startAfterInput.value = 'true';
            restoreModal.show();
        });
    });

    if (startAfterCheckbox) {
        startAfterCheckbox.addEventListener('change', function () {
            if (startAfterInput) startAfterInput.value = startAfterCheckbox.checked ? 'true' : 'false';
        });
    }

    if (restoreForm) {
        restoreForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!pendingRestoreId) return;
            var confirmRestoreBtn = document.getElementById('confirm-restore-btn');
            if (confirmRestoreBtn) {
                confirmRestoreBtn.disabled = true;
                confirmRestoreBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Restoring...';
            }
            restoreModal.hide();
            showOverlay('Restoring backup...', 'Extracting backup files. This may take a moment.');

            var res = await apiFetch('/api/v1/servers/' + serverId + '/backups/' + pendingRestoreId + '/restore', {
                method: 'POST',
                body: {
                    startAfter: startAfterInput ? startAfterInput.value : 'true'
                }
            });
            if (!res.ok) {
                hideOverlay();
                showToast((res.data && (res.data.message || res.data.error)) || 'Restore failed.', 'danger');
                resetRestoreButton();
                return;
            }
            // 202 Accepted: keep the overlay up; completion arrives via the
            // craftbox:operation listener at the top of this file.
        });
    }

    // ── Delete Modal ──
    var deleteModal = new bootstrap.Modal(document.getElementById('deleteBackupModal'));
    var deleteForm = document.getElementById('delete-form');
    var deleteNameSpan = document.getElementById('delete-backup-name');
    var pendingDeleteId = null;

    document.querySelectorAll('.delete-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            pendingDeleteId = btn.dataset.backupId;
            if (deleteNameSpan) deleteNameSpan.textContent = btn.dataset.backupName || '';
            deleteModal.show();
        });
    });

    if (deleteForm) {
        deleteForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!pendingDeleteId) return;
            var btn = deleteForm.querySelector('button[type="submit"]');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';
            }
            deleteModal.hide();
            showOverlay('Deleting backup...', 'Please wait while the backup is removed.');

            var res = await apiFetch('/api/v1/servers/' + serverId + '/backups/' + pendingDeleteId, {
                method: 'DELETE'
            });
            if (!res.ok) {
                hideOverlay();
                showToast((res.data && (res.data.message || res.data.error)) || 'Delete failed.', 'danger');
                if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
                return;
            }
            flashToast('Backup deleted.', 'success');
            window.location.reload();
        });
    }

    // ── Next Backup Display Helper ──
    var nextBackupText = document.getElementById('next-backup-text');

    function updateNextBackup(isoString) {
        if (!nextBackupText) return;
        if (isoString) {
            nextBackupText.innerHTML = 'Next backup: <span class="format-date">' + formatDate(isoString) + '</span>';
        } else {
            nextBackupText.textContent = '';
        }
    }

    // ── Schedule Toggle ──
    var scheduleToggle = document.getElementById('scheduleEnabled');
    var scheduleSettings = document.getElementById('schedule-settings');

    if (scheduleToggle) {
        scheduleToggle.addEventListener('change', async function () {
            var enabled = scheduleToggle.checked;
            if (scheduleSettings) scheduleSettings.classList.toggle('d-none', !enabled);

            var res = await apiFetch('/api/v1/servers/' + serverId + '/backup-schedule', {
                method: 'POST',
                body: { enabled: enabled }
            });
            if (res.ok) {
                updateNextBackup(res.data && res.data.nextBackupAt);
                showToast('Scheduled backups ' + (enabled ? 'enabled.' : 'disabled.'), 'success');
            } else {
                scheduleToggle.checked = !enabled;
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to update schedule.', 'danger');
            }
        });
    }

    // ── Save Schedule ──
    var saveScheduleBtn = document.getElementById('save-schedule-btn');
    if (saveScheduleBtn) {
        saveScheduleBtn.addEventListener('click', async function () {
            var intervalHours = parseInt(document.getElementById('intervalHours').value, 10);
            var countdownMinutes = parseInt(document.getElementById('countdownMinutes').value, 10);

            saveScheduleBtn.disabled = true;
            saveScheduleBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';

            var res = await apiFetch('/api/v1/servers/' + serverId + '/backup-schedule', {
                method: 'POST',
                body: {
                    enabled: scheduleToggle ? scheduleToggle.checked : false,
                    intervalHours: intervalHours,
                    countdownMinutes: countdownMinutes
                }
            });

            if (res.ok) {
                updateNextBackup(res.data && res.data.nextBackupAt);
                saveScheduleBtn.textContent = 'Saved!';
                showToast('Backup schedule saved.', 'success');
            } else {
                saveScheduleBtn.textContent = 'Error';
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save schedule.', 'danger');
            }
            setTimeout(function () {
                saveScheduleBtn.textContent = 'Save Schedule';
                saveScheduleBtn.disabled = false;
            }, 2000);
        });
    }

    // ── Save Retention ──
    var saveRetentionBtn = document.getElementById('save-retention-btn');
    if (saveRetentionBtn) {
        saveRetentionBtn.addEventListener('click', async function () {
            var retentionCount = parseInt(document.getElementById('retentionCount').value, 10);
            var retentionDays = parseInt(document.getElementById('retentionDays').value, 10);

            saveRetentionBtn.disabled = true;
            saveRetentionBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';

            var res = await apiFetch('/api/v1/servers/' + serverId + '/backup-retention', {
                method: 'POST',
                body: { retentionCount: retentionCount, retentionDays: retentionDays }
            });

            if (res.ok) {
                saveRetentionBtn.textContent = 'Saved!';
                showToast('Backup retention saved.', 'success');
            } else {
                saveRetentionBtn.textContent = 'Error';
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save retention.', 'danger');
            }
            setTimeout(function () {
                saveRetentionBtn.textContent = 'Save Retention';
                saveRetentionBtn.disabled = false;
            }, 2000);
        });
    }
})();
