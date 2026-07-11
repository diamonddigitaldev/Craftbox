/* global bootstrap */
(function () {
    'use strict';

    var serverId = window.location.pathname.split('/')[2];
    var csrf = document.getElementById('csrf-token')?.value || '';

    // ── Search / Filter ──

    var searchQuery = '';
    var envFilter = '';

    function applyFilters() {
        document.querySelectorAll('table tbody tr[data-filename]').forEach(function (row) {
            var name = row.getAttribute('data-filename').toLowerCase();
            var env = row.getAttribute('data-env') || 'both';
            var matchSearch = !searchQuery || name.includes(searchQuery);
            var matchEnv = !envFilter || env === envFilter;
            row.style.display = (matchSearch && matchEnv) ? '' : 'none';
        });
    }

    var searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            searchQuery = searchInput.value.toLowerCase();
            applyFilters();
        });
    }

    var envFilterSelect = document.getElementById('env-filter');
    if (envFilterSelect) {
        envFilterSelect.addEventListener('change', function () {
            envFilter = envFilterSelect.value;
            applyFilters();
        });
    }

    // ── Mod / Plugin terminology (sourced from upload-btn data-label, set by views/servers/plugins.ejs) ──

    var uploadBtn = document.getElementById('upload-btn');
    var contentLabel = uploadBtn ? (uploadBtn.dataset.label || 'plugins') : 'plugins';
    var contentSingular = contentLabel === 'mods' ? 'mod' : 'plugin';
    var contentSingularCap = contentSingular.charAt(0).toUpperCase() + contentSingular.slice(1);

    // ── Environment change ──

    document.querySelectorAll('.env-select').forEach(function (sel) {
        var previousValue = sel.value;
        sel.addEventListener('change', async function () {
            var filename = sel.getAttribute('data-filename');
            var newValue = sel.value;
            sel.disabled = true;
            try {
                var res = await fetch('/api/v1/servers/' + serverId + '/plugins/environment', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf
                    },
                    body: JSON.stringify({ filename: filename, environment: newValue })
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    var row = sel.closest('tr[data-filename]');
                    if (row) row.setAttribute('data-env', newValue);
                    previousValue = newValue;
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
    });

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
        var failure = null;

        try {
            var totalBytes = jarFiles.reduce(function (sum, f) { return sum + f.size; }, 0);
            if (jarFiles.length > 0 && totalBytes <= DGUP_THRESHOLD) {
                // Small selection — one multipart request for all files, as before.
                var formData = new FormData();
                for (var i = 0; i < jarFiles.length; i++) {
                    formData.append('files', jarFiles[i]);
                }
                var res = await fetch('/api/v1/servers/' + serverId + '/plugins/upload', {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': csrf },
                    body: formData
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    uploaded = data.uploaded || [];
                    rejected = rejected.concat(data.rejected || []);
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

        if (failure && uploadedCount > 0) {
            // Some files landed before the failure — reload to show them.
            flashToast(uploadedCount + ' ' + noun + ' uploaded, then: ' + failure, 'warning');
            window.location.reload();
        } else if (failure) {
            showToast(failure, 'danger');
            if (uploadBtn) uploadBtn.disabled = false;
            if (fileInput) fileInput.disabled = false;
            hideOverlay();
        } else if (uploadedCount === 0) {
            // Nothing made it through — show a danger toast and stay on the page.
            var allRejectedMsg = rejectedCount === 1
                ? 'File rejected: ' + ((rejected[0] && rejected[0].reason) || 'not a valid JAR') + '.'
                : 'No files uploaded — all ' + rejectedCount + ' were rejected.';
            showToast(allRejectedMsg, 'danger');
            if (uploadBtn) uploadBtn.disabled = false;
            if (fileInput) fileInput.disabled = false;
            hideOverlay();
        } else if (rejectedCount > 0) {
            // Partial success — reload to show what landed, with a warning toast.
            flashToast(uploadedCount + ' ' + noun + ' uploaded, ' + rejectedCount + ' rejected.', 'warning');
            window.location.reload();
        } else {
            // Clean success path.
            flashToast(uploadedCount + ' ' + noun + ' uploaded.', 'success');
            window.location.reload();
        }
    }

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
    var deleteFilenameEl = document.getElementById('delete-filename');
    var confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    var pendingDeleteFilename = null;

    if (deleteModal) {
        var bsDeleteModal = new bootstrap.Modal(deleteModal);

        document.querySelectorAll('.delete-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                pendingDeleteFilename = btn.getAttribute('data-filename');
                if (deleteFilenameEl) deleteFilenameEl.textContent = pendingDeleteFilename;
                bsDeleteModal.show();
            });
        });

        if (confirmDeleteBtn) {
            confirmDeleteBtn.addEventListener('click', async function () {
                if (!pendingDeleteFilename) return;

                confirmDeleteBtn.disabled = true;
                confirmDeleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';

                try {
                    var res = await fetch('/api/v1/servers/' + serverId + '/plugins/delete', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrf
                        },
                        body: JSON.stringify({ filename: pendingDeleteFilename })
                    });

                    var data = await res.json();
                    if (res.ok && data.success) {
                        bsDeleteModal.hide();
                        flashToast(contentSingularCap + ' deleted.', 'success');
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
                    var res = await fetch('/api/v1/servers/' + serverId + '/plugins/delete-all', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrf
                        },
                        body: JSON.stringify({})
                    });

                    var data = await res.json();
                    if (res.ok && data.success) {
                        flashToast('All ' + contentLabel + ' deleted.', 'success');
                        window.location.reload();
                    } else {
                        hideOverlay();
                        showToast(data.error || 'Delete all failed.', 'danger');
                        confirmDeleteAllBtn.disabled = false;
                        confirmDeleteAllBtn.textContent = 'Delete All';
                    }
                } catch {
                    hideOverlay();
                    showToast('Delete all failed. Please try again.', 'danger');
                    confirmDeleteAllBtn.disabled = false;
                    confirmDeleteAllBtn.textContent = 'Delete All';
                }
            });
        }
    }
})();
