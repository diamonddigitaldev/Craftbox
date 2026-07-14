// ── Version Picker (shared by create.js and edit.js) ──
// Drives the #versionPickerModal partial. The full (all-channels) version
// list is fetched once per server type via /api/v1/versions and cached for
// the page lifetime; search and channel filtering happen client-side.
//
// Usage:
//   var picker = CraftboxVersionPicker({ onSelect: function (v) { ... } });
//   picker.open('paper', { selectedVersion, upgradeOnly, currentVersion });
//   var data = await picker.getVersions('paper');  // { versions, latest }
(function () {
    'use strict';

    // Keyed by the badge text: normalized channels plus upstream-native
    // channelLabel terms (e.g. Forge's recommended/latest).
    var BADGE_CLASSES = {
        'snapshot': 'text-bg-warning',
        'pre-release': 'text-bg-info',
        'rc': 'text-bg-primary',
        'beta': 'text-bg-secondary',
        'experimental': 'text-bg-danger',
        'recommended': 'text-bg-success',
        'latest': 'text-bg-secondary'
    };

    var TYPE_LABELS = {
        vanilla: 'Vanilla', paper: 'Paper', purpur: 'Purpur', folia: 'Folia',
        fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge'
    };

    function typeLabel(typeId) {
        return TYPE_LABELS[typeId] || (typeId.charAt(0).toUpperCase() + typeId.slice(1));
    }

    window.CraftboxVersionPicker = function (opts) {
        opts = opts || {};
        var onSelect = opts.onSelect || function () {};

        var modalEl = document.getElementById('versionPickerModal');
        if (!modalEl) return null;
        var modal = new bootstrap.Modal(modalEl);

        var subtitle = document.getElementById('vp-subtitle');
        var searchInput = document.getElementById('vp-search');
        var channelSelect = document.getElementById('vp-channel');
        var loadingEl = document.getElementById('vp-loading');
        var emptyEl = document.getElementById('vp-empty');
        var wrapEl = document.getElementById('vp-results-wrap');
        var resultsEl = document.getElementById('vp-results');
        var loadMoreBtn = document.getElementById('vp-load-more');

        var CHUNK = 200;
        var cache = {};       // typeId -> { versions, latest }
        var seq = 0;          // discard stale fetches on rapid re-opens
        var current = null;   // { typeId, options } while the modal is in use
        var filtered = [];
        var rendered = 0;
        var debounceTimer = null;

        async function getVersions(typeId) {
            if (cache[typeId]) return cache[typeId];
            var res = await apiFetch('/api/v1/versions?type=' + encodeURIComponent(typeId) + '&channel=all');
            if (!res.ok || !res.data) {
                throw new Error((res.data && res.data.error) || 'Failed to load versions.');
            }
            cache[typeId] = {
                versions: res.data.versions || [],
                latest: res.data.latest || null
            };
            return cache[typeId];
        }

        function setState(state) {
            loadingEl.classList.toggle('d-none', state !== 'loading');
            emptyEl.classList.toggle('d-none', state !== 'empty');
            wrapEl.classList.toggle('d-none', state !== 'results');
            if (state !== 'results') loadMoreBtn.classList.add('d-none');
        }

        // The eligible slice ignores the channel/search filters: on the edit
        // page (upgradeOnly) only the current version and newer are offered —
        // the API list is newest-first, so that is everything up to and
        // including the current version's index.
        function eligibleVersions() {
            var data = cache[current.typeId];
            if (!data) return { list: [], currentMissing: false };
            var o = current.options;
            if (o.upgradeOnly && o.currentVersion) {
                var idx = data.versions.findIndex(function (v) { return v.id === o.currentVersion; });
                if (idx === -1) return { list: data.versions, currentMissing: true };
                return { list: data.versions.slice(0, idx + 1), currentMissing: false };
            }
            return { list: data.versions, currentMissing: false };
        }

        function applyFilters() {
            var eligible = eligibleVersions();
            var q = searchInput.value.trim().toLowerCase();
            var ch = channelSelect.value;

            filtered = eligible.list.filter(function (v) {
                if (ch === 'stable' && v.channel !== 'stable') return false;
                if (q && v.id.toLowerCase().indexOf(q) === -1) return false;
                return true;
            });

            var label = typeLabel(current.typeId) + ' — ' +
                (filtered.length === eligible.list.length
                    ? filtered.length + (filtered.length === 1 ? ' version' : ' versions')
                    : filtered.length + ' of ' + eligible.list.length + ' versions');
            if (eligible.currentMissing) {
                label += ' · current version not in the upstream list, showing all';
            }
            subtitle.textContent = label;

            resultsEl.innerHTML = '';
            rendered = 0;
            if (filtered.length === 0) {
                setState('empty');
                return;
            }
            setState('results');
            renderChunk();
        }

        function renderChunk() {
            var end = Math.min(rendered + CHUNK, filtered.length);
            for (var i = rendered; i < end; i++) {
                resultsEl.appendChild(buildRow(filtered[i]));
            }
            rendered = end;
            loadMoreBtn.classList.toggle('d-none', rendered >= filtered.length);
        }

        function buildRow(v) {
            var tr = document.createElement('tr');

            // Version id (absorbs leftover width, ellipsizes on narrow screens)
            var tdName = document.createElement('td');
            tdName.className = 'mr-primary-cell';
            var name = document.createElement('div');
            name.className = 'fw-semibold text-truncate';
            name.textContent = v.id;
            tdName.appendChild(name);
            tr.appendChild(tdName);

            // Channel badge — upstream-native label when the provider supplies
            // one (Forge: recommended/latest), otherwise the normalized channel.
            // Unlabeled stable rows carry no badge (absence means stable).
            var tdBadge = document.createElement('td');
            var badgeText = v.channelLabel || (v.channel !== 'stable' ? v.channel : null);
            if (badgeText) {
                var badge = document.createElement('span');
                badge.className = 'badge ' + (BADGE_CLASSES[badgeText] || BADGE_CLASSES[v.channel] || 'text-bg-secondary');
                badge.textContent = badgeText;
                tdBadge.appendChild(badge);
            }
            tr.appendChild(tdBadge);

            // Select button (or a disabled marker on the already-chosen row)
            var tdAction = document.createElement('td');
            tdAction.className = 'text-end';
            var btn = document.createElement('button');
            btn.type = 'button';
            if (current.options.selectedVersion === v.id) {
                btn.className = 'btn btn-outline-success btn-sm d-inline-flex align-items-center gap-1';
                btn.disabled = true;
                btn.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">check</span>Selected';
            } else {
                btn.className = 'btn btn-success btn-sm d-inline-flex align-items-center gap-1';
                btn.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">arrow_forward</span>Select';
                btn.addEventListener('click', function () {
                    // Let the picker finish closing before handing off — the edit
                    // page opens its confirm modal from onSelect, and overlapping
                    // modal animations corrupt the backdrop.
                    modalEl.addEventListener('hidden.bs.modal', function () {
                        onSelect(v);
                    }, { once: true });
                    modal.hide();
                });
            }
            tdAction.appendChild(btn);
            tr.appendChild(tdAction);

            return tr;
        }

        async function open(typeId, options) {
            current = { typeId: typeId, options: options || {} };
            searchInput.value = '';
            channelSelect.value = 'stable';
            subtitle.textContent = typeLabel(typeId);
            modal.show();

            var mySeq = ++seq;
            setState('loading');
            var data;
            try {
                data = await getVersions(typeId);
            } catch {
                if (mySeq !== seq) return;
                setState('empty');
                showToast('Failed to load versions.', 'danger');
                return;
            }
            if (mySeq !== seq) return;

            // A server already on a non-stable version would otherwise open to a
            // filtered list that hides its own current version.
            var sel = current.options.selectedVersion;
            if (sel) {
                var entry = data.versions.find(function (v) { return v.id === sel; });
                if (entry && entry.channel !== 'stable') channelSelect.value = 'all';
            }

            applyFilters();
        }

        searchInput.addEventListener('input', function () {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function () {
                if (current && cache[current.typeId]) applyFilters();
            }, 150);
        });

        channelSelect.addEventListener('change', function () {
            if (current && cache[current.typeId]) applyFilters();
        });

        loadMoreBtn.addEventListener('click', renderChunk);

        return { open: open, getVersions: getVersions };
    };
})();
