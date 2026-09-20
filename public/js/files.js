/* global bootstrap */
(function () {
    'use strict';

    var serverId = window.location.pathname.split('/')[2];
    var csrf = document.getElementById('csrf-token')?.value || '';
    // The directory this page is showing, relative to the server root ('' = root).
    var currentPath = document.getElementById('current-path')?.value || '';
    var locationLabel = currentPath || 'the server root';

    // Names are external data — always set them via textContent.
    function nameText(parent, name) {
        var strong = document.createElement('strong');
        strong.textContent = name;
        parent.appendChild(strong);
    }

    // Mirrors newNameError (src/utils/fileBrowser.js) check for check, so the
    // confirm button only lights up for a name the API would actually accept.
    // The server still re-checks — this just saves a round trip to be told no.
    // Keep the two in step: this list was the stricter of the pair for a while,
    // refusing a slash that the API then quietly stripped to a basename.
    var RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

    function nameError(name) {
        var trimmed = String(name || '').trim();
        if (!trimmed) return 'Enter a name.';
        if (trimmed.length > 255) return 'A name cannot be longer than 255 characters.';
        if (trimmed === '.' || trimmed === '..') return 'That name cannot be used.';
        if (/[/\\]/.test(trimmed)) return 'A name cannot contain a slash.';
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f]/.test(trimmed)) return 'A name cannot contain control characters.';
        if (/[<>:"|?*]/.test(trimmed)) return 'A name cannot contain any of: < > : " | ? *';
        if (/\.$/.test(trimmed)) return 'A name cannot end with a dot.';
        if (RESERVED_DEVICE_NAMES.test(trimmed)) return '"' + trimmed + '" is a reserved name and cannot be used.';
        return null;
    }

    // ── Listing ──
    // The rows are rendered by the view on first load and by buildRow below on
    // every change after that, from the same listing the API returns. Keep the
    // two in step with views/servers/files.ejs.

    var tbody = document.getElementById('files-tbody');
    var emptyRow = document.getElementById('files-empty');
    var noMatchRow = document.getElementById('files-no-match');
    var searchBar = document.getElementById('search-bar');
    var searchInput = document.getElementById('search-input');
    var gate = (tbody && tbody.dataset.gate) || 'stopped crashed';
    var parentPath = (tbody && tbody.dataset.parentPath) || '';

    function iconCell(name) {
        var td = document.createElement('td');
        var icon = document.createElement('span');
        icon.className = 'material-icons-outlined text-body-secondary';
        icon.style.fontSize = '1.2rem';
        icon.textContent = name;
        td.appendChild(icon);
        return td;
    }

    // A 32px square icon button/link, as the view lays them out.
    function squareControl(tag, classes, iconName) {
        var el = document.createElement(tag);
        el.className = classes + ' btn-sm d-inline-flex align-items-center justify-content-center';
        el.style.cssText = 'width: 32px; height: 32px; padding: 0;';
        if (tag === 'button') el.type = 'button';
        var icon = document.createElement('span');
        icon.className = 'material-icons-outlined';
        icon.style.fontSize = '1rem';
        icon.textContent = iconName;
        el.appendChild(icon);
        return el;
    }

    // Controls that need the server stopped carry the same gate attributes the
    // view gives them; applyStateGates() (app.js) then sets disabled/title from
    // the live state once the row is in the document.
    function gateControl(el, enabledTitle, disabledTitle) {
        el.dataset.enableWhen = gate;
        el.dataset.enabledTitle = enabledTitle;
        el.dataset.disabledTitle = disabledTitle;
    }

    function buildRow(file) {
        var relPath = (currentPath ? currentPath + '/' : '') + file.name;
        var tr = document.createElement('tr');
        tr.dataset.filename = file.name;
        tr.dataset.path = relPath;
        tr.dataset.directory = String(!!file.isDirectory);

        tr.appendChild(iconCell(file.isDirectory ? 'folder' : 'description'));

        var nameTd = document.createElement('td');
        if (file.isDirectory) {
            var link = document.createElement('a');
            link.href = '/servers/' + serverId + '/files/' + relPath;
            link.className = 'text-decoration-none';
            link.textContent = file.name + '/';
            nameTd.appendChild(link);
        } else {
            nameTd.textContent = file.name;
        }
        tr.appendChild(nameTd);

        var sizeTd = document.createElement('td');
        sizeTd.className = 'text-body-secondary small';
        sizeTd.textContent = file.isDirectory ? '—' : file.sizeFormatted;
        tr.appendChild(sizeTd);

        var dateTd = document.createElement('td');
        dateTd.className = 'text-body-secondary small';
        var date = document.createElement('span');
        date.className = 'format-date';
        date.dataset.iso = file.modifiedISO;
        date.textContent = formatDate(file.modifiedISO);
        dateTd.appendChild(date);
        tr.appendChild(dateTd);

        var actionsTd = document.createElement('td');
        actionsTd.className = 'text-end';
        var group = document.createElement('div');
        group.className = 'd-inline-flex gap-1';

        if (!file.isDirectory) {
            if (file.editable) {
                var edit = squareControl('a', 'btn btn-outline-primary', 'edit');
                edit.href = '/servers/' + serverId + '/edit-file?path=' + encodeURIComponent(relPath);
                edit.title = 'Edit';
                group.appendChild(edit);
            }
            var download = squareControl('a', 'btn btn-outline-secondary', 'download');
            download.href = '/servers/' + serverId + '/download?path=' + encodeURIComponent(relPath);
            download.dataset.download = file.name;
            gateControl(download, 'Download', 'Stop server to download');
            group.appendChild(download);
        }

        var rename = squareControl('button', 'btn btn-outline-secondary rename-btn', 'drive_file_rename_outline');
        gateControl(rename, 'Rename', 'Stop the server to rename');
        group.appendChild(rename);

        var del = squareControl('button', 'btn btn-outline-danger delete-btn', 'delete');
        gateControl(del, 'Delete', 'Stop the server to delete');
        group.appendChild(del);

        actionsTd.appendChild(group);
        tr.appendChild(actionsTd);
        return tr;
    }

    // The rows in listing order (folders first, then by name — the API's order),
    // so the search can put them back after ranking them.
    var listedRows = [];

    function renderRows(files) {
        if (!tbody) return;
        listedRows.forEach(function (row) { row.remove(); });
        listedRows = files.map(buildRow);
        // The "..", empty and no-match rows are the view's; entry rows go
        // between the first and the other two.
        listedRows.forEach(function (row) { tbody.insertBefore(row, emptyRow); });

        if (searchBar) searchBar.classList.toggle('d-none', files.length === 0);
        if (emptyRow) emptyRow.classList.toggle('d-none', files.length > 0);

        // New controls take the live gate, not the one the page loaded with.
        applyStateGates();
        applySearch();
    }

    // Rows the view rendered are the initial listing.
    if (tbody) {
        listedRows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-filename]'));
    }

    // Refetch the directory and redraw. Sequenced so a slow response can never
    // paint over a newer one, and a directory that has since gone (deleted or
    // renamed from another tab) sends the page up a level rather than leaving
    // it on a listing that no longer exists.
    var refreshSeq = 0;
    async function refreshList() {
        if (!tbody) return;
        var seq = ++refreshSeq;
        var res = await apiFetch('/api/v1/servers/' + serverId + '/files?path=' + encodeURIComponent(currentPath));
        if (seq !== refreshSeq) return;
        if (res.status === 404 && currentPath) {
            flashToast('The folder "' + currentPath + '" no longer exists.', 'warning');
            window.location.href = '/servers/' + serverId + '/files' + (parentPath ? '/' + parentPath : '');
            return;
        }
        if (!res.ok || !res.data) {
            showToast((res.data && res.data.error) || 'Could not refresh the file list.', 'danger');
            return;
        }
        renderRows(res.data.files || []);
    }

    // Another tab (or the file editor) changed this directory. Own changes are
    // skipped — the handler that made them already refreshed. A short debounce
    // folds a burst into one fetch.
    //
    // A change in an ancestor directory counts too: the only way this
    // directory can be deleted or renamed is from the listing that contains
    // it, and the refetch is what notices it has gone.
    function concernsThisDirectory(changedPath) {
        if (typeof changedPath !== 'string') return false;
        if (changedPath === currentPath) return true;
        return changedPath === '' || currentPath.indexOf(changedPath + '/') === 0;
    }

    var remoteRefreshTimer = null;
    document.addEventListener('craftbox:content-changed', function (e) {
        var msg = e.detail || {};
        if (msg.scope !== 'files' || !concernsThisDirectory(msg.path)) return;
        if (msg.origin && msg.origin === window.CRAFTBOX_CLIENT_ID) return;
        clearTimeout(remoteRefreshTimer);
        remoteRefreshTimer = setTimeout(refreshList, 300);
    });

    // ── Search / Filter ──
    // The query lives here rather than only in the input, so a redraw after an
    // upload or delete filters the new rows exactly as the old ones were.
    //
    // Matching is fuzzyRank (app.js): closest fit first, so a typo or an
    // abbreviation still finds the file, and the rows are re-ordered by how
    // well they fit while a query is in. Clearing it puts the listing order
    // back.

    var searchQuery = '';

    function applySearch() {
        var query = searchQuery.trim();
        var order = query
            ? fuzzyRank(query, listedRows, function (row) { return row.dataset.filename; })
            : listedRows;
        var shown = {};
        order.forEach(function (row) {
            shown[row.dataset.filename] = true;
            // Moving each matched row in turn (appendChild relocates) lays
            // them out in rank order, ahead of the fixed rows at the end.
            tbody.insertBefore(row, emptyRow);
        });
        listedRows.forEach(function (row) {
            row.classList.toggle('d-none', !shown[row.dataset.filename]);
        });
        if (noMatchRow) noMatchRow.classList.toggle('d-none', order.length > 0 || listedRows.length === 0);
    }

    if (searchInput) {
        searchInput.addEventListener('input', function () {
            searchQuery = searchInput.value;
            applySearch();
        });
        // A browser restoring the page can hand the input its old value back.
        searchQuery = searchInput.value;
        if (searchQuery) applySearch();
    }

    // ── Upload ──

    var fileInput = document.getElementById('file-input');
    var uploadBtn = document.getElementById('upload-btn');

    async function uploadFiles(files) {
        var list = Array.from(files);
        if (list.length === 0) return;

        if (uploadBtn) uploadBtn.disabled = true;
        if (fileInput) fileInput.disabled = true;
        showOverlay('Uploading files...', 'This may take a moment for large files.');

        var uploaded = [];
        var rejected = [];
        var replaced = 0;
        var failure = null;

        try {
            var totalBytes = list.reduce(function (sum, f) { return sum + f.size; }, 0);
            if (totalBytes <= DGUP_THRESHOLD) {
                // Small selection — one multipart request for all files.
                // `path` is appended first: multer only exposes text fields on
                // req.body if they precede the files in the stream.
                var formData = new FormData();
                formData.append('path', currentPath);
                for (var i = 0; i < list.length; i++) {
                    formData.append('files', list[i]);
                }
                var res = await apiFetch('/api/v1/servers/' + serverId + '/files/upload', {
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
                // Large selection — one upload per file (uploadFile chunks
                // anything over the threshold so multi-GB worlds survive
                // proxies with request-body caps), merging the results.
                for (var j = 0; j < list.length; j++) {
                    var file = list[j];
                    var prefix = (list.length > 1 ? (j + 1) + ' of ' + list.length + ' — ' : '') + file.name;
                    showOverlay('Uploading files...', prefix);
                    var result = await uploadFile('/api/v1/servers/' + serverId + '/files/upload', file, {
                        fieldName: 'files',
                        fields: { path: currentPath },
                        csrfToken: csrf,
                        onProgress: function (loaded, total) {
                            showOverlay('Uploading files...',
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
        var noun = uploadedCount === 1 ? 'file' : 'files';
        var replacedNote = replaced > 0 ? ', ' + replaced + ' replaced' : '';

        // Anything that landed is shown before the outcome is announced, so
        // the toast never describes rows the table has yet to catch up with.
        if (uploadedCount > 0) {
            // The selection is spent: leaving it in the picker would offer the
            // same files for a second upload.
            if (fileInput) fileInput.value = '';
            await refreshList();
        }
        if (uploadBtn) uploadBtn.disabled = !fileInput || fileInput.files.length === 0;
        if (fileInput) fileInput.disabled = false;
        hideOverlay();

        if (failure && uploadedCount > 0) {
            showToast(uploadedCount + ' ' + noun + ' uploaded, then: ' + failure, 'warning');
        } else if (failure) {
            showToast(failure, 'danger');
        } else if (uploadedCount === 0) {
            showToast(rejectedCount === 1
                ? 'File rejected: ' + ((rejected[0] && rejected[0].reason) || 'unknown reason') + '.'
                : 'No files uploaded — all ' + rejectedCount + ' were rejected.', 'danger');
        } else if (rejectedCount > 0) {
            showToast(uploadedCount + ' ' + noun + ' uploaded' + replacedNote
                + ', ' + rejectedCount + ' rejected.', 'warning');
        } else {
            showToast(uploadedCount + ' ' + noun + ' uploaded' + replacedNote + '.', 'success');
        }
    }

    // Uploading is allowed in any server state, so the only gate is whether
    // anything is selected — no craftbox:stategates listener needed here.
    if (fileInput && uploadBtn) {
        fileInput.addEventListener('change', function () {
            uploadBtn.disabled = fileInput.files.length === 0;
        });

        uploadBtn.addEventListener('click', function () {
            if (fileInput.files.length === 0) return;
            uploadFiles(fileInput.files);
        });
    }

    // ── Drag & Drop ──

    // Cancelling the browser's own handling of a dropped file is app.js's job
    // now (see "Stray file drops"), for every page rather than just this one.

    var dropOverlay = document.getElementById('drop-overlay');
    if (dropOverlay) {
        var dragCounter = 0;

        document.addEventListener('dragenter', function (e) {
            e.preventDefault();
            if (isOverlayVisible()) return;
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

            // Read the drop here and now: webkitGetAsEntry, which is how
            // readDroppedItems tells a folder from a file, stops answering the
            // moment this handler returns.
            var dropped = readDroppedItems(e.dataTransfer);
            if (dropped.folders.length > 0) {
                // A folder alongside real files is a warning, not a refusal —
                // the files still upload, and the toast says what was skipped.
                var partial = dropped.files.length > 0;
                showToast(folderDropMessage(dropped.folders, partial
                    ? 'The rest of the drop is uploading.'
                    : 'Create the folders you need here with New Folder, then upload the files into them.'),
                partial ? 'warning' : 'danger');
            }
            if (dropped.files.length > 0) uploadFiles(dropped.files);
        });
    }

    // Row buttons are bound once, on the table, so rows drawn later work too.
    function entryFor(btn) {
        var row = btn.closest('tr[data-path]');
        if (!row) return null;
        return {
            path: row.dataset.path,
            name: row.dataset.filename,
            isDirectory: row.dataset.directory === 'true'
        };
    }

    // ── Delete ──

    var deleteModal = document.getElementById('deleteModal');
    var deleteTitleEl = document.getElementById('delete-title');
    var deleteBodyEl = document.getElementById('delete-body');
    var confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    var pendingDelete = null;

    if (deleteModal && tbody) {
        var bsDeleteModal = new bootstrap.Modal(deleteModal);

        tbody.addEventListener('click', function (e) {
            var btn = e.target.closest('.delete-btn');
            if (!btn || btn.disabled) return;
            pendingDelete = entryFor(btn);
            if (!pendingDelete) return;

            deleteTitleEl.textContent = pendingDelete.isDirectory ? 'Delete Folder' : 'Delete File';
            deleteBodyEl.textContent = pendingDelete.isDirectory
                ? 'Permanently delete the folder '
                : 'Permanently delete ';
            nameText(deleteBodyEl, pendingDelete.name);
            deleteBodyEl.appendChild(document.createTextNode(pendingDelete.isDirectory
                ? ' and everything inside it? This cannot be undone.'
                : '? This cannot be undone.'));

            bsDeleteModal.show();
        });

        if (confirmDeleteBtn) {
            confirmDeleteBtn.addEventListener('click', async function () {
                if (!pendingDelete) return;

                confirmDeleteBtn.disabled = true;
                confirmDeleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';

                function done() {
                    confirmDeleteBtn.disabled = false;
                    confirmDeleteBtn.textContent = 'Delete';
                }

                try {
                    var res = await apiFetch('/api/v1/servers/' + serverId + '/files/delete', {
                        method: 'POST',
                        body: { path: pendingDelete.path }
                    });

                    var data = res.data || {};
                    if (res.ok && data.success) {
                        bsDeleteModal.hide();
                        await refreshList();
                        showToast((pendingDelete.isDirectory ? 'Folder' : 'File') + ' deleted.', 'success');
                    } else {
                        showToast(data.error || 'Delete failed.', 'danger');
                    }
                } catch {
                    showToast('Delete failed. Please try again.', 'danger');
                }
                done();
            });
        }
    }

    // ── Rename ──

    var renameModal = document.getElementById('renameModal');
    var renameTitleEl = document.getElementById('rename-title');
    var renameInput = document.getElementById('rename-input');
    var confirmRenameBtn = document.getElementById('confirm-rename-btn');
    var pendingRename = null;

    if (renameModal && tbody) {
        var bsRenameModal = new bootstrap.Modal(renameModal);

        // Renaming to the current name is a no-op the modal handles by just
        // closing, so only the name's own validity gates the button.
        function updateRenameConfirm() {
            confirmRenameBtn.disabled = !!nameError(renameInput.value);
        }

        renameInput.addEventListener('input', updateRenameConfirm);

        tbody.addEventListener('click', function (e) {
            var btn = e.target.closest('.rename-btn');
            if (!btn || btn.disabled) return;
            pendingRename = entryFor(btn);
            if (!pendingRename) return;
            renameTitleEl.textContent = pendingRename.isDirectory ? 'Rename Folder' : 'Rename File';
            renameInput.value = pendingRename.name;
            updateRenameConfirm();
            bsRenameModal.show();
        });

        // Focus only lands once the modal is actually visible.
        renameModal.addEventListener('shown.bs.modal', function () {
            renameInput.focus();
            // Select the base name so typing replaces it but keeps the
            // extension — retyping ".properties" every time is a nuisance.
            var dot = renameInput.value.lastIndexOf('.');
            var end = (!pendingRename.isDirectory && dot > 0) ? dot : renameInput.value.length;
            renameInput.setSelectionRange(0, end);
        });

        renameInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmRenameBtn.click();
            }
        });

        if (confirmRenameBtn) {
            confirmRenameBtn.addEventListener('click', async function () {
                if (!pendingRename) return;
                var newName = renameInput.value.trim();
                var problem = nameError(newName);
                if (problem) {
                    showToast(problem, 'warning');
                    return;
                }
                if (newName === pendingRename.name) {
                    bsRenameModal.hide();
                    return;
                }

                confirmRenameBtn.disabled = true;
                confirmRenameBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Renaming...';

                try {
                    var res = await apiFetch('/api/v1/servers/' + serverId + '/files/rename', {
                        method: 'POST',
                        body: { path: pendingRename.path, newName: newName }
                    });

                    var data = res.data || {};
                    if (res.ok && data.success) {
                        bsRenameModal.hide();
                        await refreshList();
                        showToast('Renamed to "' + data.name + '".', 'success');
                    } else {
                        showToast(data.error || 'Rename failed.', 'danger');
                    }
                } catch {
                    showToast('Rename failed. Please try again.', 'danger');
                }
                confirmRenameBtn.textContent = 'Rename';
                updateRenameConfirm();
            });
        }
    }

    // ── New Folder / New Text File ──

    // The two create modals are the same dialog pointed at a different
    // endpoint: same name rules, same Enter-to-submit, same confirm gating.
    // Wiring both through one function is what keeps them identical, rather
    // than two near-copies that drift the next time one of them is touched.
    //
    // `prefill` seeds the input (the file modal opens on ".txt"); the caret
    // always goes to position 0, so typing builds a name in front of the
    // extension. On the empty folder input that is where it lands anyway.
    function wireCreateModal(opts) {
        var openBtn = document.getElementById(opts.buttonId);
        var modal = document.getElementById(opts.modalId);
        var input = document.getElementById(opts.inputId);
        var confirmBtn = document.getElementById(opts.confirmId);
        if (!openBtn || !modal || !input || !confirmBtn) return;

        var bsModal = new bootstrap.Modal(modal);

        function updateConfirm() {
            confirmBtn.disabled = !!nameError(input.value);
        }

        input.addEventListener('input', updateConfirm);

        openBtn.addEventListener('click', function () {
            input.value = opts.prefill || '';
            updateConfirm();
            bsModal.show();
        });

        // Focus only lands once the modal is actually visible.
        modal.addEventListener('shown.bs.modal', function () {
            input.focus();
            input.setSelectionRange(0, 0);
        });

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmBtn.click();
            }
        });

        confirmBtn.addEventListener('click', async function () {
            var name = input.value.trim();
            var problem = nameError(name);
            if (problem) {
                showToast(problem, 'warning');
                return;
            }

            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Creating...';

            function failed(message) {
                showToast(message, 'danger');
            }

            try {
                var res = await apiFetch('/api/v1/servers/' + serverId + '/files/' + opts.endpoint, {
                    method: 'POST',
                    body: { path: currentPath, name: name }
                });

                var data = res.data || {};
                if (res.ok && data.success) {
                    bsModal.hide();
                    await refreshList();
                    showToast(opts.label + ' "' + data.name + '" created in ' + locationLabel + '.', 'success');
                } else {
                    failed(data.error || 'Could not create the ' + opts.noun + '.');
                }
            } catch {
                failed('Could not create the ' + opts.noun + '. Please try again.');
            }
            confirmBtn.textContent = 'Create';
            updateConfirm();
        });
    }

    wireCreateModal({
        buttonId: 'new-folder-btn',
        modalId: 'newFolderModal',
        inputId: 'new-folder-input',
        confirmId: 'confirm-new-folder-btn',
        endpoint: 'mkdir',
        label: 'Folder',
        noun: 'folder'
    });

    wireCreateModal({
        buttonId: 'new-file-btn',
        modalId: 'newFileModal',
        inputId: 'new-file-input',
        confirmId: 'confirm-new-file-btn',
        endpoint: 'mkfile',
        label: 'File',
        noun: 'file',
        prefill: '.txt'
    });
})();
