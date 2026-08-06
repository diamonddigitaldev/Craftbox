(function () {
    // Event type filter navigation
    var filterSelect = document.getElementById('event-type-filter');
    if (filterSelect) {
        var serverId = filterSelect.dataset.serverId;
        filterSelect.addEventListener('change', function () {
            window.location.href = this.value
                ? '/servers/' + serverId + '/events?type=' + this.value
                : '/servers/' + serverId + '/events';
        });
    }

    // Format event timestamps as an absolute date/time followed by its relative
    // age — "08/03/2026, 14:05:09 (5m ago)". formatDate is the same helper the
    // backups, files, plugins and account pages use, so the absolute half reads
    // identically across the panel.
    function refreshEventTimes() {
        document.querySelectorAll('.event-time').forEach(function (el) {
            if (!el.dataset.time) return;
            var time = new Date(el.dataset.time);
            el.textContent = formatDate(el.dataset.time) + ' (' + timeAgo(time) + ')';
        });
    }
    refreshEventTimes();
    // Re-tick every 30s so the relative half stays honest on a long-open tab.
    setInterval(refreshEventTimes, 30000);

    // ── Live event rows ──
    // The server pushes every logged event to this page's WebSocket (see
    // utils/eventLogger). Rows are built here to match what the view renders,
    // using the same badge/icon map, which the view hands over as JSON so the
    // vocabulary stays defined in exactly one place.
    var tbody = document.getElementById('events-tbody');
    var emptyCard = document.getElementById('events-empty');
    var eventsCard = document.getElementById('events-card');
    var countBadge = document.getElementById('event-count');
    var clearFormEl = document.getElementById('clear-events-form');

    if (tbody) {
        var eventMeta = {};
        var fallbackMeta = { icon: 'info', color: 'text-body-secondary', badge: 'secondary', label: null };
        try { eventMeta = JSON.parse(tbody.dataset.eventMeta || '{}'); } catch (_) { /* keep defaults */ }
        try { fallbackMeta = JSON.parse(tbody.dataset.fallbackMeta || 'null') || fallbackMeta; } catch (_) { /* keep defaults */ }

        var activeFilter = tbody.dataset.typeFilter || '';
        var maxRows = parseInt(tbody.dataset.maxRows, 10) || 500;

        function metaFor(type) {
            return Object.prototype.hasOwnProperty.call(eventMeta, type) ? eventMeta[type] : fallbackMeta;
        }

        // Icon shown next to the actor, mirroring the view's ternary.
        function actorIcon(initiatedBy) {
            if (initiatedBy === 'Backup Scheduler') return 'schedule';
            if (initiatedBy === 'Auto Start') return 'play_circle';
            return 'person';
        }

        function cell(html) {
            var td = document.createElement('td');
            td.innerHTML = html;
            return td;
        }

        function buildRow(evt) {
            var meta = metaFor(evt.type);
            var row = document.createElement('tr');

            var icon = document.createElement('td');
            icon.className = 'text-center';
            var iconSpan = document.createElement('span');
            iconSpan.className = 'material-icons-outlined ' + meta.color;
            iconSpan.style.fontSize = '1.1rem';
            iconSpan.textContent = meta.icon;
            icon.appendChild(iconSpan);
            row.appendChild(icon);

            var badgeTd = document.createElement('td');
            var badge = document.createElement('span');
            badge.className = 'badge bg-' + meta.badge;
            badge.style.fontSize = '0.75rem';
            badge.textContent = meta.label || evt.type;
            badgeTd.appendChild(badge);
            row.appendChild(badgeTd);

            var msg = document.createElement('td');
            msg.textContent = evt.message || '';
            row.appendChild(msg);

            // Same three branches as the view: named actor, player, or System.
            var by = document.createElement('td');
            if (evt.initiatedBy && evt.initiatedBy !== 'System') {
                by.appendChild(actorSpan(actorIcon(evt.initiatedBy), evt.initiatedBy));
            } else if (evt.playerName) {
                by.appendChild(actorSpan('sports_esports', evt.playerName));
            } else {
                var sys = document.createElement('span');
                sys.className = 'text-body-secondary';
                sys.style.fontSize = '0.85rem';
                sys.textContent = 'System';
                by.appendChild(sys);
            }
            row.appendChild(by);

            var timeTd = document.createElement('td');
            var time = document.createElement('small');
            time.className = 'text-body-secondary text-nowrap event-time';
            time.dataset.time = evt.createdAt;
            time.textContent = evt.createdAt;
            timeTd.appendChild(time);
            row.appendChild(timeTd);

            return row;
        }

        function actorSpan(iconName, text) {
            var wrap = document.createElement('span');
            wrap.className = 'd-flex align-items-center gap-1';
            wrap.style.fontSize = '0.85rem';
            var i = document.createElement('span');
            i.className = 'material-icons-outlined';
            i.style.fontSize = '0.9rem';
            i.textContent = iconName;
            wrap.appendChild(i);
            wrap.appendChild(document.createTextNode(' ' + text));
            return wrap;
        }

        function addEvent(evt) {
            // A filtered view only shows its own type; anything else would
            // silently contradict the dropdown.
            if (activeFilter && evt.type !== activeFilter) return;

            tbody.insertBefore(buildRow(evt), tbody.firstChild);

            // The log is capped server-side at 500; drop the oldest rows so the
            // page can't grow past it either.
            while (tbody.children.length > maxRows) {
                tbody.removeChild(tbody.lastElementChild);
            }

            if (emptyCard) emptyCard.classList.add('d-none');
            if (eventsCard) eventsCard.classList.remove('d-none');
            if (clearFormEl) clearFormEl.classList.remove('d-none');
            if (countBadge) countBadge.textContent = String(tbody.children.length);

            refreshEventTimes();
        }

        document.addEventListener('craftbox:event', function (e) {
            var msg = e.detail || {};
            addEvent({
                type: msg.eventType,
                message: msg.message,
                createdAt: msg.createdAt,
                initiatedBy: msg.initiatedBy,
                playerName: msg.playerName
            });
        });

        // The log was wiped elsewhere (or in another tab) — reflect it here.
        document.addEventListener('craftbox:events-cleared', function () {
            tbody.innerHTML = '';
            if (eventsCard) eventsCard.classList.add('d-none');
            if (emptyCard) emptyCard.classList.remove('d-none');
            if (clearFormEl) clearFormEl.classList.add('d-none');
            if (countBadge) countBadge.textContent = '0';
        });
    }

    // Clear events: modal confirmation + overlay
    var clearForm = document.getElementById('clear-events-form');
    var clearModalEl = document.getElementById('clearEventsModal');
    if (clearForm && clearModalEl) {
        var clearModal = new bootstrap.Modal(clearModalEl);
        clearForm.addEventListener('submit', function (e) {
            e.preventDefault();
            clearModal.show();
        });
        document.getElementById('confirm-clear').addEventListener('click', async function () {
            var btn = this;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Clearing...';
            clearModal.hide();
            showOverlay('Clearing events...', 'Deleting all logged events for this server.');

            var serverId = clearForm.dataset.serverId;
            var res = await apiFetch('/api/v1/servers/' + serverId + '/events/clear', { method: 'POST', body: {} });
            if (!res.ok) {
                hideOverlay();
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to clear events.', 'danger');
                btn.disabled = false;
                btn.textContent = 'Clear Events';
                return;
            }
            flashToast('Events cleared.', 'success');
            window.location.reload();
        });
    }
})();
