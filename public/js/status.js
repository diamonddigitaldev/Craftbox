(function () {
    // Populate server IP addresses using advertised IP or browser hostname + port
    document.querySelectorAll('.server-ip').forEach(function (el) {
        var port = el.dataset.port;
        var advertisedIp = el.dataset.ip;
        if (advertisedIp) {
            el.textContent = advertisedIp;
        } else {
            el.textContent = window.location.hostname + ':' + port;
        }
    });

    // Format event times as relative ("5m ago", "2h ago")
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

    // Auto-refresh every 30 seconds for live status updates
    setTimeout(function () {
        location.reload();
    }, 30000);
})();
