// Dashboard WebSocket client for live server state updates
(function () {
    const grid = document.getElementById('server-grid');
    if (!grid) return;

    const stateColors = {
        stopped: 'secondary',
        starting: 'info',
        running: 'success',
        stopping: 'warning',
        crashed: 'danger'
    };
    const stateIcons = {
        stopped: 'stop_circle',
        starting: 'hourglass_top',
        running: 'play_circle',
        stopping: 'pending',
        crashed: 'error'
    };

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
            }
            if (msg.type === 'players' && msg.serverId) {
                updateCardStat(msg.serverId, 'players', msg.count);
            }
            if (msg.type === 'subscribed' && msg.serverId && typeof msg.playerCount === 'number') {
                updateCardStat(msg.serverId, 'players', msg.playerCount);
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
            if (textEl) textEl.textContent = state.charAt(0).toUpperCase() + state.slice(1);
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

    // Fetch stats for all servers
    async function fetchAllStats() {
        var ids = getServerIds();
        for (var i = 0; i < ids.length; i++) {
            try {
                var res = await fetch('/api/servers/' + ids[i] + '/stats');
                if (!res.ok) continue;
                var data = await res.json();
                var s = data.stats;
                updateCard(ids[i], s.state);
                updateCardStat(ids[i], 'players', s.playerCount);
                updateCardStat(ids[i], 'uptime', s.uptimeFormatted || '--');
            } catch {
                // ignore
            }
        }
    }

    // Fetch stats on load and every 10 seconds
    fetchAllStats();
    setInterval(fetchAllStats, 10000);

    connect();
})();
