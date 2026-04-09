// Public status page WebSocket client for live server state updates.
// Connects to /ws/status (unauthenticated) and receives only safe states:
// stopped, crashed, starting, running, stopping.
(function () {
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
    var stateOrder = { running: 0, starting: 1, backing_up: 2, restoring: 3, stopping: 4, crashed: 5, stopped: 6 };

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

    // Collect all server IDs on the page
    function getServerIds() {
        var cards = document.querySelectorAll('[data-server-id]');
        var ids = [];
        cards.forEach(function (el) {
            var id = el.dataset.serverId;
            if (id && ids.indexOf(id) === -1) ids.push(id);
        });
        return ids;
    }

    var serverIds = getServerIds();
    if (serverIds.length === 0) return;

    // Track lastStarted per server for client-side uptime ticking
    var serverStartTimes = {}; // serverId -> ISO string or null

    var ws = null;
    var reconnectAttempts = 0;

    function connect() {
        var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(protocol + '//' + location.host + '/ws/status');

        ws.onopen = function () {
            reconnectAttempts = 0;
            serverIds.forEach(function (id) {
                ws.send(JSON.stringify({ type: 'subscribe', serverId: id }));
            });
        };

        ws.onmessage = function (event) {
            var msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }

            if (msg.type === 'subscribed' && msg.serverId) {
                updateServerState(msg.serverId, msg.state);
                updateLastStarted(msg.serverId, msg.state, msg.lastStarted);
                if (typeof msg.playerCount === 'number') {
                    updatePlayers(msg.serverId, msg.playerCount, msg.players || []);
                }
            }
            if (msg.type === 'state' && msg.serverId) {
                updateServerState(msg.serverId, msg.state);
                updateLastStarted(msg.serverId, msg.state, msg.lastStarted);
            }
            if (msg.type === 'players' && msg.serverId) {
                updatePlayers(msg.serverId, msg.count, msg.players || []);
            }
            if (msg.type === 'event' && msg.serverId) {
                addEvent(msg.eventType, msg.message, msg.createdAt);
            }
            if (msg.type === 'events_cleared' && msg.serverId) {
                clearEvents();
            }
        };

        ws.onclose = function () {
            reconnectAttempts++;
            var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            setTimeout(connect, delay);
        };

        ws.onerror = function () {};
    }

    function updateServerState(serverId, state) {
        var color = stateColors[state] || 'secondary';
        var icon = stateIcons[state] || 'help';
        var displayName = stateDisplayNames[state] || state.charAt(0).toUpperCase() + state.slice(1);

        // Update all elements with this server ID (covers both list and detail pages)
        document.querySelectorAll('[data-server-id="' + serverId + '"]').forEach(function (el) {
            // Update card border
            el.className = el.className.replace(/border-\w+/g, '') + ' border-' + color;

            // Update data-state for CSS animations
            el.dataset.state = state;

            // Update badge
            var badge = el.querySelector('.status-badge');
            if (badge) {
                badge.className = badge.className.replace(/bg-\w+/g, '') + ' bg-' + color;
                var iconEl = badge.querySelector('.status-icon');
                if (iconEl) iconEl.textContent = icon;
                var textEl = badge.querySelector('.status-text');
                if (textEl) textEl.textContent = displayName;
            }
        });

        // Re-sort status cards on list page
        sortStatusCards();
    }

    function sortStatusCards() {
        var grid = document.querySelector('.row.justify-content-center');
        if (!grid) return;
        var cards = Array.from(grid.querySelectorAll(':scope > .col-md-6'));
        if (cards.length < 2) return;

        cards.sort(function (a, b) {
            var elA = a.querySelector('[data-server-id]');
            var elB = b.querySelector('[data-server-id]');
            var stateA = elA ? elA.dataset.state || '' : '';
            var stateB = elB ? elB.dataset.state || '' : '';
            var orderA = stateOrder[stateA] !== undefined ? stateOrder[stateA] : 99;
            var orderB = stateOrder[stateB] !== undefined ? stateOrder[stateB] : 99;
            if (orderA !== orderB) return orderA - orderB;
            var nameA = (a.querySelector('.card-title') || {}).textContent || '';
            var nameB = (b.querySelector('.card-title') || {}).textContent || '';
            return nameA.localeCompare(nameB);
        });

        cards.forEach(function (card) {
            grid.appendChild(card);
        });
    }

    var eventIcons = { started: 'play_circle', stopped: 'stop_circle', crashed: 'error', restarted: 'restart_alt' };
    var eventColorClasses = { started: 'text-success', stopped: 'text-secondary', crashed: 'text-danger', restarted: 'text-info' };
    var MAX_EVENTS = 20;

    function addEvent(eventType, message, createdAt) {
        // Only works on the individual server status page
        var container = document.getElementById('events-list');
        if (!container) {
            // No list yet — replace "No recent events." placeholder
            var placeholder = document.getElementById('events-empty');
            if (!placeholder) return;
            container = document.createElement('div');
            container.className = 'list-group list-group-flush';
            container.id = 'events-list';
            placeholder.parentNode.replaceChild(container, placeholder);
        }

        var item = document.createElement('div');
        item.className = 'list-group-item bg-transparent border-0 px-0 py-2 d-flex align-items-center gap-2';

        var iconSpan = document.createElement('span');
        iconSpan.className = 'material-icons-outlined ' + (eventColorClasses[eventType] || 'text-body-secondary');
        iconSpan.style.fontSize = '1.1rem';
        iconSpan.textContent = eventIcons[eventType] || 'info';

        var body = document.createElement('div');
        body.className = 'flex-grow-1';
        var msgSpan = document.createElement('span');
        msgSpan.textContent = message;
        body.appendChild(msgSpan);

        var timeEl = document.createElement('small');
        timeEl.className = 'text-body-secondary text-nowrap event-time';
        timeEl.dataset.time = createdAt;
        timeEl.textContent = timeAgo(new Date(createdAt));
        timeEl.title = new Date(createdAt).toLocaleString();

        item.appendChild(iconSpan);
        item.appendChild(body);
        item.appendChild(timeEl);

        container.insertBefore(item, container.firstChild);

        // Trim to max events
        while (container.children.length > MAX_EVENTS) {
            container.removeChild(container.lastChild);
        }
    }

    function clearEvents() {
        var container = document.getElementById('events-list');
        if (!container) return;
        var placeholder = document.createElement('p');
        placeholder.className = 'text-body-secondary mb-0';
        placeholder.id = 'events-empty';
        placeholder.textContent = 'No recent events.';
        container.parentNode.replaceChild(placeholder, container);
    }

    function updatePlayers(serverId, count, players) {
        document.querySelectorAll('[data-server-id="' + serverId + '"]').forEach(function (el) {
            var playersEl = el.querySelector('.status-players');
            if (playersEl) playersEl.textContent = count;
        });

        // Update player name list on individual server status page
        var headingCount = document.querySelector('.status-players-heading-count');
        if (headingCount) headingCount.textContent = count;

        var card = document.querySelector('.status-players-card');
        var list = document.querySelector('.status-players-list');
        if (card && list) {
            if (players.length === 0) {
                card.classList.add('d-none');
            } else {
                card.classList.remove('d-none');
                list.innerHTML = '';
                players.sort(function (a, b) { return a.localeCompare(b); });
                players.forEach(function (name) {
                    var badge = document.createElement('span');
                    badge.className = 'badge bg-body-secondary text-body d-flex align-items-center gap-1';
                    badge.innerHTML = '<span class="material-icons-outlined" style="font-size: 0.9rem;">person</span>';
                    badge.appendChild(document.createTextNode(' ' + name));
                    list.appendChild(badge);
                });
            }
        }
    }

    function updateLastStarted(serverId, state, lastStarted) {
        var running = (state === 'running');
        serverStartTimes[serverId] = running && lastStarted ? lastStarted : null;
        resetUptimeTick();
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

    function updateUptimeDisplay(serverId) {
        var startTime = serverStartTimes[serverId];
        var text = 'Offline';
        if (startTime) {
            var seconds = Math.max(0, Math.floor((Date.now() - new Date(startTime).getTime()) / 1000));
            text = formatUptime(seconds);
        }
        document.querySelectorAll('[data-server-id="' + serverId + '"]').forEach(function (el) {
            var uptimeEl = el.querySelector('.status-uptime');
            if (uptimeEl) uptimeEl.textContent = text;
        });
    }

    // Tick all uptime displays every 10 seconds, resettable on state change
    var uptimeTickInterval = setInterval(uptimeTick, 10000);

    function uptimeTick() {
        serverIds.forEach(function (id) {
            updateUptimeDisplay(id);
        });
    }

    function resetUptimeTick() {
        clearInterval(uptimeTickInterval);
        uptimeTick();
        uptimeTickInterval = setInterval(uptimeTick, 10000);
    }

    connect();
})();
