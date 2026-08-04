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

    // Mirrors safeEntryName + newNameError (src/utils/fileBrowser.js) so the
    // confirm button only lights up for a name the API would actually accept.
    // The server still re-checks — this just saves a round trip to be told no.
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

    // ── Search / Filter ──

    var searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            var query = searchInput.value.toLowerCase();
            document.querySelectorAll('table tbody tr[data-filename]').forEach(function (row) {
                var name = row.getAttribute('data-filename').toLowerCase();
                row.style.display = (!query || name.includes(query)) ? '' : 'none';
            });
        });
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

        function unlock() {
            if (uploadBtn) uploadBtn.disabled = false;
            if (fileInput) fileInput.disabled = false;
            hideOverlay();
        }

        if (failure && uploadedCount > 0) {
            // Some files landed before the failure — reload to show them.
            flashToast(uploadedCount + ' ' + noun + ' uploaded, then: ' + failure, 'warning');
            window.location.reload();
        } else if (failure) {
            showToast(failure, 'danger');
            unlock();
        } else if (uploadedCount === 0) {
            // Nothing made it through — show a danger toast and stay put.
            showToast(rejectedCount === 1
                ? 'File rejected: ' + ((rejected[0] && rejected[0].reason) || 'unknown reason') + '.'
                : 'No files uploaded — all ' + rejectedCount + ' were rejected.', 'danger');
            unlock();
        } else if (rejectedCount > 0) {
            // Partial success — reload to show what landed, with a warning toast.
            flashToast(uploadedCount + ' ' + noun + ' uploaded' + replacedNote
                + ', ' + rejectedCount + ' rejected.', 'warning');
            window.location.reload();
        } else {
            flashToast(uploadedCount + ' ' + noun + ' uploaded' + replacedNote + '.', 'success');
            window.location.reload();
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

    // Always prevent default drop behavior so Chrome doesn't open files in a new tab
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });

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

            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                uploadFiles(e.dataTransfer.files);
            }
        });
    }

    // ── Delete ──

    var deleteModal = document.getElementById('deleteModal');
    var deleteTitleEl = document.getElementById('delete-title');
    var deleteBodyEl = document.getElementById('delete-body');
    var confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    var pendingDelete = null;

    if (deleteModal) {
        var bsDeleteModal = new bootstrap.Modal(deleteModal);

        document.querySelectorAll('.delete-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var row = btn.closest('tr[data-path]');
                if (!row) return;
                pendingDelete = {
                    path: row.getAttribute('data-path'),
                    name: row.getAttribute('data-filename'),
                    isDirectory: row.getAttribute('data-directory') === 'true'
                };

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
        });

        if (confirmDeleteBtn) {
            confirmDeleteBtn.addEventListener('click', async function () {
                if (!pendingDelete) return;

                confirmDeleteBtn.disabled = true;
                confirmDeleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';

                try {
                    var res = await apiFetch('/api/v1/servers/' + serverId + '/files/delete', {
                        method: 'POST',
                        body: { path: pendingDelete.path }
                    });

                    var data = res.data || {};
                    if (res.ok && data.success) {
                        bsDeleteModal.hide();
                        flashToast((pendingDelete.isDirectory ? 'Folder' : 'File') + ' deleted.', 'success');
                        window.location.reload();
                    } else {
                        showToast(data.error || 'Delete failed.', 'danger');
                        confirmDeleteBtn.disabled = false;
                        confirmDeleteBtn.textContent = 'Delete';
                    }
                } catch {
                    showToast('Delete failed. Please try again.', 'danger');
                    confirmDeleteBtn.disabled = false;
                    confirmDeleteBtn.textContent = 'Delete';
                }
            });
        }
    }

    // ── Rename ──

    var renameModal = document.getElementById('renameModal');
    var renameTitleEl = document.getElementById('rename-title');
    var renameInput = document.getElementById('rename-input');
    var confirmRenameBtn = document.getElementById('confirm-rename-btn');
    var pendingRename = null;

    if (renameModal) {
        var bsRenameModal = new bootstrap.Modal(renameModal);

        // Renaming to the current name is a no-op the modal handles by just
        // closing, so only the name's own validity gates the button.
        function updateRenameConfirm() {
            confirmRenameBtn.disabled = !!nameError(renameInput.value);
        }

        renameInput.addEventListener('input', updateRenameConfirm);

        document.querySelectorAll('.rename-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var row = btn.closest('tr[data-path]');
                if (!row) return;
                pendingRename = {
                    path: row.getAttribute('data-path'),
                    name: row.getAttribute('data-filename'),
                    isDirectory: row.getAttribute('data-directory') === 'true'
                };
                renameTitleEl.textContent = pendingRename.isDirectory ? 'Rename Folder' : 'Rename File';
                renameInput.value = pendingRename.name;
                updateRenameConfirm();
                bsRenameModal.show();
            });
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
                        flashToast('Renamed to "' + data.name + '".', 'success');
                        window.location.reload();
                    } else {
                        showToast(data.error || 'Rename failed.', 'danger');
                        confirmRenameBtn.textContent = 'Rename';
                        updateRenameConfirm();
                    }
                } catch {
                    showToast('Rename failed. Please try again.', 'danger');
                    confirmRenameBtn.textContent = 'Rename';
                    updateRenameConfirm();
                }
            });
        }
    }

    // ── New Folder ──

    var newFolderBtn = document.getElementById('new-folder-btn');
    var newFolderModal = document.getElementById('newFolderModal');
    var newFolderInput = document.getElementById('new-folder-input');
    var confirmNewFolderBtn = document.getElementById('confirm-new-folder-btn');

    if (newFolderBtn && newFolderModal) {
        var bsNewFolderModal = new bootstrap.Modal(newFolderModal);

        function updateNewFolderConfirm() {
            confirmNewFolderBtn.disabled = !!nameError(newFolderInput.value);
        }

        newFolderInput.addEventListener('input', updateNewFolderConfirm);

        newFolderBtn.addEventListener('click', function () {
            newFolderInput.value = '';
            updateNewFolderConfirm();
            bsNewFolderModal.show();
        });

        newFolderModal.addEventListener('shown.bs.modal', function () {
            newFolderInput.focus();
        });

        newFolderInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmNewFolderBtn.click();
            }
        });

        if (confirmNewFolderBtn) {
            confirmNewFolderBtn.addEventListener('click', async function () {
                var name = newFolderInput.value.trim();
                var problem = nameError(name);
                if (problem) {
                    showToast(problem, 'warning');
                    return;
                }

                confirmNewFolderBtn.disabled = true;
                confirmNewFolderBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Creating...';

                try {
                    var res = await apiFetch('/api/v1/servers/' + serverId + '/files/mkdir', {
                        method: 'POST',
                        body: { path: currentPath, name: name }
                    });

                    var data = res.data || {};
                    if (res.ok && data.success) {
                        bsNewFolderModal.hide();
                        flashToast('Folder "' + data.name + '" created in ' + locationLabel + '.', 'success');
                        window.location.reload();
                    } else {
                        showToast(data.error || 'Could not create the folder.', 'danger');
                        confirmNewFolderBtn.textContent = 'Create';
                        updateNewFolderConfirm();
                    }
                } catch {
                    showToast('Could not create the folder. Please try again.', 'danger');
                    confirmNewFolderBtn.textContent = 'Create';
                    updateNewFolderConfirm();
                }
            });
        }
    }
})();
