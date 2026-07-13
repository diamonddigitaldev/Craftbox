// Modpack browser — searches Modrinth through the /api/v1/modrinth proxy
// (CSP connect-src 'self' forbids talking to Modrinth directly).
(function () {
    'use strict';

    var PAGE_SIZE = 18; // divisible by 2 and 3 so both grid widths fill evenly
    var MAX_OFFSET = 10000; // Modrinth caps search pagination
    var LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };

    // ── DOM refs ──
    var searchInput = document.getElementById('search-input');
    var loaderFilter = document.getElementById('loader-filter');
    var versionFilter = document.getElementById('version-filter');
    var sortSelect = document.getElementById('sort-select');
    var loadingEl = document.getElementById('results-loading');
    var emptyEl = document.getElementById('results-empty');
    var emptyTitle = document.getElementById('results-empty-title');
    var emptyText = document.getElementById('results-empty-text');
    var grid = document.getElementById('results-grid');
    var pagination = document.getElementById('pagination');
    var prevBtn = document.getElementById('prev-btn');
    var nextBtn = document.getElementById('next-btn');
    var pageInfo = document.getElementById('page-info');

    var versionModalEl = document.getElementById('packVersionModal');
    var versionModal = new bootstrap.Modal(versionModalEl);
    var packModalTitle = document.getElementById('pack-modal-title');
    var packVersionsLoading = document.getElementById('pack-versions-loading');
    var packVersionsEmpty = document.getElementById('pack-versions-empty');
    var packVersionsWrap = document.getElementById('pack-versions-wrap');
    var packVersionsTbody = document.getElementById('pack-versions-tbody');

    // ── State (restored from the URL so back-navigation returns to results) ──
    var params = new URLSearchParams(window.location.search);
    // Modrinth caps search pagination at MAX_OFFSET — the deepest reachable
    // page is the one whose offset still fits under the cap.
    var LAST_PAGE = Math.floor(MAX_OFFSET / PAGE_SIZE) + 1;
    var state = {
        query: params.get('q') || '',
        loader: params.get('loader') || '',
        gameVersion: params.get('mc') || '',
        index: params.get('sort') || 'relevance',
        offset: Math.min(Math.max(0, (parseInt(params.get('page'), 10) - 1 || 0)), LAST_PAGE - 1) * PAGE_SIZE
    };
    var totalHits = 0;
    var searchSeq = 0; // ignore out-of-order responses

    searchInput.value = state.query;
    loaderFilter.value = state.loader;
    sortSelect.value = state.index;

    function compactNumber(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n || 0);
    }

    function syncUrl() {
        var p = new URLSearchParams();
        if (state.query) p.set('q', state.query);
        if (state.loader) p.set('loader', state.loader);
        if (state.gameVersion) p.set('mc', state.gameVersion);
        if (state.index !== 'relevance') p.set('sort', state.index);
        var page = Math.floor(state.offset / PAGE_SIZE) + 1;
        if (page > 1) p.set('page', String(page));
        var qs = p.toString();
        history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
    }

    function show(el) { el.classList.remove('d-none'); }
    function hide(el) { el.classList.add('d-none'); }

    // ── Search ──
    async function runSearch() {
        var seq = ++searchSeq;
        hide(grid);
        hide(emptyEl);
        hide(pagination);
        show(loadingEl);

        var p = new URLSearchParams();
        p.set('projectType', 'modpack');
        if (state.query) p.set('query', state.query);
        if (state.loader) p.set('loader', state.loader);
        if (state.gameVersion) p.set('gameVersion', state.gameVersion);
        p.set('index', state.index);
        p.set('offset', String(state.offset));
        p.set('limit', String(PAGE_SIZE));

        var res = await apiFetch('/api/v1/modrinth/search?' + p.toString());
        if (seq !== searchSeq) return; // a newer search superseded this one
        hide(loadingEl);

        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to search Modrinth.', 'danger');
            emptyTitle.textContent = 'Search failed';
            emptyText.textContent = 'Modrinth could not be reached. Try again in a moment.';
            show(emptyEl);
            return;
        }

        totalHits = res.data.totalHits || 0;
        var hits = res.data.hits || [];
        if (hits.length === 0) {
            emptyTitle.textContent = 'No modpacks found';
            emptyText.textContent = 'Try a different search or loosen the filters.';
            show(emptyEl);
            return;
        }

        renderHits(hits);
        show(grid);
        updatePagination();
        show(pagination);
    }

    function renderHits(hits) {
        grid.innerHTML = '';
        hits.forEach(function (hit) {
            grid.appendChild(buildCard(hit));
        });
    }

    // All Modrinth-sourced strings are set via textContent — never innerHTML.
    function buildCard(hit) {
        var col = document.createElement('div');
        col.className = 'col-md-6 col-xl-4';

        var card = document.createElement('div');
        card.className = 'card modpack-card h-100 border-secondary';
        card.setAttribute('role', 'button');
        card.addEventListener('click', function () {
            openVersionModal(hit.projectId, hit.title);
        });

        var body = document.createElement('div');
        body.className = 'card-body d-flex flex-column gap-2';

        // Icon + title + author
        var header = document.createElement('div');
        header.className = 'd-flex align-items-center gap-2';
        header.appendChild(buildIcon(hit.iconUrl, 'modpack-icon'));

        var titleWrap = document.createElement('div');
        titleWrap.className = 'overflow-hidden';
        var titleEl = document.createElement('div');
        titleEl.className = 'fw-semibold text-truncate';
        titleEl.textContent = hit.title || '(untitled)';
        var authorEl = document.createElement('small');
        authorEl.className = 'text-body-secondary text-truncate d-block';
        authorEl.textContent = hit.author ? 'by ' + hit.author : '';
        titleWrap.appendChild(titleEl);
        titleWrap.appendChild(authorEl);
        header.appendChild(titleWrap);
        body.appendChild(header);

        // Description (2-line clamp)
        var desc = document.createElement('div');
        desc.className = 'text-body-secondary small modpack-desc flex-grow-1';
        desc.textContent = hit.description || '';
        body.appendChild(desc);

        // Footer: downloads + loader badges
        var footer = document.createElement('div');
        footer.className = 'd-flex align-items-center gap-2';

        var downloads = document.createElement('span');
        downloads.className = 'text-body-secondary small d-flex align-items-center gap-1';
        var dlIcon = document.createElement('span');
        dlIcon.className = 'material-icons-outlined';
        dlIcon.style.fontSize = '1rem';
        dlIcon.textContent = 'download';
        downloads.appendChild(dlIcon);
        downloads.appendChild(document.createTextNode(compactNumber(hit.downloads)));
        footer.appendChild(downloads);

        var badges = document.createElement('span');
        badges.className = 'ms-auto d-flex gap-1';
        (hit.categories || []).forEach(function (cat) {
            if (!LOADER_NAMES[cat]) return;
            var badge = document.createElement('span');
            badge.className = 'badge text-bg-secondary';
            badge.textContent = LOADER_NAMES[cat];
            badges.appendChild(badge);
        });
        footer.appendChild(badges);
        body.appendChild(footer);

        card.appendChild(body);
        col.appendChild(card);
        return col;
    }

    function buildIcon(iconUrl, sizeClass) {
        if (iconUrl) {
            var img = document.createElement('img');
            img.className = sizeClass;
            img.alt = '';
            img.addEventListener('error', function () {
                img.replaceWith(buildIconPlaceholder(sizeClass));
            });
            img.src = iconUrl;
            return img;
        }
        return buildIconPlaceholder(sizeClass);
    }

    function buildIconPlaceholder(sizeClass) {
        var ph = document.createElement('span');
        ph.className = sizeClass + ' modpack-icon-placeholder';
        var icon = document.createElement('span');
        icon.className = 'material-icons-outlined';
        icon.textContent = 'widgets';
        ph.appendChild(icon);
        return ph;
    }

    function updatePagination() {
        var page = Math.floor(state.offset / PAGE_SIZE) + 1;
        // Never advertise pages beyond Modrinth's offset cap — they can't be fetched
        var totalPages = Math.max(1, Math.min(Math.ceil(totalHits / PAGE_SIZE), LAST_PAGE));
        pageInfo.textContent = 'Page ' + page + ' of ' + totalPages;
        prevBtn.disabled = state.offset <= 0;
        nextBtn.disabled = page >= totalPages;
    }

    prevBtn.addEventListener('click', function () {
        state.offset = Math.max(0, state.offset - PAGE_SIZE);
        syncUrl();
        runSearch();
    });
    nextBtn.addEventListener('click', function () {
        state.offset += PAGE_SIZE;
        syncUrl();
        runSearch();
    });

    // ── Filter wiring ──
    var debounceTimer = null;
    searchInput.addEventListener('input', function () {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
            state.query = searchInput.value.trim();
            state.offset = 0;
            syncUrl();
            runSearch();
        }, 400);
    });

    function onFilterChange() {
        state.loader = loaderFilter.value;
        state.gameVersion = versionFilter.value;
        state.index = sortSelect.value;
        state.offset = 0;
        syncUrl();
        runSearch();
    }
    loaderFilter.addEventListener('change', onFilterChange);
    versionFilter.addEventListener('change', onFilterChange);
    sortSelect.addEventListener('change', onFilterChange);

    // ── Version picker modal ──
    var versionSeq = 0;
    async function openVersionModal(projectId, title) {
        packModalTitle.textContent = title || 'Modpack';
        hide(packVersionsEmpty);
        hide(packVersionsWrap);
        show(packVersionsLoading);
        versionModal.show();

        var seq = ++versionSeq;
        var p = new URLSearchParams();
        if (state.loader) p.set('loader', state.loader);
        if (state.gameVersion) p.set('gameVersion', state.gameVersion);
        var qs = p.toString();
        var res = await apiFetch('/api/v1/modrinth/projects/' + encodeURIComponent(projectId) + '/versions' + (qs ? '?' + qs : ''));
        if (seq !== versionSeq) return;
        hide(packVersionsLoading);

        if (!res.ok) {
            showToast((res.data && (res.data.message || res.data.error)) || 'Failed to load modpack versions.', 'danger');
            show(packVersionsEmpty);
            return;
        }

        var versions = (res.data && res.data.versions) || [];
        if (versions.length === 0) {
            show(packVersionsEmpty);
            return;
        }

        packVersionsTbody.innerHTML = '';
        versions.forEach(function (v) {
            packVersionsTbody.appendChild(buildVersionRow(projectId, v));
        });
        show(packVersionsWrap);
    }

    function buildVersionRow(projectId, v) {
        var tr = document.createElement('tr');

        // Primary cell absorbs leftover width and truncates (no phone h-scroll)
        var nameTd = document.createElement('td');
        nameTd.className = 'mr-primary-cell';
        var nameEl = document.createElement('div');
        nameEl.className = 'fw-semibold text-truncate';
        nameEl.textContent = v.versionNumber || v.name || '';
        nameTd.appendChild(nameEl);
        if (v.name && v.name !== v.versionNumber) {
            var subEl = document.createElement('small');
            subEl.className = 'text-body-secondary text-truncate d-block';
            subEl.textContent = v.name;
            nameTd.appendChild(subEl);
        }
        tr.appendChild(nameTd);

        var mcTd = document.createElement('td');
        var gameVersions = v.gameVersions || [];
        gameVersions.slice(0, 3).forEach(function (gv) {
            var badge = document.createElement('span');
            badge.className = 'badge bg-secondary me-1';
            badge.textContent = gv;
            mcTd.appendChild(badge);
        });
        if (gameVersions.length > 3) {
            var more = document.createElement('small');
            more.className = 'text-body-secondary';
            more.textContent = '+' + (gameVersions.length - 3);
            mcTd.appendChild(more);
        }
        tr.appendChild(mcTd);

        var loaderTd = document.createElement('td');
        loaderTd.className = 'd-none d-md-table-cell';
        (v.loaders || []).forEach(function (l) {
            var badge = document.createElement('span');
            badge.className = 'badge bg-info me-1';
            badge.textContent = LOADER_NAMES[l] || l;
            loaderTd.appendChild(badge);
        });
        tr.appendChild(loaderTd);

        var dateTd = document.createElement('td');
        dateTd.className = 'd-none d-md-table-cell';
        var dateEl = document.createElement('small');
        dateEl.className = 'text-body-secondary text-nowrap';
        dateEl.textContent = v.datePublished ? formatDate(v.datePublished, 'date') : '';
        dateTd.appendChild(dateEl);
        tr.appendChild(dateTd);

        var actionTd = document.createElement('td');
        actionTd.className = 'text-end';
        var selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.className = 'btn btn-success btn-sm d-inline-flex align-items-center gap-1';
        var btnIcon = document.createElement('span');
        btnIcon.className = 'material-icons-outlined';
        btnIcon.style.fontSize = '1rem';
        btnIcon.textContent = 'arrow_forward';
        selectBtn.appendChild(btnIcon);
        selectBtn.appendChild(document.createTextNode('Select'));
        selectBtn.addEventListener('click', function () {
            window.location.href = '/servers/create?modpack=' + encodeURIComponent(projectId)
                + '&version=' + encodeURIComponent(v.id);
        });
        actionTd.appendChild(selectBtn);
        tr.appendChild(actionTd);

        return tr;
    }

    // ── Minecraft version filter options (vanilla release list) ──
    (async function loadVersionFilter() {
        try {
            var res = await fetch('/api/v1/versions?type=vanilla');
            var data = await res.json();
            (data.versions || []).forEach(function (v) {
                var opt = document.createElement('option');
                opt.value = v.id;
                opt.textContent = v.id;
                versionFilter.appendChild(opt);
            });
            // Re-apply a version restored from the URL now that options exist
            if (state.gameVersion) versionFilter.value = state.gameVersion;
        } catch (_) { /* filter stays "All Versions" */ }
    })();

    // Initial load
    runSearch();
})();
