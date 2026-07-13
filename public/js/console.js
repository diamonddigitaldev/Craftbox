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
    const navHeader = document.getElementById('server-nav-header');

    // Visual state metadata comes from window.CraftboxState (injected by
    // head.ejs from src/utils/serverStateMeta.js — single source of truth).
    const stateColors = (window.CraftboxState || {}).stateColors || {};
    const stateIcons = (window.CraftboxState || {}).stateIcons || {};
    const stateDisplayNames = (window.CraftboxState || {}).stateDisplayNames || {};
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

                case 'operation':
                    if (msg.serverId === serverId) {
                        document.dispatchEvent(new CustomEvent('craftbox:operation', { detail: msg }));
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

        // Update data-state on parent for CSS animations
        if (navHeader) navHeader.dataset.state = state;

        // Update badge
        if (stateBadge) {
            const color = stateColors[state] || 'secondary';
            stateBadge.className = `badge bg-${color} d-flex align-items-center gap-1 server-state-badge`;
        }
        if (stateText) {
            stateText.textContent = stateDisplayNames[state] || state.charAt(0).toUpperCase() + state.slice(1);
        }
        if (stateIcon) {
            stateIcon.textContent = stateIcons[state] || 'help';
        }

        // Update button states
        document.querySelectorAll('.server-action-btn').forEach(btn => {
            const action = btn.dataset.action;
            if (actionStates[action]) {
                btn.disabled = !actionStates[action].includes(state);
            } else if (action === 'delete') {
                btn.disabled = !['stopped', 'crashed'].includes(state);
            }
        });

        // Update console input and send button
        if (input) {
            input.disabled = state !== 'running';
        }
        if (sendBtn) {
            sendBtn.disabled = state !== 'running' || !input.value.trim();
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
                // A failed create/modpack provision is handled by the blocking
                // "Server Setup Failed" modal + auto-delete, not the crash
                // banner. Driving this off state (not the 'operation' event)
                // means the initial 'subscribed' snapshot triggers it too, so
                // a fast failure that beat the WebSocket subscription still
                // shows the modal live — no manual reload needed.
                if (crashReason && (
                    crashReason.indexOf('Provisioning failed') === 0 ||
                    crashReason.indexOf('Modpack install failed') === 0
                )) {
                    crashBanner.style.display = 'none';
                    showProvisionFailedModal(crashReason.replace(/^(Provisioning failed|Modpack install failed): /, ''));
                    return;
                }
                var autoRestartEl = document.getElementById('autoRestart');
                var autoRestart = autoRestartEl ? autoRestartEl.checked : false;
                if (crashReason && (
                    crashReason.indexOf('Provisioning failed') === 0 ||
                    crashReason.indexOf('Duplication failed') === 0 ||
                    crashReason.indexOf('Jar update interrupted') === 0 ||
                    crashReason.indexOf('Provisioning interrupted') === 0 ||
                    crashReason.indexOf('Modpack install failed') === 0
                )) {
                    crashText.textContent = crashReason;
                } else {
                    var reasonText = crashReason === 'oom'
                        ? ' due to Out of Memory'
                        : '';
                    var exitText = exitCode != null
                        ? ' Exit code: <strong>' + exitCode + '</strong>.'
                        : '';
                    crashText.innerHTML = 'Server crashed' + reasonText + '.' + exitText
                        + (autoRestart ? ' Auto-restart is enabled.' : '');
                }
                crashBanner.style.display = 'flex';
            } else {
                crashBanner.style.display = 'none';
            }
        }

        // Show/hide operation banner
        const opBanner = document.getElementById('operation-banner');
        const opText = document.getElementById('operation-banner-text');
        if (opBanner && opText) {
            var opMessages = {
                provisioning: 'Running first-time setup for this server...',
                updating_jar: 'Downloading the latest server jar build...',
                backing_up: 'Creating a backup of the server files...',
                restoring: 'Restoring server files from a backup...'
            };
            if (opMessages[state]) {
                opText.textContent = opMessages[state];
                opBanner.style.display = 'flex';
            } else {
                opBanner.style.display = 'none';
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

    // ── Server action buttons (start/stop/restart/kill/delete) ──
    async function doAction(action, body) {
        var labels = {
            start: { title: 'Starting server...', desc: 'Please wait while the command is sent.' },
            stop: { title: 'Stopping server...', desc: 'Please wait while the command is sent.' },
            restart: { title: 'Restarting server...', desc: 'Please wait while the command is sent.' },
            kill: { title: 'Killing server...', desc: 'Please wait while the command is sent.' }
        };
        if (labels[action]) showOverlay(labels[action].title, labels[action].desc);

        var res = await apiFetch('/api/v1/servers/' + serverId + '/' + action, {
            method: 'POST',
            body: body || {}
        });
        hideOverlay();
        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || ('Failed to ' + action + '.'), 'danger');
            return;
        }
        showToast((res.data && res.data.message) || ('Server ' + action + ' requested.'), 'success');
        // State updates arrive via WebSocket.
    }

    const killModalEl = document.getElementById('killModal');
    const deleteModalEl = document.getElementById('deleteModal');
    const killModal = killModalEl ? new bootstrap.Modal(killModalEl) : null;
    const deleteModal = deleteModalEl ? new bootstrap.Modal(deleteModalEl) : null;

    document.querySelectorAll('.server-action-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var action = btn.dataset.action;
            if (action === 'kill' && killModal) { killModal.show(); return; }
            if (action === 'delete' && deleteModal) { deleteModal.show(); return; }
            doAction(action);
        });
    });

    var confirmKillBtn = document.getElementById('confirm-kill');
    if (confirmKillBtn && killModal) {
        confirmKillBtn.addEventListener('click', function () {
            killModal.hide();
            doAction('kill');
        });
    }

    var confirmDeleteBtn = document.getElementById('confirm-delete');
    if (confirmDeleteBtn && deleteModal) {
        confirmDeleteBtn.addEventListener('click', async function () {
            deleteModal.hide();
            showOverlay('Deleting server...', 'Removing all files. This may take a moment.');
            var res = await apiFetch('/api/v1/servers/' + serverId, { method: 'DELETE' });
            if (!res.ok) {
                hideOverlay();
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to delete server.', 'danger');
                return;
            }
            flashToast('Server deleted.', 'success');
            window.location.href = '/dashboard';
        });
    }

    // Toggle helpers for auto-restart and auto-start
    function bindToggle(id, endpoint, friendlyName) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', async () => {
            var res = await apiFetch('/api/v1/servers/' + serverId + '/' + endpoint, {
                method: 'POST',
                body: { enabled: el.checked }
            });
            if (!res.ok) {
                el.checked = !el.checked;
                showToast('Failed to update ' + friendlyName + '.', 'danger');
                return;
            }
            showToast(friendlyName.charAt(0).toUpperCase() + friendlyName.slice(1) + ' ' + (el.checked ? 'enabled.' : 'disabled.'), 'success');
        });
    }
    bindToggle('autoRestart', 'autorestart', 'auto-restart');
    bindToggle('autoStart', 'autostart', 'auto-start');

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
            var ramPeak = Math.max.apply(null, ramData);
            ramChartInstance.options.scales.y.max = ramPeak > 100 ? Math.ceil(ramPeak * 1.1) : 100;
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
        if (ramChartInstance) {
            var ramPeak = Math.max.apply(null, ramChartInstance.data.datasets[0].data);
            ramChartInstance.options.scales.y.max = ramPeak > 100 ? Math.ceil(ramPeak * 1.1) : 100;
            ramChartInstance.update();
        }

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
            var res = await fetch('/api/v1/servers/' + serverId + '/stats');
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
    var statsInterval = setInterval(fetchStats, 10000);

    // ── Provisioning progress & failure ──
    // While the server is provisioning from a modpack, per-phase progress
    // arrives over the 'modpack-install' operation and refines the generic
    // provisioning banner text. A failed create/modpack provision surfaces as
    // a blocking modal whose only exit is the dashboard — shown live here when
    // the page is already open, or from the server-rendered flag on load when
    // the failure happened before the page finished loading.
    var modpackPhaseText = {
        download: 'Downloading the modpack...',
        parse: 'Reading the modpack manifest...',
        loader: 'Installing the mod loader server...',
        files: 'Downloading modpack files...',
        overrides: 'Unpacking the modpack\'s bundled files...',
        finalize: 'Finishing up...'
    };

    var provisionFailedHandled = false;
    function showProvisionFailedModal(reason) {
        if (provisionFailedHandled) return;
        provisionFailedHandled = true;

        var opBanner = document.getElementById('operation-banner');
        if (opBanner) opBanner.style.display = 'none';
        clearInterval(statsInterval); // the record is about to be deleted

        var modalEl = document.getElementById('provisionFailedModal');
        var reasonEl = document.getElementById('provision-failed-reason');
        // reason is null when the page rendered the text server-side already
        if (reasonEl && reason) reasonEl.textContent = reason;
        if (modalEl) {
            bootstrap.Modal.getOrCreateInstance(modalEl).show();
        } else {
            showToast('Server setup failed: ' + (reason || 'Unknown error'), 'danger');
        }

        // Clean up the useless half-built server now that the user has been
        // told why. "Back to Dashboard" just navigates; the delete is here so
        // nothing is left behind even if they close the tab afterwards.
        apiFetch('/api/v1/servers/' + serverId, { method: 'DELETE' });
    }

    document.addEventListener('craftbox:operation', function (e) {
        var op = e.detail;
        if (!op) return;

        if (op.operation === 'modpack-install' && op.status === 'progress') {
            var opText = document.getElementById('operation-banner-text');
            if (!opText) return;
            var p = op.payload || {};
            // The mod counter keeps updating through the overrides phase, so it
            // takes the banner back off the overrides text as those mods land.
            if (p.phase === 'files' && p.total > 0) {
                opText.textContent = 'Installing mods (' + (p.done || 0) + '/' + p.total + ')...';
            } else if (modpackPhaseText[p.phase]) {
                opText.textContent = modpackPhaseText[p.phase];
            }
        } else if (op.operation === 'modpack-install' && op.status === 'complete') {
            showToast('Modpack installed successfully.', 'success');
        } else if ((op.operation === 'create' || op.operation === 'modpack-install') && op.status === 'failed') {
            showProvisionFailedModal(op.error || 'Unknown error');
        }
    });

    // Failure that happened before this page loaded — the reason is already
    // rendered into the modal server-side, so show it straight away.
    var provisionFailedModalEl = document.getElementById('provisionFailedModal');
    if (provisionFailedModalEl && provisionFailedModalEl.dataset.autoShow === 'true') {
        showProvisionFailedModal(null);
    }

    // Start connection
    connect();
})();
