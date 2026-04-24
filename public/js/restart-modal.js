// Shows a "restart required" modal after saving settings/properties
(function () {
    const modalEl = document.getElementById('restartModal');
    if (!modalEl) return;

    const restartBtn = document.getElementById('restart-now-btn');
    const backupCheckbox = document.getElementById('restartBackup');

    if (restartBtn) {
        restartBtn.addEventListener('click', async function () {
            const wantBackup = backupCheckbox && backupCheckbox.checked;

            restartBtn.disabled = true;
            restartBtn.innerHTML = wantBackup
                ? '<span class="spinner-border spinner-border-sm"></span> Backing up & restarting...'
                : '<span class="spinner-border spinner-border-sm"></span> Restarting...';

            bootstrap.Modal.getInstance(modalEl)?.hide();
            showOverlay(
                wantBackup ? 'Backing up & restarting...' : 'Restarting server...',
                wantBackup ? 'Creating a backup before restarting. This may take a moment.' : 'Please wait while the server restarts.'
            );

            const serverId = restartBtn.dataset.serverId;

            var res = await apiFetch('/api/v1/servers/' + serverId + '/restart', {
                method: 'POST',
                body: wantBackup ? { backup: true } : {}
            });

            if (!res.ok) {
                hideOverlay();
                alert((res.data && (res.data.message || res.data.error)) || 'Failed to restart server.');
                restartBtn.disabled = false;
                restartBtn.textContent = 'Restart Now';
                return;
            }
            window.location.href = '/servers/' + serverId;
        });
    }

    // Auto-show the modal on ?saved page loads (from properties/edit form submits)
    const params = new URLSearchParams(window.location.search);
    if (!params.has('saved')) return;

    window.history.replaceState({}, '', window.location.pathname);

    var serverState = modalEl.dataset.serverState;
    if (serverState === 'stopped' || serverState === 'crashed') return;

    new bootstrap.Modal(modalEl).show();
})();
