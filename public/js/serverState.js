// Shared WebSocket client for server state updates on management sub-pages.
// Skips if console.js is already connected (detected via #console-wrapper).
(function () {
    if (document.getElementById('console-wrapper')) return;

    var badge = document.getElementById('server-state-badge');
    var stateTextEl = document.getElementById('state-text');
    var stateIconEl = document.getElementById('state-icon');
    var navEl = document.getElementById('server-nav');
    var navHeader = document.getElementById('server-nav-header');
    if (!badge || !navEl) return;

    var serverId = null;
    // Derive serverId from the first nav link href: /servers/:id
    var navLink = navEl.querySelector('a.nav-link');
    if (navLink) {
        var match = navLink.getAttribute('href').match(/\/servers\/([0-9a-f-]+)/);
        if (match) serverId = match[1];
    }
    if (!serverId) return;

    // Visual state metadata comes from window.CraftboxState (injected by
    // head.ejs from src/utils/serverStateMeta.js — single source of truth).
    var stateColors = (window.CraftboxState || {}).stateColors || {};
    var stateIcons = (window.CraftboxState || {}).stateIcons || {};
    var stateDisplayNames = (window.CraftboxState || {}).stateDisplayNames || {};

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
            if (msg.type === 'operation' && msg.serverId === serverId) {
                document.dispatchEvent(new CustomEvent('craftbox:operation', { detail: msg }));
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

        // Update data-state on parent for CSS animations
        if (navHeader) navHeader.dataset.state = state;

        badge.className = 'badge bg-' + color + ' d-flex align-items-center gap-1 server-state-badge';
        badge.id = 'server-state-badge';
        if (stateIconEl) stateIconEl.textContent = icon;
        if (stateTextEl) stateTextEl.textContent = displayName;
    }

    connect();
})();

// ── Live version label ──
// The nav header's "<Type> <version>" text goes stale when a version upgrade
// finishes. Runs on every server sub-page, including the console page (where
// the IIFE above defers to console.js): whichever script owns the WebSocket
// re-dispatches operation messages as craftbox:operation, already filtered
// to this server's id.
(function () {
    var label = document.getElementById('server-version-label');
    if (!label) return;

    document.addEventListener('craftbox:operation', function (e) {
        var msg = e.detail || {};
        if (msg.operation !== 'jar-upgrade' || msg.status !== 'complete') return;
        var version = msg.payload && msg.payload.version;
        if (version) label.textContent = version;
    });
})();
