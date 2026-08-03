(function () {
    // Event type filter navigation
    var filterSelect = document.getElementById('event-type-filter');
    if (filterSelect) {
        var serverId = filterSelect.dataset.serverId;
        filterSelect.addEventListener('change', function () {
            window.location.href = this.value
                ? '/servers/' + serverId + '/events?type=' + this.value
                : '/servers/' + serverId + '/events';
        });
    }

    // Format event timestamps as an absolute date/time followed by its relative
    // age — "08/03/2026, 14:05:09 (5m ago)". formatDate is the same helper the
    // backups, files, plugins and account pages use, so the absolute half reads
    // identically across the panel.
    function refreshEventTimes() {
        document.querySelectorAll('.event-time').forEach(function (el) {
            if (!el.dataset.time) return;
            var time = new Date(el.dataset.time);
            el.textContent = formatDate(el.dataset.time) + ' (' + timeAgo(time) + ')';
        });
    }
    refreshEventTimes();
    // Re-tick every 30s so the relative half stays honest on a long-open tab.
    setInterval(refreshEventTimes, 30000);

    // Clear events: modal confirmation + overlay
    var clearForm = document.getElementById('clear-events-form');
    var clearModalEl = document.getElementById('clearEventsModal');
    if (clearForm && clearModalEl) {
        var clearModal = new bootstrap.Modal(clearModalEl);
        clearForm.addEventListener('submit', function (e) {
            e.preventDefault();
            clearModal.show();
        });
        document.getElementById('confirm-clear').addEventListener('click', async function () {
            var btn = this;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Clearing...';
            clearModal.hide();
            showOverlay('Clearing events...', 'Deleting all logged events for this server.');

            var serverId = clearForm.dataset.serverId;
            var res = await apiFetch('/api/v1/servers/' + serverId + '/events/clear', { method: 'POST', body: {} });
            if (!res.ok) {
                hideOverlay();
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to clear events.', 'danger');
                btn.disabled = false;
                btn.textContent = 'Clear Events';
                return;
            }
            flashToast('Events cleared.', 'success');
            window.location.reload();
        });
    }
})();
