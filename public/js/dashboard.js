// Dashboard WebSocket client for live server state updates
(function () {
    const grid = document.getElementById('server-grid');
    if (!grid) return;

    // Visual state metadata comes from window.CraftboxState (injected by
    // head.ejs from src/utils/serverStateMeta.js — single source of truth).
    const stateColors = (window.CraftboxState || {}).stateColors || {};
    const stateIcons = (window.CraftboxState || {}).stateIcons || {};
    const stateDisplayNames = (window.CraftboxState || {}).stateDisplayNames || {};

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

        ws.onerror = () => { };
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

    // ── Server group sections: collapse persistence (per browser) ──
    var COLLAPSED_GROUPS_KEY = 'craftbox.dashboard.collapsedGroups';

    function getCollapsedGroups() {
        try {
            var stored = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || '[]');
            return Array.isArray(stored) ? stored : [];
        } catch (_) {
            return [];
        }
    }

    function setCollapsedGroups(names) {
        try {
            localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(names));
        } catch (_) { }
    }

    (function initGroupCollapse() {
        var sections = grid.querySelectorAll('.group-section');
        if (!sections.length) return;

        var collapsed = getCollapsedGroups();
        var presentNames = [];

        sections.forEach(function (section) {
            var name = section.dataset.groupName;
            presentNames.push(name);
            var toggle = document.querySelector('[data-bs-target="#' + section.id + '"]');

            if (collapsed.indexOf(name) !== -1) {
                section.classList.remove('show');
                if (toggle) toggle.setAttribute('aria-expanded', 'false');
            }

            section.addEventListener('hidden.bs.collapse', function () {
                var names = getCollapsedGroups();
                if (names.indexOf(name) === -1) names.push(name);
                setCollapsedGroups(names);
            });
            section.addEventListener('shown.bs.collapse', function () {
                setCollapsedGroups(getCollapsedGroups().filter(function (n) { return n !== name; }));
            });
        });

        // Prune groups that no longer exist so the stored list can't grow forever.
        setCollapsedGroups(getCollapsedGroups().filter(function (n) { return presentNames.indexOf(n) !== -1; }));
    })();

    // ── Server group moves (card dropdown + "New group…" modal) ──
    async function moveServerToGroup(serverId, group) {
        var res = await apiFetch('/api/v1/servers/' + serverId + '/group', { method: 'POST', body: { group: group } });
        if (!res.ok) {
            showToast((res.data && res.data.error) || 'Failed to move server.', 'danger');
            return false;
        }
        flashToast(group ? 'Server moved to "' + group + '".' : 'Server removed from group.', 'success');
        location.reload();
        return true;
    }

    var pendingGroupServerId = null;
    var assignGroupModal = document.getElementById('assignGroupModal');

    grid.addEventListener('click', function (e) {
        var moveItem = e.target.closest('.group-move-item');
        if (moveItem) {
            var serverId = moveItem.closest('.server-card')?.dataset.serverId;
            if (serverId) moveServerToGroup(serverId, moveItem.dataset.group || '');
            return;
        }

        var newItem = e.target.closest('.group-new-item');
        if (newItem && assignGroupModal) {
            pendingGroupServerId = newItem.closest('.server-card')?.dataset.serverId || null;
            var input = document.getElementById('assign-group-name');
            if (input) input.value = '';
            new bootstrap.Modal(assignGroupModal).show();
        }
    });

    if (assignGroupModal) {
        assignGroupModal.addEventListener('shown.bs.modal', function () {
            document.getElementById('assign-group-name')?.focus();
        });

        var confirmBtn = document.getElementById('assign-group-confirm');
        confirmBtn?.addEventListener('click', async function () {
            var input = document.getElementById('assign-group-name');
            var name = (input?.value || '').trim();
            if (!name || !pendingGroupServerId) return;

            confirmBtn.disabled = true;
            var moved = await moveServerToGroup(pendingGroupServerId, name);
            confirmBtn.disabled = false;
            if (moved) bootstrap.Modal.getInstance(assignGroupModal)?.hide();
        });
    }

    // ── Server action buttons (start/stop/restart) on each card ──
    grid.addEventListener('click', async function (e) {
        var btn = e.target.closest('.server-action-btn');
        if (!btn) return;
        var serverId = btn.closest('.server-actions')?.dataset.serverId;
        var action = btn.dataset.action;
        if (!serverId || !action) return;

        var labels = {
            start: { title: 'Starting server...', desc: 'Please wait while the command is sent.' },
            stop: { title: 'Stopping server...', desc: 'Please wait while the command is sent.' },
            restart: { title: 'Restarting server...', desc: 'Please wait while the command is sent.' }
        };
        showOverlay(labels[action].title, labels[action].desc);

        var res = await apiFetch('/api/v1/servers/' + serverId + '/' + action, { method: 'POST', body: {} });
        hideOverlay();
        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || ('Failed to ' + action + ' server.'), 'danger');
            return;
        }
        showToast((res.data && res.data.message) || ('Server ' + action + ' requested.'), 'success');
        // State updates arrive via WebSocket — no page reload needed.
    });
})();
