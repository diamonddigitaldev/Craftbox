// Shared WebSocket client for server state updates on management sub-pages.
// Skips if console.js is already connected (detected via #console-wrapper).
(function () {
    if (document.getElementById('console-wrapper')) return;

    var badge = document.getElementById('server-state-badge');
    var stateTextEl = document.getElementById('state-text');
    var stateIconEl = document.getElementById('state-icon');
    var navEl = document.getElementById('server-nav');
    if (!badge || !navEl) return;

    var serverId = null;
    // Derive serverId from the first nav link href: /servers/:id
    var navLink = navEl.querySelector('a.nav-link');
    if (navLink) {
        var match = navLink.getAttribute('href').match(/\/servers\/([0-9a-f-]+)/);
        if (match) serverId = match[1];
    }
    if (!serverId) return;

    var stateColors = {
        stopped: 'secondary',
        starting: 'info',
        running: 'success',
        stopping: 'warning',
        crashed: 'danger',
        backing_up: 'info',
        restoring: 'info'
    };
    var stateIcons = {
        stopped: 'stop_circle',
        starting: 'hourglass_top',
        running: 'play_circle',
        stopping: 'pending',
        crashed: 'error',
        backing_up: 'backup',
        restoring: 'settings_backup_restore'
    };
    var stateDisplayNames = {
        backing_up: 'Backing Up',
        restoring: 'Restoring'
    };

    var ws = null;
    var reconnectAttempts = 0;

    function connect() {
        var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(protocol + '//' + location.host);

        ws.onopen = function () {
            reconnectAttempts = 0;
            ws.send(JSON.stringify({ type: 'subscribe', serverId: serverId }));
        };

        ws.onmessage = function (event) {
            var msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }

            if (msg.type === 'subscribed' && msg.state) {
                updateState(msg.state);
            }
            if (msg.type === 'state' && msg.serverId === serverId) {
                updateState(msg.state);
            }
        };

        ws.onclose = function () {
            reconnectAttempts++;
            var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            setTimeout(connect, delay);
        };

        ws.onerror = function () {};
    }

    function updateState(state) {
        var color = stateColors[state] || 'secondary';
        var icon = stateIcons[state] || 'help';
        var displayName = stateDisplayNames[state] || state.charAt(0).toUpperCase() + state.slice(1);

        badge.className = 'badge bg-' + color + ' d-flex align-items-center gap-1';
        badge.id = 'server-state-badge';
        if (stateIconEl) stateIconEl.textContent = icon;
        if (stateTextEl) stateTextEl.textContent = displayName;
    }

    connect();
})();
