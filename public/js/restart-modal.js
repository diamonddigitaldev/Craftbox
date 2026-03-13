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
    if (restartBtn) {
        restartBtn.addEventListener('click', async function () {
            restartBtn.disabled = true;
            restartBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Restarting...';

            const serverId = restartBtn.dataset.serverId;
            const csrf = restartBtn.dataset.csrf;

            try {
                const res = await fetch('/servers/' + serverId + '/restart', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-CSRF-Token': csrf
                    },
                    body: '_csrf=' + encodeURIComponent(csrf)
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
