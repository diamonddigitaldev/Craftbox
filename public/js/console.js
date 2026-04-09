// Console WebSocket client for Craftbox server view page
(function () {
    const wrapper = document.getElementById('console-wrapper');
    if (!wrapper) return;

    const serverId = wrapper.dataset.serverId;
    const memoryAllocatedMb = parseInt(wrapper.dataset.memoryAllocated, 10) || 2048;
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
    var serverLastStarted = null;

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
                    if (msg.state) updateState(msg.state, msg.crashReason, msg.exitCode);
                    updateLastStarted(msg.state, msg.lastStarted);
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
                        updateState(msg.state, msg.crashReason, msg.exitCode);
                        updateLastStarted(msg.state, msg.lastStarted);
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
        if (text.startsWith('[Craftbox]')) {
            div.classList.add('console-line-craftbox');
        } else if (type === 'command' || text.startsWith('>')) {
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

    function updateState(state, crashReason, exitCode) {
        currentState = state;

        // Update badge
        if (stateBadge) {
            const color = stateColors[state] || 'secondary';
            stateBadge.className = `badge bg-${color} d-flex align-items-center gap-1`;
        }
        if (stateText) {
            stateText.textContent = stateDisplayNames[state] || state.charAt(0).toUpperCase() + state.slice(1);
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
            sendBtn.disabled = state !== 'running' || !input.value.trim();
        }

        // Update delete button
        const deleteBtn = document.querySelector('form[action$="/delete"] button');
        if (deleteBtn) {
            deleteBtn.disabled = !['stopped', 'crashed'].includes(state);
        }

        // Immediately wipe stats and set charts offline when server stops/crashes
        if (state !== 'running') {
            if (statCpu) statCpu.textContent = '--';
            if (statMemory) statMemory.textContent = '--';
            updatePlayerCount(0);
            setChartsOffline(true);
        }

        // Show/hide crash banner
        const crashBanner = document.getElementById('crash-banner');
        const crashText = document.getElementById('crash-banner-text');
        if (crashBanner) {
            if (state === 'crashed') {
                var autoRestartEl = document.getElementById('autoRestart');
                var autoRestart = autoRestartEl ? autoRestartEl.checked : false;
                var reasonText = crashReason === 'oom'
                    ? ' due to Out of Memory'
                    : '';
                var exitText = exitCode != null
                    ? ' Exit code: <strong>' + exitCode + '</strong>.'
                    : '';
                crashText.innerHTML = 'Server crashed' + reasonText + '.' + exitText
                    + (autoRestart ? ' Auto-restart is enabled.' : '');
                crashBanner.style.display = 'flex';
            } else {
                crashBanner.style.display = 'none';
            }
        }
    }

    function sendCommand() {
        if (!input || !ws || ws.readyState !== WebSocket.OPEN) return;

        const line = input.value.trim();
        if (line.length === 0) return;
        if (currentState !== 'running') return;

        ws.send(JSON.stringify({ type: 'command', serverId, line }));
        input.value = '';
        if (sendBtn) sendBtn.disabled = true;
        input.focus();
    }

    // Auto-scroll detection
    output.addEventListener('scroll', () => {
        const threshold = 50;
        autoScroll = (output.scrollHeight - output.scrollTop - output.clientHeight) < threshold;
    });

    // Toggle send button based on input content
    input.addEventListener('input', () => {
        if (sendBtn) {
            sendBtn.disabled = currentState !== 'running' || !input.value.trim();
        }
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
    const statCpu = document.getElementById('stat-cpu');
    const statMemory = document.getElementById('stat-memory');
    const statDisk = document.getElementById('stat-disk');

    function updatePlayerCount(count) {
        if (statPlayers) statPlayers.textContent = count;
    }

    // ── Resource Charts (Chart.js) ──
    const cpuLabel = document.getElementById('cpu-label');
    const ramLabel = document.getElementById('ram-label');

    function formatBytes(bytes) {
        if (bytes === 0 || bytes == null) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.floor(Math.log(bytes) / Math.log(1024));
        return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
    }

    function formatTime(ts) {
        var d = new Date(ts);
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        return hh + ':' + mm;
    }

    var chartDefaults = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: true,
                intersect: true,
                mode: 'nearest',
                backgroundColor: 'rgba(13,17,23,0.9)',
                titleColor: 'rgba(255,255,255,0.6)',
                bodyColor: '#fff',
                borderColor: 'rgba(255,255,255,0.1)',
                borderWidth: 1,
                padding: 8,
                displayColors: false
            }
        },
        scales: {
            x: {
                ticks: {
                    color: 'rgba(255,255,255,0.35)',
                    font: { size: 11 },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 8
                },
                grid: { color: 'rgba(255,255,255,0.06)' },
                border: { color: 'rgba(255,255,255,0.06)' }
            },
            y: {
                min: 0,
                ticks: {
                    color: 'rgba(255,255,255,0.35)',
                    font: { size: 11 },
                    stepSize: 25
                },
                grid: { color: 'rgba(255,255,255,0.06)' },
                border: { color: 'rgba(255,255,255,0.06)' }
            }
        }
    };

    function createChart(canvasId, color, fillColor, yTickCb, tooltipCb, yMax) {
        var canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        var opts = JSON.parse(JSON.stringify(chartDefaults));
        opts.scales.y.ticks.callback = yTickCb;
        opts.plugins.tooltip.callbacks = { label: tooltipCb };
        if (yMax != null) opts.scales.y.max = yMax;
        return new Chart(canvas, {
            type: 'line',
            data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: fillColor, fill: true, pointRadius: 3, pointBackgroundColor: color, pointBorderColor: color, pointHoverRadius: 5, borderWidth: 2, tension: 0.2 }] },
            options: opts
        });
    }

    var cpuChartInstance = createChart('cpu-chart', '#58a6ff', 'rgba(88,166,255,0.12)',
        function (v) { return Math.round(v) + '%'; },
        function (ctx) { return 'CPU: ' + ctx.parsed.y.toFixed(1) + '%'; }, 100);
    var ramBytesHistory = [];
    var ramChartInstance = createChart('ram-chart', '#4caf50', 'rgba(76,175,80,0.12)',
        function (v) { return Math.round(v) + '%'; },
        function (ctx) {
            var bytes = ramBytesHistory[ctx.dataIndex];
            var suffix = bytes ? ' (' + formatBytes(bytes) + ')' : '';
            return 'RAM: ' + ctx.parsed.y.toFixed(1) + '%' + suffix;
        }, 100);

    var chartsInitialized = false;

    function loadHistory(history) {
        if (!history || !history.length) return;
        var cpuLabels = [], cpuData = [], ramLabels = [], ramData = [], ramBytes = [];
        for (var i = 0; i < history.length; i++) {
            var p = history[i];
            var t = formatTime(p.timestamp);
            cpuLabels.push(t);
            cpuData.push(p.cpuPercent != null ? p.cpuPercent : 0);
            ramLabels.push(t);
            ramData.push(p.memoryPercent != null ? p.memoryPercent : 0);
            ramBytes.push(p.memoryBytes || 0);
        }
        if (cpuChartInstance) {
            cpuChartInstance.data.labels = cpuLabels;
            cpuChartInstance.data.datasets[0].data = cpuData;
            // Auto-scale CPU above 100% if needed
            var cpuPeak = Math.max.apply(null, cpuData);
            cpuChartInstance.options.scales.y.max = cpuPeak > 100 ? Math.ceil(cpuPeak * 1.1) : 100;
            cpuChartInstance.update('none');
        }
        if (ramChartInstance) {
            ramChartInstance.data.labels = ramLabels;
            ramChartInstance.data.datasets[0].data = ramData;
            ramBytesHistory = ramBytes;
            ramChartInstance.update('none');
        }
        chartsInitialized = true;
    }

    function pushChartPoint(chart, label, value) {
        if (!chart) return;
        chart.data.labels.push(label);
        chart.data.datasets[0].data.push(value);
        // Keep max 5 minutes of data (30 points at 10s)
        while (chart.data.labels.length > 30) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }
    }

    function updateCharts(stats) {
        var cpu = stats.cpuPercent != null ? stats.cpuPercent : 0;
        var memBytes = stats.memoryBytes || 0;
        var memAllocBytes = (stats.memoryAllocatedMb || memoryAllocatedMb) * 1024 * 1024;
        var memPercent = memAllocBytes > 0 ? (memBytes / memAllocBytes) * 100 : 0;
        var timeLabel = formatTime(Date.now());

        pushChartPoint(cpuChartInstance, timeLabel, cpu);
        pushChartPoint(ramChartInstance, timeLabel, memPercent);
        ramBytesHistory.push(memBytes);
        while (ramBytesHistory.length > 30) ramBytesHistory.shift();

        // Auto-scale CPU above 100% if needed
        if (cpuChartInstance) {
            var cpuPeak = Math.max.apply(null, cpuChartInstance.data.datasets[0].data);
            cpuChartInstance.options.scales.y.max = cpuPeak > 100 ? Math.ceil(cpuPeak * 1.1) : 100;
            cpuChartInstance.update();
        }
        if (ramChartInstance) ramChartInstance.update();

        if (cpuLabel) cpuLabel.textContent = cpu != null ? cpu.toFixed(1) + '%' : '--';
        if (ramLabel) {
            ramLabel.textContent = memBytes > 0
                ? memPercent.toFixed(0) + '% (' + formatBytes(memBytes) + ')'
                : '--';
        }
    }

    var cpuOffline = document.getElementById('cpu-offline');
    var ramOffline = document.getElementById('ram-offline');

    function setChartsOffline(offline) {
        if (cpuOffline) cpuOffline.style.display = offline ? 'flex' : 'none';
        if (ramOffline) ramOffline.style.display = offline ? 'flex' : 'none';
        if (cpuLabel) cpuLabel.textContent = offline ? '--' : cpuLabel.textContent;
        if (ramLabel) ramLabel.textContent = offline ? '--' : ramLabel.textContent;
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

    function updateLastStarted(state, lastStarted) {
        var running = (state === 'running');
        serverLastStarted = running && lastStarted ? lastStarted : null;
        resetUptimeTick();
    }

    function updateUptimeDisplay() {
        if (!statUptime) return;
        if (serverLastStarted) {
            var seconds = Math.max(0, Math.floor((Date.now() - new Date(serverLastStarted).getTime()) / 1000));
            statUptime.textContent = formatUptime(seconds);
        } else {
            statUptime.textContent = '--';
        }
    }

    var uptimeTickInterval = setInterval(updateUptimeDisplay, 10000);

    function resetUptimeTick() {
        clearInterval(uptimeTickInterval);
        updateUptimeDisplay();
        uptimeTickInterval = setInterval(updateUptimeDisplay, 10000);
    }

    async function fetchStats() {
        try {
            var res = await fetch('/api/servers/' + serverId + '/stats');
            if (!res.ok) return;
            var data = await res.json();
            var s = data.stats;
            var isRunning = s.state === 'running';

            if (statCpu) statCpu.textContent = isRunning && s.cpuPercent != null ? s.cpuPercent.toFixed(1) + '%' : '--';
            if (statMemory) statMemory.textContent = s.memoryFormatted || '--';
            if (statDisk) statDisk.textContent = s.diskFormatted || '--';
            updatePlayerCount(s.playerCount);

            if (!isRunning) {
                setChartsOffline(true);
                return;
            }

            setChartsOffline(false);

            // On first load, populate from DB history
            if (!chartsInitialized && data.history && data.history.length > 0) {
                loadHistory(data.history);
            } else {
                updateCharts(s);
            }
        } catch {
            // ignore
        }
    }

    // Fetch stats immediately and every 10 seconds (matches background collector interval)
    fetchStats();
    setInterval(fetchStats, 10000);

    // Start connection
    connect();
})();
