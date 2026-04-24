// Dashboard WebSocket client for live server state updates
(function () {
    const grid = document.getElementById('server-grid');
    if (!grid) return;

    const stateColors = {
        stopped: 'secondary',
        starting: 'info',
        running: 'success',
        stopping: 'warning',
        crashed: 'danger',
        backing_up: 'info',
        restoring: 'info'
    };
    const stateIcons = {
        stopped: 'stop_circle',
        starting: 'hourglass_top',
        running: 'play_circle',
        stopping: 'pending',
        crashed: 'error',
        backing_up: 'backup',
        restoring: 'settings_backup_restore'
    };
    const stateDisplayNames = {
        backing_up: 'Backing Up',
        restoring: 'Restoring'
    };

    // Track lastStarted per server for client-side uptime ticking
    var serverStartTimes = {};

    let ws = null;
    let reconnectAttempts = 0;

    // Collect all server IDs on the page
    function getServerIds() {
        const cards = grid.querySelectorAll('.server-card');
        return Array.from(cards).map(c => c.dataset.serverId).filter(Boolean);
    }

    function connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}`);

        ws.onopen = () => {
            reconnectAttempts = 0;
            // Subscribe to all servers
            getServerIds().forEach(id => {
                ws.send(JSON.stringify({ type: 'subscribe', serverId: id }));
            });
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }

            if (msg.type === 'state' && msg.serverId) {
                updateCard(msg.serverId, msg.state);
                updateLastStarted(msg.serverId, msg.state, msg.lastStarted);
            }
            if (msg.type === 'players' && msg.serverId) {
                updateCardStat(msg.serverId, 'players', msg.count);
            }
            if (msg.type === 'subscribed' && msg.serverId) {
                if (typeof msg.playerCount === 'number') {
                    updateCardStat(msg.serverId, 'players', msg.playerCount);
                }
                updateLastStarted(msg.serverId, msg.state, msg.lastStarted);
            }
        };

        ws.onclose = () => {
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            setTimeout(connect, delay);
        };

        ws.onerror = () => {};
    }

    function updateCard(serverId, state) {
        const card = grid.querySelector(`.server-card[data-server-id="${serverId}"]`);
        if (!card) return;

        const color = stateColors[state] || 'secondary';
        const icon = stateIcons[state] || 'help';

        // Update badge
        const badge = card.querySelector('.server-state-badge');
        if (badge) {
            badge.className = `badge bg-${color} d-flex align-items-center gap-1 server-state-badge`;
            const iconEl = badge.querySelector('.material-icons-outlined');
            if (iconEl) iconEl.textContent = icon;
            const textEl = badge.querySelector('.server-state-text');
            if (textEl) textEl.textContent = stateDisplayNames[state] || state.charAt(0).toUpperCase() + state.slice(1);
        }

        // Update card border
        card.className = card.className.replace(/border-\w+/g, '') + ` border-${color}`;
        card.dataset.state = state;

        // Toggle action buttons
        var startBtn = card.querySelector('.server-action-start');
        var stopBtn = card.querySelector('.server-action-stop');
        var restartBtn = card.querySelector('.server-action-restart');
        if (startBtn) startBtn.classList.toggle('d-none', state !== 'stopped' && state !== 'crashed');
        if (stopBtn) stopBtn.classList.toggle('d-none', state !== 'running' && state !== 'starting');
        if (restartBtn) restartBtn.classList.toggle('d-none', state !== 'running');

        // Toggle crash footer
        var crashFooter = card.querySelector('.server-crash-footer');
        if (crashFooter) crashFooter.classList.toggle('d-none', state !== 'crashed');
    }

    function updateCardStat(serverId, stat, value) {
        var card = grid.querySelector('.server-card[data-server-id="' + serverId + '"]');
        if (!card) return;
        var el = card.querySelector('.card-stat-' + stat);
        if (el) el.textContent = value;
    }

    function formatUptime(seconds) {
        if (seconds < 0) return 'Offline';
        var d = Math.floor(seconds / 86400);
        var h = Math.floor((seconds % 86400) / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var parts = [];
        if (d > 0) parts.push(d + 'd');
        if (h > 0) parts.push(h + 'h');
        parts.push(m + 'm');
        return parts.join(' ');
    }

    function updateLastStarted(serverId, state, lastStarted) {
        var running = (state === 'running');
        serverStartTimes[serverId] = running && lastStarted ? lastStarted : null;
        resetUptimeTick();
    }

    function updateUptimeDisplay(serverId) {
        var startTime = serverStartTimes[serverId];
        var text = 'Offline';
        if (startTime) {
            var seconds = Math.max(0, Math.floor((Date.now() - new Date(startTime).getTime()) / 1000));
            text = formatUptime(seconds);
        }
        updateCardStat(serverId, 'uptime', text);
    }

    var uptimeTickInterval = setInterval(uptimeTick, 10000);

    function uptimeTick() {
        getServerIds().forEach(function (id) {
            updateUptimeDisplay(id);
        });
    }

    function resetUptimeTick() {
        clearInterval(uptimeTickInterval);
        uptimeTick();
        uptimeTickInterval = setInterval(uptimeTick, 10000);
    }

    connect();

    // ── Server action buttons (start/stop/restart) on each card ──
    grid.addEventListener('click', async function (e) {
        var btn = e.target.closest('.server-action-btn');
        if (!btn) return;
        var serverId = btn.closest('.server-actions')?.dataset.serverId;
        var action = btn.dataset.action;
        if (!serverId || !action) return;

        var labels = {
            start: { title: 'Starting server...', desc: 'Please wait.' },
            stop: { title: 'Stopping server...', desc: 'Please wait while the server shuts down.' },
            restart: { title: 'Restarting server...', desc: 'Please wait.' }
        };
        showOverlay(labels[action].title, labels[action].desc);

        var res = await apiFetch('/api/v1/servers/' + serverId + '/' + action, { method: 'POST', body: {} });
        hideOverlay();
        if (!res.ok) {
            alert((res.data && (res.data.message || res.data.error)) || ('Failed to ' + action + ' server.'));
        }
        // State updates arrive via WebSocket — no page reload needed.
    });
})();
