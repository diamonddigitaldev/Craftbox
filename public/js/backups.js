// Backups page JavaScript
(function () {
    var serverId = window.location.pathname.split('/')[2];
    var csrf = document.getElementById('csrf-token')?.value || '';

    // ── Create Backup Modal ──
    var createBackupModal = new bootstrap.Modal(document.getElementById('createBackupModal'));
    var createBackupBtn = document.getElementById('create-backup-btn');
    var backupForm = document.getElementById('backup-form');
    var backupNameInput = document.getElementById('backupName');
    var backupStartAfterInput = document.getElementById('backupStartAfter');
    var startAfterBackupCheckbox = document.getElementById('startAfterBackup');
    var stopFirst = document.getElementById('backupStopFirst');
    var needsStop = stopFirst && stopFirst.value === 'true';

    if (createBackupBtn) {
        createBackupBtn.addEventListener('click', function () {
            backupNameInput.value = '';
            createBackupModal.show();
        });
    }

    if (startAfterBackupCheckbox && backupStartAfterInput) {
        startAfterBackupCheckbox.addEventListener('change', function () {
            backupStartAfterInput.value = startAfterBackupCheckbox.checked ? 'true' : 'false';
        });
    }

    if (backupForm) {
        backupForm.addEventListener('submit', function () {
            var btn = document.getElementById('confirm-backup-btn');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Creating...';
            }
            createBackupModal.hide();
            var overlayTitle = needsStop ? 'Stopping server & creating backup...' : 'Creating backup...';
            showOverlay(overlayTitle, 'Compressing server files. This may take a moment.');
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

    deleteForm.addEventListener('submit', function () {
        var btn = deleteForm.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';
        }
        deleteModal.hide();
        showOverlay('Deleting backup...', 'Please wait while the backup is removed.');
    });

    // ── Next Backup Display Helper ──
    var nextBackupText = document.getElementById('next-backup-text');

    function formatTimestamp(date) {
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
            + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    function updateNextBackup(isoString) {
        if (!nextBackupText) return;
        if (isoString) {
            nextBackupText.textContent = 'Next backup: ' + formatTimestamp(new Date(isoString));
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
                if (res.ok) {
                    var data = await res.json();
                    updateNextBackup(data.nextBackupAt);
                } else {
                    scheduleToggle.checked = !enabled;
                }
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
            saveScheduleBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';

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
                    var data = await res.json();
                    updateNextBackup(data.nextBackupAt);
                    saveScheduleBtn.textContent = 'Saved!';
                } else {
                    saveScheduleBtn.textContent = 'Error';
                }
            } catch {
                saveScheduleBtn.textContent = 'Error';
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
                } else {
                    saveRetentionBtn.textContent = 'Error';
                }
            } catch {
                saveRetentionBtn.textContent = 'Error';
            }
            setTimeout(function () {
                saveRetentionBtn.textContent = 'Save Retention';
                saveRetentionBtn.disabled = false;
            }, 2000);
        });
    }
})();
