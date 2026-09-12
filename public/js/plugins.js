/* global bootstrap */
(function () {
    'use strict';

    var serverId = window.location.pathname.split('/')[2];
    var csrf = document.getElementById('csrf-token')?.value || '';

    // ── Mod / Plugin terminology (sourced from upload-btn data-label, set by views/servers/plugins.ejs) ──

    var uploadBtn = document.getElementById('upload-btn');
    var contentLabel = uploadBtn ? (uploadBtn.dataset.label || 'plugins') : 'plugins';
    var contentSingular = contentLabel === 'mods' ? 'mod' : 'plugin';
    var contentSingularCap = contentSingular.charAt(0).toUpperCase() + contentSingular.slice(1);

    // ── Listing ──
    // The rows are rendered by the view on first load and by buildRow below on
    // every change after that, from the same listing the API returns. Keep the
    // two in step with views/servers/plugins.ejs.

    var tbody = document.getElementById('plugins-tbody');
    var emptyRow = document.getElementById('plugins-empty');
    var noMatchRow = document.getElementById('plugins-no-match');
    var searchBar = document.getElementById('search-bar');
    var searchInput = document.getElementById('search-input');
    var envFilterSelect = document.getElementById('env-filter');
    var installedCountEl = document.getElementById('installed-count');
    var listActions = document.getElementById('list-actions');
    var deleteAllCountEl = document.getElementById('delete-all-count');
    var gate = (tbody && tbody.dataset.gate) || 'stopped crashed';
    var rowIcon = (tbody && tbody.dataset.icon) || 'extension';
    var isMods = !!tbody && tbody.dataset.mods === 'true';

    var ENV_OPTIONS = [
        { value: 'both', label: 'Client and Server' },
        { value: 'client', label: 'Client Only' },
        { value: 'server', label: 'Server Only' }
    ];

    function buildRow(file) {
        var tr = document.createElement('tr');
        tr.dataset.filename = file.name;
        tr.dataset.env = file.environment || 'both';

        var iconTd = document.createElement('td');
        var icon = document.createElement('span');
        icon.className = 'material-icons-outlined text-body-secondary';
        icon.style.fontSize = '1.2rem';
        icon.textContent = rowIcon;
        iconTd.appendChild(icon);
        tr.appendChild(iconTd);

        var nameTd = document.createElement('td');
        nameTd.textContent = file.name;
        tr.appendChild(nameTd);

        var sizeTd = document.createElement('td');
        sizeTd.className = 'text-body-secondary small';
        sizeTd.textContent = file.sizeFormatted;
        tr.appendChild(sizeTd);

        var dateTd = document.createElement('td');
        dateTd.className = 'text-body-secondary small';
        var date = document.createElement('span');
        date.className = 'format-date';
        date.dataset.iso = file.modifiedISO;
        date.textContent = formatDate(file.modifiedISO);
        dateTd.appendChild(date);
        tr.appendChild(dateTd);

        if (isMods) {
            var envTd = document.createElement('td');
            var select = document.createElement('select');
            select.className = 'form-select form-select-sm env-select';
            select.dataset.filename = file.name;
            select.dataset.enableWhen = gate;
            select.dataset.enabledTitle = 'Change environment';
            select.dataset.disabledTitle = 'Stop the server to change';
            ENV_OPTIONS.forEach(function (opt) {
                var option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.label;
                // defaultSelected writes the attribute, as the view's markup has it.
                option.defaultSelected = opt.value === tr.dataset.env;
                select.appendChild(option);
            });
            envTd.appendChild(select);
            tr.appendChild(envTd);
        }

        var actionsTd = document.createElement('td');
        actionsTd.className = 'text-center';
        var group = document.createElement('div');
        group.className = 'd-inline-flex gap-1';

        var download = document.createElement('a');
        download.href = '/servers/' + serverId + '/plugins/download?file=' + encodeURIComponent(file.name);
        download.className = 'btn btn-outline-secondary btn-sm d-inline-flex align-items-center justify-content-center';
        download.style.cssText = 'width: 32px; height: 32px; padding: 0;';
        download.title = 'Download';
        download.dataset.download = file.name;
        download.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">download</span>';
        group.appendChild(download);

        // Gated like the view's: applyStateGates() (app.js) sets disabled and
        // the title from the live state once the row is in the document.
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-outline-danger btn-sm d-inline-flex align-items-center justify-content-center delete-btn';
        del.style.cssText = 'width: 32px; height: 32px; padding: 0;';
        del.dataset.filename = file.name;
        del.dataset.enableWhen = gate;
        del.dataset.enabledTitle = 'Delete';
        del.dataset.disabledTitle = 'Stop the server to delete';
        del.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">delete</span>';
        group.appendChild(del);

        actionsTd.appendChild(group);
        tr.appendChild(actionsTd);
        return tr;
    }

    // The rows in listing order (by name — the API's order), so the search can
    // put them back after ranking them.
    var listedRows = [];

    function renderRows(files) {
        if (!tbody) return;
        listedRows.forEach(function (row) { row.remove(); });
        listedRows = files.map(buildRow);
        listedRows.forEach(function (row) { tbody.insertBefore(row, emptyRow); });

        var count = files.length;
        if (installedCountEl) {
            installedCountEl.textContent = count + ' ' + (count === 1 ? contentSingular : contentLabel) + ' installed';
        }
        if (deleteAllCountEl) deleteAllCountEl.textContent = String(count);
        if (listActions) listActions.classList.toggle('d-none', count === 0);
        if (searchBar) searchBar.classList.toggle('d-none', count === 0);
        if (emptyRow) emptyRow.classList.toggle('d-none', count > 0);

        // New controls take the live gate, not the one the page loaded with.
        applyStateGates();
        applyFilters();
    }

    // Rows the view rendered are the initial listing.
    if (tbody) {
        listedRows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-filename]'));
    }

    // Refetch the folder and redraw. Sequenced so a slow response can never
    // paint over a newer one.
    var refreshSeq = 0;
    async function refreshList() {
        if (!tbody) return;
        var seq = ++refreshSeq;
        var res = await apiFetch('/api/v1/servers/' + serverId + '/plugins');
        if (seq !== refreshSeq) return;
        if (!res.ok || !res.data) {
            showToast((res.data && res.data.error) || 'Could not refresh the ' + contentLabel + ' list.', 'danger');
            return;
        }
        renderRows(res.data.files || []);
    }

    // Another tab changed the folder. Own changes are skipped — the handler
    // that made them already refreshed. A short debounce folds a burst (a
    // Modrinth install pulling several dependencies) into one fetch.
    var remoteRefreshTimer = null;
    document.addEventListener('craftbox:content-changed', function (e) {
        var msg = e.detail || {};
        if (msg.scope !== 'plugins') return;
        if (msg.origin && msg.origin === window.CRAFTBOX_CLIENT_ID) return;
        clearTimeout(remoteRefreshTimer);
        remoteRefreshTimer = setTimeout(refreshList, 300);
    });

    // ── Search / Filter ──
    // Both live here rather than only in their inputs, so a redraw after an
    // upload, delete or install filters the new rows exactly as the old ones.

    var searchQuery = '';
    var envFilter = '';

    function applyFilters() {
        var query = searchQuery.trim().toLowerCase();
        var shown = 0;
        listedRows.forEach(function (row) {
            var name = row.dataset.filename.toLowerCase();
            var env = row.dataset.env || 'both';
            var matchSearch = !query || name.indexOf(query) !== -1;
            var matchEnv = !envFilter || env === envFilter;
            var match = matchSearch && matchEnv;
            row.classList.toggle('d-none', !match);
            if (match) shown++;
        });
        if (noMatchRow) noMatchRow.classList.toggle('d-none', shown > 0 || listedRows.length === 0);
    }

    if (searchInput) {
        searchInput.addEventListener('input', function () {
            searchQuery = searchInput.value;
            applyFilters();
        });
        // A browser restoring the page can hand the inputs their old values back.
        searchQuery = searchInput.value;
    }

    if (envFilterSelect) {
        envFilterSelect.addEventListener('change', function () {
            envFilter = envFilterSelect.value;
            applyFilters();
        });
        envFilter = envFilterSelect.value;
    }

    if (searchQuery || envFilter) applyFilters();

    // ── Environment change ──
    // Bound once, on the table, so rows drawn later work too. The row's
    // data-env is the last value the server accepted, which is what a refused
    // change is put back to.

    if (tbody && isMods) {
        tbody.addEventListener('change', async function (e) {
            var sel = e.target.closest('.env-select');
            if (!sel) return;
            var row = sel.closest('tr[data-filename]');
            var filename = sel.dataset.filename;
            var newValue = sel.value;
            var previousValue = (row && row.dataset.env) || 'both';
            sel.disabled = true;
            try {
                var res = await apiFetch('/api/v1/servers/' + serverId + '/plugins/environment', {
                    method: 'POST',
                    body: { filename: filename, environment: newValue }
                });
                var data = res.data || {};
                if (res.ok && data.success) {
                    if (row) row.dataset.env = newValue;
                    applyFilters();
                    showToast(contentSingularCap + ' environment updated.', 'success');
                } else {
                    showToast(data.error || 'Failed to update environment.', 'danger');
                    sel.value = previousValue;
                }
            } catch {
                showToast('Failed to update environment.', 'danger');
                sel.value = previousValue;
            } finally {
                sel.disabled = false;
            }
        });
    }

    // ── Upload ──

    var fileInput = document.getElementById('file-input');
    var uploadLabel = contentLabel;

    async function uploadFiles(files) {
        var jarFiles = Array.from(files).filter(function (f) {
            return f.name.toLowerCase().endsWith('.jar');
        });
        if (jarFiles.length === 0) {
            showToast('Only .jar files can be uploaded.', 'warning');
            return;
        }

        if (uploadBtn) uploadBtn.disabled = true;
        if (fileInput) fileInput.disabled = true;
        showOverlay('Uploading ' + uploadLabel + '...', 'This may take a moment for large files.');

        var uploaded = [];
        var rejected = [];
        var replaced = 0;
        var failure = null;

        try {
            var totalBytes = jarFiles.reduce(function (sum, f) { return sum + f.size; }, 0);
            if (jarFiles.length > 0 && totalBytes <= DGUP_THRESHOLD) {
                // Small selection — one multipart request for all files, as before.
                var formData = new FormData();
                for (var i = 0; i < jarFiles.length; i++) {
                    formData.append('files', jarFiles[i]);
                }
                var res = await apiFetch('/api/v1/servers/' + serverId + '/plugins/upload', {
                    method: 'POST',
                    body: formData
                });
                var data = res.data || {};
                if (res.ok && data.success) {
                    uploaded = data.uploaded || [];
                    rejected = rejected.concat(data.rejected || []);
                    replaced += data.replaced || 0;
                } else {
                    failure = (data && data.error) || 'Upload failed.';
                }
            } else {
                // Large selection — one upload per jar (uploadFile chunks
                // anything over the threshold so 100+ MB mods survive proxies
                // with request-body caps), merging the per-file results.
                for (var j = 0; j < jarFiles.length; j++) {
                    var file = jarFiles[j];
                    var prefix = (jarFiles.length > 1 ? (j + 1) + ' of ' + jarFiles.length + ' — ' : '') + file.name;
                    showOverlay('Uploading ' + uploadLabel + '...', prefix);
                    var result = await uploadFile('/api/v1/servers/' + serverId + '/plugins/upload', file, {
                        fieldName: 'files',
                        csrfToken: csrf,
                        onProgress: function (loaded, total) {
                            showOverlay('Uploading ' + uploadLabel + '...',
                                prefix + ' (' + Math.round((loaded / total) * 100) + '%)');
                        }
                    });
                    if (result.ok && result.data && result.data.success) {
                        uploaded = uploaded.concat(result.data.uploaded || []);
                        rejected = rejected.concat(result.data.rejected || []);
                        replaced += result.data.replaced || 0;
                    } else {
                        failure = (result.data && result.data.error) || 'Upload failed.';
                        break;
                    }
                }
            }
        } catch {
            failure = 'Upload failed. Please try again.';
        }

        var uploadedCount = uploaded.length;
        var rejectedCount = rejected.length;
        var noun = uploadedCount === 1 ? contentSingular : contentLabel;
        var replacedNote = replaced > 0 ? ', ' + replaced + ' replaced' : '';

        // Anything that landed is shown before the outcome is announced, so
        // the toast never describes rows the table has yet to catch up with.
        if (uploadedCount > 0) {
            // The selection is spent: leaving it in the picker would offer the
            // same jars for a second upload.
            if (fileInput) fileInput.value = '';
            await refreshList();
        }
        if (fileInput) fileInput.disabled = false;
        refreshUploadBtn();
        hideOverlay();

        if (failure && uploadedCount > 0) {
            showToast(uploadedCount + ' ' + noun + ' uploaded, then: ' + failure, 'warning');
        } else if (failure) {
            showToast(failure, 'danger');
        } else if (uploadedCount === 0) {
            showToast(rejectedCount === 1
                ? 'File rejected: ' + ((rejected[0] && rejected[0].reason) || 'not a valid JAR') + '.'
                : 'No files uploaded — all ' + rejectedCount + ' were rejected.', 'danger');
        } else if (rejectedCount > 0) {
            showToast(uploadedCount + ' ' + noun + ' uploaded' + replacedNote
                + ', ' + rejectedCount + ' rejected.', 'warning');
        } else {
            showToast(uploadedCount + ' ' + noun + ' uploaded' + replacedNote + '.', 'success');
        }
    }

    // Upload needs both a stopped server AND a file selection, so it can't use
    // data-enable-when (which knows only about state). Re-derive it here and on
    // every state change instead.
    function refreshUploadBtn() {
        if (!uploadBtn) return;
        var stopped = isServerStopped();
        uploadBtn.disabled = !stopped || !fileInput || fileInput.files.length === 0;
        uploadBtn.title = stopped ? '' : 'Stop the server to upload';
    }

    if (fileInput && uploadBtn) {
        guardFileInput(fileInput, ['.jar'], 'Only .jar files can be uploaded.');

        fileInput.addEventListener('change', refreshUploadBtn);

        uploadBtn.addEventListener('click', function () {
            if (!isServerStopped() || fileInput.files.length === 0) return;
            uploadFiles(fileInput.files);
        });
    }

    document.addEventListener('craftbox:stategates', refreshUploadBtn);
    refreshUploadBtn();

    // ── Drag & Drop ──

    // Cancelling the browser's own handling of a dropped file is app.js's job
    // now (see "Stray file drops"), for every page rather than just this one.

    var dropOverlay = document.getElementById('drop-overlay');
    if (dropOverlay) {
        var dragCounter = 0;

        document.addEventListener('dragenter', function (e) {
            e.preventDefault();
            // Dropping only uploads while the server is stopped, so don't invite
            // it otherwise. Checked live rather than at render time.
            if (isOverlayVisible() || !isServerStopped()) return;
            dragCounter++;
            if (dragCounter === 1) {
                dropOverlay.classList.remove('d-none');
                dropOverlay.classList.add('d-flex');
            }
        });

        document.addEventListener('dragleave', function (e) {
            e.preventDefault();
            if (isOverlayVisible()) return;
            dragCounter--;
            if (dragCounter === 0) {
                dropOverlay.classList.add('d-none');
                dropOverlay.classList.remove('d-flex');
            }
        });

        document.addEventListener('drop', function (e) {
            if (isOverlayVisible()) return;
            dragCounter = 0;
            dropOverlay.classList.add('d-none');
            dropOverlay.classList.remove('d-flex');

            if (!isServerStopped()) {
                showToast('Stop the server before uploading ' + contentLabel + '.', 'danger');
                return;
            }
            // Synchronously, before the drop event's item list is emptied.
            var dropped = readDroppedItems(e.dataTransfer);
            if (dropped.files.length === 0 && dropped.folders.length > 0) {
                showToast(folderDropMessage(dropped.folders,
                    'Drag the .jar files themselves in instead.'), 'danger');
                return;
            }
            // A folder dropped alongside jars needs no message of its own: it is
            // ignored exactly as any other non-jar in the drop already is, and
            // uploadFiles reports the batch it kept.
            if (dropped.files.length > 0) uploadFiles(dropped.files);
        });
    }

    // ── Delete ──

    var deleteModal = document.getElementById('deleteModal');
    var deleteFilenameEl = document.getElementById('delete-filename');
    var confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    var pendingDeleteFilename = null;

    if (deleteModal && tbody) {
        var bsDeleteModal = new bootstrap.Modal(deleteModal);

        // Bound once, on the table, so rows drawn later work too.
        tbody.addEventListener('click', function (e) {
            var btn = e.target.closest('.delete-btn');
            if (!btn || btn.disabled) return;
            pendingDeleteFilename = btn.dataset.filename;
            if (deleteFilenameEl) deleteFilenameEl.textContent = pendingDeleteFilename;
            bsDeleteModal.show();
        });

        if (confirmDeleteBtn) {
            confirmDeleteBtn.addEventListener('click', async function () {
                if (!pendingDeleteFilename) return;

                confirmDeleteBtn.disabled = true;
                confirmDeleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';

                try {
                    var res = await apiFetch('/api/v1/servers/' + serverId + '/plugins/delete', {
                        method: 'POST',
                        body: { filename: pendingDeleteFilename }
                    });

                    var data = res.data || {};
                    if (res.ok && data.success) {
                        bsDeleteModal.hide();
                        await refreshList();
                        showToast(contentSingularCap + ' deleted.', 'success');
                    } else {
                        showToast(data.error || 'Delete failed.', 'danger');
                    }
                } catch {
                    showToast('Delete failed. Please try again.', 'danger');
                }
                confirmDeleteBtn.disabled = false;
                confirmDeleteBtn.textContent = 'Delete';
            });
        }
    }
    // ── Delete All ──

    var deleteAllBtn = document.getElementById('delete-all-btn');
    var deleteAllModal = document.getElementById('deleteAllModal');
    var confirmDeleteAllBtn = document.getElementById('confirm-delete-all-btn');

    if (deleteAllBtn && deleteAllModal) {
        var bsDeleteAllModal = new bootstrap.Modal(deleteAllModal);

        deleteAllBtn.addEventListener('click', function () {
            bsDeleteAllModal.show();
        });

        if (confirmDeleteAllBtn) {
            confirmDeleteAllBtn.addEventListener('click', async function () {
                confirmDeleteAllBtn.disabled = true;
                confirmDeleteAllBtn.textContent = 'Deleting...';
                bsDeleteAllModal.hide();
                showOverlay('Deleting all ' + uploadLabel + '...', 'Please wait while all files are removed.');

                try {
                    var res = await apiFetch('/api/v1/servers/' + serverId + '/plugins/delete-all', {
                        method: 'POST',
                        body: {}
                    });

                    var data = res.data || {};
                    if (res.ok && data.success) {
                        await refreshList();
                        hideOverlay();
                        showToast('All ' + contentLabel + ' deleted.', 'success');
                    } else {
                        hideOverlay();
                        showToast(data.error || 'Delete all failed.', 'danger');
                    }
                } catch {
                    hideOverlay();
                    showToast('Delete all failed. Please try again.', 'danger');
                }
                confirmDeleteAllBtn.disabled = false;
                confirmDeleteAllBtn.textContent = 'Delete All';
            });
        }
    }

    // ── Browse Modrinth ──

    var modrinthModalEl = document.getElementById('modrinthModal');
    var modrinthBrowseBtn = document.getElementById('modrinth-browse-btn');

    if (modrinthModalEl && modrinthBrowseBtn) {
        var bsModrinthModal = new bootstrap.Modal(modrinthModalEl);
        var mrSearchInput = document.getElementById('modrinth-search');
        var mrSortSelect = document.getElementById('modrinth-sort');
        var mrLoading = document.getElementById('modrinth-loading');
        var mrEmpty = document.getElementById('modrinth-empty');
        var mrWrap = document.getElementById('modrinth-results-wrap');
        var mrResults = document.getElementById('modrinth-results');
        var mrLoadMore = document.getElementById('modrinth-load-more');

        var mrServerType = modrinthModalEl.dataset.serverType;
        var mrGameVersion = modrinthModalEl.dataset.serverVersion;
        var MR_PAGE = 20;
        var mrOffset = 0;
        var mrTotal = 0;
        var mrSeq = 0;
        var mrLoadedOnce = false;
        // projectId -> filename for files already in the content folder,
        // matched by hash server-side. null until the lookup lands.
        var mrInstalledProjects = null;

        function mrCompactNumber(n) {
            if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
            if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
            return String(n || 0);
        }

        modrinthBrowseBtn.addEventListener('click', function () {
            bsModrinthModal.show();
            if (!mrLoadedOnce) {
                mrLoadedOnce = true;
                loadInstalledProjects();
                mrSearch(false);
            }
        });

        // Already-installed detection: rows render immediately from the search,
        // then get re-marked once the hash lookup answers (whichever is slower).
        async function loadInstalledProjects() {
            var res = await apiFetch('/api/v1/servers/' + serverId + '/modrinth-installed');
            mrInstalledProjects = (res.ok && res.data && res.data.projects) || {};
            markInstalledRows();
        }

        function markInstalledRows() {
            if (!mrInstalledProjects) return;
            mrResults.querySelectorAll('button[data-project-id]').forEach(function (btn) {
                if (!btn.disabled && mrInstalledProjects[btn.dataset.projectId]) {
                    mrMarkInstalled(btn);
                }
            });
        }

        async function mrSearch(append) {
            var seq = ++mrSeq;
            if (!append) {
                mrWrap.classList.add('d-none');
                mrEmpty.classList.add('d-none');
                mrLoadMore.classList.add('d-none');
                mrLoading.classList.remove('d-none');
            } else {
                mrLoadMore.disabled = true;
            }

            var p = new URLSearchParams();
            p.set('projectType', 'mod');
            p.set('loader', mrServerType);
            if (mrGameVersion && mrGameVersion !== 'latest') p.set('gameVersion', mrGameVersion);
            var q = mrSearchInput.value.trim();
            if (q) p.set('query', q);
            p.set('index', mrSortSelect.value);
            p.set('offset', String(mrOffset));
            p.set('limit', String(MR_PAGE));

            var res = await apiFetch('/api/v1/modrinth/search?' + p.toString());
            if (seq !== mrSeq) return;
            mrLoading.classList.add('d-none');
            mrLoadMore.disabled = false;

            if (!res.ok) {
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to search Modrinth.', 'danger');
                if (!append) mrEmpty.classList.remove('d-none');
                return;
            }

            mrTotal = res.data.totalHits || 0;
            var hits = res.data.hits || [];
            if (!append) mrResults.innerHTML = '';
            if (hits.length === 0 && !append) {
                mrEmpty.classList.remove('d-none');
                return;
            }
            hits.forEach(function (hit) {
                mrResults.appendChild(mrBuildRow(hit));
            });
            markInstalledRows();
            mrWrap.classList.remove('d-none');
            mrLoadMore.classList.toggle('d-none', mrOffset + MR_PAGE >= mrTotal);
        }

        // Modrinth strings are external data — always set via textContent.
        function mrBuildRow(hit) {
            var tr = document.createElement('tr');

            var iconTd = document.createElement('td');
            iconTd.style.width = '48px';
            if (hit.iconUrl) {
                var img = document.createElement('img');
                img.className = 'modpack-icon-sm';
                img.alt = '';
                img.src = hit.iconUrl;
                iconTd.appendChild(img);
            } else {
                var ph = document.createElement('span');
                ph.className = 'modpack-icon-sm modpack-icon-placeholder';
                var phIcon = document.createElement('span');
                phIcon.className = 'material-icons-outlined';
                phIcon.style.fontSize = '1.2rem';
                phIcon.textContent = 'extension';
                ph.appendChild(phIcon);
                iconTd.appendChild(ph);
            }
            tr.appendChild(iconTd);

            // Primary cell absorbs leftover width and truncates (no phone h-scroll)
            var nameTd = document.createElement('td');
            nameTd.className = 'mr-primary-cell';
            var nameRow = document.createElement('div');
            nameRow.className = 'd-flex align-items-baseline gap-2';
            var nameEl = document.createElement('span');
            nameEl.className = 'fw-semibold text-truncate';
            nameEl.style.minWidth = '0';
            nameEl.textContent = hit.title || '(untitled)';
            nameRow.appendChild(nameEl);
            if (hit.author) {
                var authorEl = document.createElement('small');
                authorEl.className = 'text-body-secondary text-nowrap flex-shrink-0';
                authorEl.textContent = 'by ' + hit.author;
                nameRow.appendChild(authorEl);
            }
            nameTd.appendChild(nameRow);
            var descEl = document.createElement('small');
            descEl.className = 'text-body-secondary d-block text-truncate';
            descEl.textContent = hit.description || '';
            nameTd.appendChild(descEl);
            tr.appendChild(nameTd);

            var dlTd = document.createElement('td');
            dlTd.className = 'text-body-secondary small text-nowrap d-none d-md-table-cell';
            dlTd.style.width = '110px';
            var dlIcon = document.createElement('span');
            dlIcon.className = 'material-icons-outlined me-1';
            dlIcon.style.fontSize = '1rem';
            dlIcon.textContent = 'download';
            dlTd.appendChild(dlIcon);
            dlTd.appendChild(document.createTextNode(mrCompactNumber(hit.downloads)));
            tr.appendChild(dlTd);

            var btnTd = document.createElement('td');
            btnTd.className = 'text-end';
            btnTd.style.width = '130px';
            var installBtn = document.createElement('button');
            installBtn.type = 'button';
            installBtn.className = 'btn btn-success btn-sm d-inline-flex align-items-center gap-1';
            installBtn.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">download</span>Install';
            installBtn.dataset.projectId = hit.projectId;
            installBtn.addEventListener('click', function () {
                mrInstall(installBtn, hit);
            });
            if (mrInstalledProjects && mrInstalledProjects[hit.projectId]) {
                mrMarkInstalled(installBtn);
            }
            btnTd.appendChild(installBtn);
            tr.appendChild(btnTd);

            return tr;
        }

        function mrMarkInstalled(btn) {
            btn.className = 'btn btn-outline-success btn-sm d-inline-flex align-items-center gap-1';
            btn.disabled = true;
            btn.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">check</span>Installed';
        }

        async function mrInstall(btn, hit) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Installing...';

            var res = await apiFetch('/api/v1/servers/' + serverId + '/modrinth-install', {
                method: 'POST',
                body: { projectId: hit.projectId }
            });
            if (!res.ok) {
                showToast((res.data && (res.data.message || res.data.error)) || 'Install failed.',
                    res.status === 409 ? 'warning' : 'danger');
                if (res.status === 409) {
                    mrMarkInstalled(btn);
                } else {
                    btn.disabled = false;
                    btn.innerHTML = '<span class="material-icons-outlined" style="font-size: 1rem;">download</span>Install';
                }
                return;
            }

            var files = (res.data && res.data.installed) || [];
            var msg = files.length > 1
                ? files[0].filename + ' installed (+' + (files.length - 1) + ' ' + (files.length === 2 ? 'dependency' : 'dependencies') + ').'
                : ((files[0] ? files[0].filename : contentSingularCap) + ' installed.');
            showToast(msg, 'success');
            mrMarkInstalled(btn);
            // Fold the new files (incl. auto-installed dependencies) into the
            // installed set so their rows flip to "Installed" too.
            if (mrInstalledProjects) {
                files.forEach(function (f) {
                    if (f.projectId) mrInstalledProjects[f.projectId] = f.filename;
                });
                markInstalledRows();
            }
            // The table behind the modal picks the new jars up straight away,
            // so closing it lands on a listing that already has them.
            refreshList();
        }

        var mrDebounce = null;
        mrSearchInput.addEventListener('input', function () {
            clearTimeout(mrDebounce);
            mrDebounce = setTimeout(function () {
                mrOffset = 0;
                mrSearch(false);
            }, 400);
        });
        mrSortSelect.addEventListener('change', function () {
            mrOffset = 0;
            mrSearch(false);
        });
        mrLoadMore.addEventListener('click', function () {
            mrOffset += MR_PAGE;
            mrSearch(true);
        });
    }
})();
