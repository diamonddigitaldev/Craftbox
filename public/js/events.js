(function () {
    // Format event timestamps as relative time
    document.querySelectorAll('.event-time').forEach(function (el) {
        var time = new Date(el.dataset.time);
        el.textContent = timeAgo(time);
        el.title = time.toLocaleString();
    });

    function timeAgo(date) {
        var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        var minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm ago';
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + 'h ago';
        var days = Math.floor(hours / 24);
        return days + 'd ago';
    }

    // Clear events: modal confirmation + overlay
    var clearForm = document.getElementById('clear-events-form');
    var clearModalEl = document.getElementById('clearEventsModal');
    if (clearForm && clearModalEl) {
        var clearModal = new bootstrap.Modal(clearModalEl);
        clearForm.addEventListener('submit', function (e) {
            e.preventDefault();
            clearModal.show();
        });
        document.getElementById('confirm-clear').addEventListener('click', function () {
            clearModal.hide();
            showOverlay('Clearing events...', 'Deleting all logged events for this server.');
            clearForm.submit();
        });
    }
})();
