// Shows a "restart required" modal after saving settings/properties
(function () {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('saved')) return;

    // Clean URL without reloading
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);

    const modalEl = document.getElementById('restartModal');
    if (!modalEl) return;

    // Only show restart modal if server is not already stopped
    var serverState = modalEl.dataset.serverState;
    if (serverState === 'stopped' || serverState === 'crashed') return;

    var modal = new bootstrap.Modal(modalEl);
    modal.show();

    const restartBtn = document.getElementById('restart-now-btn');
    const backupCheckbox = document.getElementById('restartBackup');

    if (restartBtn) {
        restartBtn.addEventListener('click', async function () {
            const wantBackup = backupCheckbox && backupCheckbox.checked;

            restartBtn.disabled = true;
            restartBtn.innerHTML = wantBackup
                ? '<span class="spinner-border spinner-border-sm"></span> Backing up & restarting...'
                : '<span class="spinner-border spinner-border-sm"></span> Restarting...';

            modal.hide();
            showOverlay(
                wantBackup ? 'Backing up & restarting...' : 'Restarting server...',
                wantBackup ? 'Creating a backup before restarting. This may take a moment.' : 'Please wait while the server restarts.'
            );

            const serverId = restartBtn.dataset.serverId;
            const csrf = restartBtn.dataset.csrf;

            try {
                const bodyParts = ['_csrf=' + encodeURIComponent(csrf)];
                if (wantBackup) bodyParts.push('backup=true');

                const res = await fetch('/servers/' + serverId + '/restart', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-CSRF-Token': csrf
                    },
                    body: bodyParts.join('&')
                });

                if (res.redirected) {
                    window.location.href = res.url;
                } else {
                    window.location.href = '/servers/' + serverId;
                }
            } catch {
                window.location.href = '/servers/' + serverId;
            }
        });
    }
})();
