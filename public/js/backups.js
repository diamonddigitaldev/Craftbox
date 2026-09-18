// Backups page JavaScript
(function () {
    var serverId = window.location.pathname.split('/')[2];

    // ── Listing ──
    // The rows are rendered by the view on first load and by buildRow below
    // whenever a backup lands or leaves, from the same listing the API returns.
    // Keep the two in step with views/servers/backups.ejs.

    var tbody = document.getElementById('backups-tbody');
    var tableWrap = document.getElementById('backups-table');
    var emptyState = document.getElementById('backups-empty');
    var countEl = document.getElementById('backup-count');

    // A 32px square icon button/link, as the view lays them out.
    function squareControl(tag, classes, iconName, title) {
        var el = document.createElement(tag);
        el.className = classes + ' btn-sm d-inline-flex align-items-center justify-content-center';
        el.style.cssText = 'width: 32px; height: 32px; padding: 0;';
        el.title = title;
        if (tag === 'button') el.type = 'button';
        var icon = document.createElement('span');
        icon.className = 'material-icons-outlined';
        icon.style.fontSize = '1rem';
        icon.textContent = iconName;
        el.appendChild(icon);
        return el;
    }

    function buildRow(backup) {
        var scheduled = backup.type === 'scheduled';
        var tr = document.createElement('tr');
        tr.dataset.backupId = backup.id;

        var iconTd = document.createElement('td');
        iconTd.className = 'text-center';
        var icon = document.createElement('span');
        icon.className = 'material-icons-outlined text-body-secondary align-middle';
        icon.style.fontSize = '1.2rem';
        icon.textContent = scheduled ? 'schedule' : 'backup';
        iconTd.appendChild(icon);
        tr.appendChild(iconTd);

        var nameTd = document.createElement('td');
        nameTd.textContent = backup.name;
        tr.appendChild(nameTd);

        var sizeTd = document.createElement('td');
        sizeTd.className = 'text-body-secondary small';
        sizeTd.textContent = backup.sizeFormatted;
        tr.appendChild(sizeTd);

        var dateTd = document.createElement('td');
        dateTd.className = 'text-body-secondary small';
        var date = document.createElement('span');
        date.className = 'format-date';
        date.dataset.iso = backup.createdAt;
        date.textContent = formatDate(backup.createdAt);
        dateTd.appendChild(date);
        tr.appendChild(dateTd);

        var typeTd = document.createElement('td');
        var badge = document.createElement('span');
        badge.className = 'badge bg-' + (scheduled ? 'info' : 'secondary');
        badge.textContent = backup.type;
        typeTd.appendChild(badge);
        tr.appendChild(typeTd);

        var actionsTd = document.createElement('td');
        actionsTd.className = 'text-end';
        var group = document.createElement('div');
        group.className = 'd-inline-flex gap-1';

        var download = squareControl('a', 'btn btn-outline-secondary', 'download', 'Download');
        download.href = '/api/v1/servers/' + serverId + '/backups/' + backup.id + '/download';
        download.dataset.download = 'backup archive';
        group.appendChild(download);

        var restore = squareControl('button', 'btn btn-outline-primary restore-btn', 'restore', 'Restore');
        restore.dataset.backupId = backup.id;
        restore.dataset.backupName = backup.name;
        group.appendChild(restore);

        var del = squareControl('button', 'btn btn-outline-danger delete-btn', 'delete', 'Delete');
        del.dataset.backupId = backup.id;
        del.dataset.backupName = backup.name;
        group.appendChild(del);

        actionsTd.appendChild(group);
        tr.appendChild(actionsTd);
        return tr;
    }

    function renderRows(backups) {
        if (!tbody) return;
        tbody.innerHTML = '';
        backups.forEach(function (backup) { tbody.appendChild(buildRow(backup)); });
        if (countEl) countEl.textContent = String(backups.length);
        if (emptyState) emptyState.classList.toggle('d-none', backups.length > 0);
        if (tableWrap) tableWrap.classList.toggle('d-none', backups.length === 0);
    }

    // Refetch and redraw. Sequenced so a slow response can never paint over a
    // newer one.
    var refreshSeq = 0;
    async function refreshList() {
        if (!tbody) return;
        var seq = ++refreshSeq;
        var res = await apiFetch('/api/v1/servers/' + serverId + '/backups');
        if (seq !== refreshSeq) return;
        if (!res.ok || !res.data) {
            showToast((res.data && res.data.error) || 'Could not refresh the backup list.', 'danger');
            return;
        }
        renderRows(res.data.backups || []);
    }

    // A backup was deleted from another tab. Own deletes are skipped — the
    // handler that made them already refreshed. Creation arrives as the backup
    // operation below, whoever (or whatever schedule) started it.
    document.addEventListener('craftbox:content-changed', function (e) {
        var msg = e.detail || {};
        if (msg.scope !== 'backups') return;
        if (msg.origin && msg.origin === window.CRAFTBOX_CLIENT_ID) return;
        refreshList();
    });

    // ── Page-load resilience: if state is backing_up or restoring, show the
    // overlay so a user reloading mid-operation sees the right thing.
    var navHeader = document.getElementById('server-nav-header');
    var initialState = navHeader ? navHeader.dataset.state : '';
    // Which operation this tab is waiting on — the one it started, or the one
    // it loaded in the middle of. Only that one gets an outcome toast; a backup
    // made by a schedule or by another tab just shows up in the list.
    var awaiting = null;
    if (initialState === 'backing_up') {
        awaiting = 'backup';
        showOverlay('Creating backup...', 'Compressing server files. This may take a moment.');
    } else if (initialState === 'restoring') {
        awaiting = 'restore';
        showOverlay('Restoring backup...', 'Extracting backup files. This may take a moment.');
    }

    // ── Async operation completion via WebSocket ──
    // serverState.js maintains the WebSocket subscription on this page and
    // dispatches `craftbox:operation` events for backup/restore outcomes —
    // every backup job reports here, manual, restore-point and scheduled
    // alike. The list is refreshed on each; the overlay and toasts are only
    // for the operation this tab is waiting on.
    function handleOperation(e) {
        var msg = e.detail || {};
        if (msg.serverId !== serverId) return;
        if (msg.operation !== 'backup' && msg.operation !== 'restore') return;
        if (msg.status !== 'complete' && msg.status !== 'failed') return;

        var mine = awaiting === msg.operation;
        if (mine) {
            awaiting = null;
            hideOverlay();
        }

        if (msg.operation === 'backup') {
            // Retention runs as part of every backup, so the list can have lost
            // rows as well as gained one.
            refreshList();
            if (!mine) return;
            if (msg.status === 'complete') {
                var warning = msg.payload && msg.payload.warning;
                showToast(warning || 'Backup created successfully.', warning ? 'warning' : 'success');
            } else {
                showToast('Backup failed: ' + (msg.error || 'unknown error'), 'danger');
            }
            resetBackupButton();
        } else {
            if (!mine) return;
            if (msg.status === 'complete') {
                var rWarning = msg.payload && msg.payload.warning;
                showToast(rWarning || 'Backup restored successfully.', rWarning ? 'warning' : 'success');
            } else {
                showToast('Restore failed: ' + (msg.error || 'unknown error'), 'danger');
            }
            resetRestoreButton();
        }
    }
    document.addEventListener('craftbox:operation', handleOperation);

    function resetBackupButton() {
        if (confirmBackupBtn) confirmBackupBtn.disabled = false;
        refreshBackupButton();
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
    var startAfterBackupCheckbox = document.getElementById('startAfterBackup');
    var confirmBackupBtn = document.getElementById('confirm-backup-btn');

    // Whether a backup has to stop the server first depends on the state at the
    // moment you press the button, not the state the page was rendered with.
    function needsStopNow() {
        return !isServerStopped();
    }

    // Keep the confirm button honest as the state changes underneath the page.
    function refreshBackupButton() {
        if (!confirmBackupBtn) return;
        var stop = needsStopNow();
        confirmBackupBtn.classList.toggle('btn-warning', stop);
        confirmBackupBtn.classList.toggle('btn-success', !stop);
        confirmBackupBtn.textContent = stop ? 'Stop & Backup' : 'Create Backup';
    }
    document.addEventListener('craftbox:stategates', refreshBackupButton);
    refreshBackupButton();

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
            var stopFirst = needsStopNow();
            var overlayTitle = stopFirst ? 'Stopping server & creating backup...' : 'Creating backup...';
            awaiting = 'backup';
            showOverlay(overlayTitle, 'Compressing server files. This may take a moment.');

            var name = backupNameInput ? backupNameInput.value.trim() : 'Manual Backup';
            var res = await apiFetch('/api/v1/servers/' + serverId + '/backups', {
                method: 'POST',
                body: {
                    name: name || 'Manual Backup',
                    stopFirst: stopFirst ? 'true' : 'false',
                    // Only meaningful when we're stopping it ourselves.
                    startAfter: (stopFirst && startAfterBackupCheckbox && startAfterBackupCheckbox.checked)
                        ? 'true' : 'false'
                }
            });
            if (!res.ok) {
                awaiting = null;
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

    // Row buttons are bound once, on the table, so rows drawn later work too.
    if (tbody) {
        tbody.addEventListener('click', function (e) {
            var btn = e.target.closest('.restore-btn');
            if (!btn) return;
            pendingRestoreId = btn.dataset.backupId;
            if (startAfterCheckbox) startAfterCheckbox.checked = true;
            if (startAfterInput) startAfterInput.value = 'true';
            restoreModal.show();
        });
    }

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
            awaiting = 'restore';
            showOverlay('Restoring backup...', 'Extracting backup files. This may take a moment.');

            var res = await apiFetch('/api/v1/servers/' + serverId + '/backups/' + pendingRestoreId + '/restore', {
                method: 'POST',
                body: {
                    startAfter: startAfterInput ? startAfterInput.value : 'true'
                }
            });
            if (!res.ok) {
                awaiting = null;
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

    if (tbody) {
        tbody.addEventListener('click', function (e) {
            var btn = e.target.closest('.delete-btn');
            if (!btn) return;
            pendingDeleteId = btn.dataset.backupId;
            if (deleteNameSpan) deleteNameSpan.textContent = btn.dataset.backupName || '';
            deleteModal.show();
        });
    }

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
            if (res.ok) await refreshList();
            hideOverlay();
            if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
            if (!res.ok) {
                showToast((res.data && (res.data.message || res.data.error)) || 'Delete failed.', 'danger');
                return;
            }
            showToast('Backup deleted.', 'success');
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
