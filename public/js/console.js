// Console WebSocket client for Craftbox server view page
(function () {
    const wrapper = document.getElementById('console-wrapper');
    if (!wrapper) return;

    const serverId = wrapper.dataset.serverId;
    const output = document.getElementById('console-output');
    const input = document.getElementById('console-input');
    const sendBtn = document.getElementById('console-send');
    const placeholder = document.getElementById('console-placeholder');
    const stateBadge = document.getElementById('server-state-badge');
    const stateText = document.getElementById('state-text');
    const stateIcon = document.getElementById('state-icon');

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
    const actionStates = {
        start: ['stopped', 'crashed'],
        stop: ['running', 'starting'],
        restart: ['running'],
        kill: ['running', 'starting', 'stopping']
    };

    let ws = null;
    let reconnectAttempts = 0;
    let autoScroll = true;
    let currentState = wrapper.dataset.serverState || 'stopped';

    function connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}`);

        ws.onopen = () => {
            reconnectAttempts = 0;
            ws.send(JSON.stringify({ type: 'subscribe', serverId }));
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }

            switch (msg.type) {
                case 'subscribed':
                    if (placeholder) placeholder.remove();
                    if (msg.history && msg.history.length > 0) {
                        msg.history.forEach(line => appendLine(line));
                    }
                    if (msg.state) updateState(msg.state);
                    if (typeof msg.playerCount === 'number') updatePlayerCount(msg.playerCount);
                    scrollToBottom();
                    break;

                case 'console':
                    if (msg.serverId === serverId) {
                        appendLine(msg.line);
                        if (autoScroll) scrollToBottom();
                    }
                    break;

                case 'players':
                    if (msg.serverId === serverId) {
                        updatePlayerCount(msg.count);
                    }
                    break;

                case 'state':
                    if (msg.serverId === serverId) {
                        updateState(msg.state);
                    }
                    break;

                case 'error':
                    appendLine(`[Error] ${msg.message}`, 'error');
                    break;

                case 'pong':
                    break;
            }
        };

        ws.onclose = () => {
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            setTimeout(connect, delay);
        };

        ws.onerror = () => {
            // onclose will fire after this
        };
    }

    function appendLine(text, type) {
        if (placeholder && placeholder.parentNode) placeholder.remove();

        const div = document.createElement('div');
        div.className = 'console-line';
        div.textContent = text;

        // Colorize based on content
        if (type === 'command' || text.startsWith('>')) {
            div.classList.add('console-line-command');
        } else if (/\bWARN\b/i.test(text)) {
            div.classList.add('console-line-warn');
        } else if (/\bERROR\b/i.test(text) || /\bSEVERE\b/i.test(text) || /Exception/i.test(text)) {
            div.classList.add('console-line-error');
        } else if (/\bINFO\b/i.test(text)) {
            div.classList.add('console-line-info');
        }

        output.appendChild(div);

        // Cap displayed lines at 2000
        while (output.children.length > 2000) {
            output.removeChild(output.firstChild);
        }
    }

    function scrollToBottom() {
        output.scrollTop = output.scrollHeight;
    }

    function updateState(state) {
        currentState = state;

        // Update badge
        if (stateBadge) {
            const color = stateColors[state] || 'secondary';
            stateBadge.className = `badge bg-${color} d-flex align-items-center gap-1`;
        }
        if (stateText) {
            stateText.textContent = state.charAt(0).toUpperCase() + state.slice(1);
        }
        if (stateIcon) {
            stateIcon.textContent = stateIcons[state] || 'help';
        }

        // Update button states
        document.querySelectorAll('.server-action-form').forEach(form => {
            const action = form.dataset.action;
            const btn = form.querySelector('button');
            if (btn && actionStates[action]) {
                btn.disabled = !actionStates[action].includes(state);
            }
        });

        // Update console input and send button
        if (input) {
            input.disabled = state !== 'running';
        }
        if (sendBtn) {
            sendBtn.disabled = state !== 'running';
        }

        // Update delete button
        const deleteBtn = document.querySelector('form[action$="/delete"] button');
        if (deleteBtn) {
            deleteBtn.disabled = ['running', 'starting', 'stopping'].includes(state);
        }
    }

    function sendCommand() {
        if (!input || !ws || ws.readyState !== WebSocket.OPEN) return;

        const line = input.value.trim();
        if (line.length === 0) return;
        if (currentState !== 'running') return;

        ws.send(JSON.stringify({ type: 'command', serverId, line }));
        input.value = '';
        input.focus();
    }

    // Auto-scroll detection
    output.addEventListener('scroll', () => {
        const threshold = 50;
        autoScroll = (output.scrollHeight - output.scrollTop - output.clientHeight) < threshold;
    });

    // Command input
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendCommand();
        }
    });

    if (sendBtn) {
        sendBtn.addEventListener('click', sendCommand);
    }

    // Modal confirmations for dangerous actions
    const killForm = document.querySelector('.server-action-form[data-action="kill"]');
    const killModalEl = document.getElementById('killModal');
    if (killForm && killModalEl) {
        const killModal = new bootstrap.Modal(killModalEl);
        killForm.addEventListener('submit', (e) => {
            e.preventDefault();
            killModal.show();
        });
        document.getElementById('confirm-kill').addEventListener('click', () => {
            killModal.hide();
            killForm.submit();
        });
    }

    const deleteForm = document.querySelector('form[action$="/delete"]');
    const deleteModalEl = document.getElementById('deleteModal');
    if (deleteForm && deleteModalEl) {
        const deleteModal = new bootstrap.Modal(deleteModalEl);
        deleteForm.addEventListener('submit', (e) => {
            e.preventDefault();
            deleteModal.show();
        });
        document.getElementById('confirm-delete').addEventListener('click', () => {
            deleteModal.hide();
            showOverlay('Deleting server...', 'Removing all files. This may take a moment.');
            deleteForm.submit();
        });
    }

    // Toggle helpers for auto-restart and auto-start
    function bindToggle(id, endpoint) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', async () => {
            try {
                const csrfInput = document.querySelector('input[name="_csrf"]');
                const res = await fetch('/api/servers/' + serverId + '/' + endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfInput ? csrfInput.value : ''
                    },
                    body: JSON.stringify({ enabled: el.checked })
                });
                if (!res.ok) el.checked = !el.checked;
            } catch {
                el.checked = !el.checked;
            }
        });
    }
    bindToggle('autoRestart', 'autorestart');
    bindToggle('autoStart', 'autostart');

    // ── Resource Stats ──
    const statPlayers = document.getElementById('stat-players');
    const statUptime = document.getElementById('stat-uptime');
    const statMemory = document.getElementById('stat-memory');
    const statDisk = document.getElementById('stat-disk');

    function updatePlayerCount(count) {
        if (statPlayers) statPlayers.textContent = count;
    }

    async function fetchStats() {
        try {
            const res = await fetch('/api/servers/' + serverId + '/stats');
            if (!res.ok) return;
            const data = await res.json();
            const s = data.stats;
            if (statUptime) statUptime.textContent = s.uptimeFormatted || '--';
            if (statMemory) statMemory.textContent = s.memoryFormatted || '--';
            if (statDisk) statDisk.textContent = s.diskFormatted || '--';
            updatePlayerCount(s.playerCount);
        } catch {
            // ignore
        }
    }

    // Fetch stats immediately and every 10 seconds
    fetchStats();
    setInterval(fetchStats, 10000);

    // Start connection
    connect();
})();
