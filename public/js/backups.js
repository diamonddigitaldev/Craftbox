// Backups page JavaScript
(function () {
    var serverId = window.location.pathname.split('/')[2];
    var csrf = document.getElementById('csrf-token')?.value || '';

    // ── Manual Backup (server running) ──
    var runningBtn = document.getElementById('create-backup-running-btn');
    if (runningBtn) {
        var stopBackupModal = new bootstrap.Modal(document.getElementById('stopBackupModal'));
        runningBtn.addEventListener('click', function () {
            stopBackupModal.show();
        });
    }

    // Wire up "Start server after backup" checkbox
    var startAfterBackupCheckbox = document.getElementById('startAfterBackup');
    var startAfterBackupInput = document.getElementById('startAfterBackupInput');
    if (startAfterBackupCheckbox && startAfterBackupInput) {
        startAfterBackupCheckbox.addEventListener('change', function () {
            startAfterBackupInput.value = startAfterBackupCheckbox.checked ? 'true' : 'false';
        });
    }

    // ── Backup form overlay ──
    var backupForm = document.getElementById('backup-form');
    if (backupForm) {
        backupForm.addEventListener('submit', function () {
            showOverlay('Creating backup...', 'Compressing server files. This may take a moment.');
        });
    }

    // Stop & Backup form overlay
    var stopBackupBtn = document.getElementById('stop-backup-btn');
    if (stopBackupBtn) {
        stopBackupBtn.closest('form').addEventListener('submit', function () {
            stopBackupBtn.disabled = true;
            stopBackupBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Stopping...';
            if (stopBackupModal) stopBackupModal.hide();
            showOverlay('Stopping server & creating backup...', 'Compressing server files. This may take a moment.');
        });
    }

    // ── Restore Modal ──
    var restoreModal = new bootstrap.Modal(document.getElementById('restoreModal'));
    var restoreForm = document.getElementById('restore-form');
    var startAfterCheckbox = document.getElementById('startAfterRestore');
    var startAfterInput = document.getElementById('startAfterInput');

    document.querySelectorAll('.restore-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var backupId = btn.dataset.backupId;
            restoreForm.action = '/servers/' + serverId + '/backups/' + backupId + '/restore';
            startAfterCheckbox.checked = true;
            startAfterInput.value = 'true';
            restoreModal.show();
        });
    });

    if (startAfterCheckbox) {
        startAfterCheckbox.addEventListener('change', function () {
            startAfterInput.value = startAfterCheckbox.checked ? 'true' : 'false';
        });
    }

    var confirmRestoreBtn = document.getElementById('confirm-restore-btn');
    if (confirmRestoreBtn) {
        restoreForm.addEventListener('submit', function () {
            confirmRestoreBtn.disabled = true;
            confirmRestoreBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Restoring...';
            restoreModal.hide();
            showOverlay('Restoring backup...', 'Extracting backup files. This may take a moment.');
        });
    }

    // ── Delete Modal ──
    var deleteModal = new bootstrap.Modal(document.getElementById('deleteBackupModal'));
    var deleteForm = document.getElementById('delete-form');
    var deleteNameSpan = document.getElementById('delete-backup-name');

    document.querySelectorAll('.delete-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var backupId = btn.dataset.backupId;
            deleteForm.action = '/servers/' + serverId + '/backups/' + backupId + '/delete';
            deleteNameSpan.textContent = btn.dataset.backupName;
            deleteModal.show();
        });
    });

    // ── Schedule Toggle ──
    var scheduleToggle = document.getElementById('scheduleEnabled');
    var scheduleSettings = document.getElementById('schedule-settings');

    if (scheduleToggle) {
        scheduleToggle.addEventListener('change', async function () {
            var enabled = scheduleToggle.checked;
            scheduleSettings.classList.toggle('d-none', !enabled);

            try {
                var res = await fetch('/api/servers/' + serverId + '/backup-schedule', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf
                    },
                    body: JSON.stringify({ enabled: enabled })
                });
                if (!res.ok) scheduleToggle.checked = !enabled;
            } catch {
                scheduleToggle.checked = !enabled;
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
            saveScheduleBtn.textContent = 'Saving...';

            try {
                var res = await fetch('/api/servers/' + serverId + '/backup-schedule', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf
                    },
                    body: JSON.stringify({
                        enabled: scheduleToggle.checked,
                        intervalHours: intervalHours,
                        countdownMinutes: countdownMinutes
                    })
                });

                if (res.ok) {
                    saveScheduleBtn.textContent = 'Saved!';
                    setTimeout(function () { saveScheduleBtn.textContent = 'Save Schedule'; }, 2000);
                } else {
                    saveScheduleBtn.textContent = 'Error';
                    setTimeout(function () { saveScheduleBtn.textContent = 'Save Schedule'; }, 2000);
                }
            } catch {
                saveScheduleBtn.textContent = 'Error';
                setTimeout(function () { saveScheduleBtn.textContent = 'Save Schedule'; }, 2000);
            } finally {
                saveScheduleBtn.disabled = false;
            }
        });
    }

    // ── Save Retention ──
    var saveRetentionBtn = document.getElementById('save-retention-btn');
    if (saveRetentionBtn) {
        saveRetentionBtn.addEventListener('click', async function () {
            var retentionCount = parseInt(document.getElementById('retentionCount').value, 10);
            var retentionDays = parseInt(document.getElementById('retentionDays').value, 10);

            saveRetentionBtn.disabled = true;
            saveRetentionBtn.textContent = 'Saving...';

            try {
                var res = await fetch('/api/servers/' + serverId + '/backup-retention', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf
                    },
                    body: JSON.stringify({
                        retentionCount: retentionCount,
                        retentionDays: retentionDays
                    })
                });

                if (res.ok) {
                    saveRetentionBtn.textContent = 'Saved!';
                    setTimeout(function () { saveRetentionBtn.textContent = 'Save Retention'; }, 2000);
                } else {
                    saveRetentionBtn.textContent = 'Error';
                    setTimeout(function () { saveRetentionBtn.textContent = 'Save Retention'; }, 2000);
                }
            } catch {
                saveRetentionBtn.textContent = 'Error';
                setTimeout(function () { saveRetentionBtn.textContent = 'Save Retention'; }, 2000);
            } finally {
                saveRetentionBtn.disabled = false;
            }
        });
    }
})();
