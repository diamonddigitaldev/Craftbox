// Shows a "restart required" modal after saving settings/properties
(function () {
    const modalEl = document.getElementById('restartModal');
    if (!modalEl) return;

    const restartBtn = document.getElementById('restart-now-btn');

    // No backup option here: a backup taken at this point is already too late to
    // undo the change that was just saved. The "Create backup before saving"
    // checkbox on the save form takes the restore point up front instead.
    if (restartBtn) {
        restartBtn.addEventListener('click', async function () {
            restartBtn.disabled = true;
            restartBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Restarting...';

            bootstrap.Modal.getInstance(modalEl)?.hide();

            const serverId = restartBtn.dataset.serverId;

            var res = await apiFetch('/api/v1/servers/' + serverId + '/restart', {
                method: 'POST',
                body: {}
            });

            restartBtn.disabled = false;
            restartBtn.textContent = 'Restart Now';

            if (!res.ok) {
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to restart server.', 'danger');
                return;
            }
            // Stay on the page the user was working on — no overlay, no redirect.
            // The nav header's state badge tracks the restart live over the
            // WebSocket, so there is nothing to navigate to.
            showToast((res.data && res.data.message) || 'Server is restarting...', 'success');
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
