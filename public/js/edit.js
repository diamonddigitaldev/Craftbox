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
