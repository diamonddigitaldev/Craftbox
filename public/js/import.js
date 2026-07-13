// Server import (transfer archive upload) on the dashboard
(function () {
    var modalEl = document.getElementById('importServerModal');
    if (!modalEl) return;

    var fileInput = document.getElementById('import-file');
    var confirmBtn = document.getElementById('import-confirm');
    var confirmBtnHtml = confirmBtn.innerHTML;
    var progressWrap = document.getElementById('import-progress');
    var progressBar = progressWrap.querySelector('.progress-bar');
    var importBtn = document.getElementById('import-server-btn');
    var uploading = false;
    var currentUpload = null; // AbortController while an upload is running

    var mrpackModalEl = document.getElementById('mrpackCreateModal');

    function isModalOpen() {
        return modalEl.classList.contains('show')
            || (mrpackModalEl && mrpackModalEl.classList.contains('show'));
    }

    function resetModal() {
        uploading = false;
        fileInput.value = '';
        fileInput.disabled = false;
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = confirmBtnHtml;
        progressWrap.classList.add('d-none');
        progressBar.style.width = '0%';
    }

    importBtn?.addEventListener('click', function () {
        resetModal();
        // getOrCreateInstance, never `new`: a second Modal instance on an
        // already-shown element creates a second backdrop that is orphaned on
        // close, leaving the page stuck under a dark overlay.
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });

    fileInput.addEventListener('change', function () {
        confirmBtn.disabled = uploading || !fileInput.files.length;
    });

    function startImport(file) {
        if (!file || uploading) return;
        uploading = true;
        currentUpload = new AbortController();

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Importing...';
        fileInput.disabled = true;
        progressWrap.classList.remove('d-none');

        function fail(message) {
            showToast(message || 'Import failed.', 'danger');
            uploading = false;
            fileInput.disabled = false;
            confirmBtn.innerHTML = confirmBtnHtml;
            confirmBtn.disabled = !fileInput.files.length;
            progressWrap.classList.add('d-none');
            progressBar.style.width = '0%';
        }

        // uploadFile (dgup.js) sends small archives as a single multipart POST
        // and chunks anything larger, so multi-GB transfers survive proxies
        // with request-body caps (e.g. Cloudflare Tunnel's 100 MB).
        uploadFile('/api/v1/servers/import', file, {
            fieldName: 'archive',
            signal: currentUpload.signal,
            onProgress: function (loaded, total) {
                progressBar.style.width = Math.round((loaded / total) * 100) + '%';
            }
        }).then(function (res) {
            currentUpload = null;
            if (res.aborted) {
                showToast('Import cancelled.', 'info');
                resetModal();
                return;
            }
            var data = res.data || {};
            if (res.status !== 201) {
                fail(data && data.error);
                return;
            }
            (data.warnings || []).forEach(function (w) { flashToast(w, 'warning'); });
            flashToast('Import started — extracting files...', 'info');
            var serverId = data.server && data.server.id;
            window.location.href = serverId ? '/servers/' + serverId : '/dashboard';
        });
    }

    confirmBtn.addEventListener('click', function () {
        startImport(fileInput.files[0]);
    });

    // Closing the modal mid-upload (Cancel button, X, Esc, backdrop click)
    // aborts the transfer and frees the server-side upload session.
    modalEl.addEventListener('hide.bs.modal', function () {
        if (currentUpload) currentUpload.abort();
    });

    // Submit on Enter while the modal is open
    modalEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        if (confirmBtn.disabled || uploading) return;
        e.preventDefault();
        startImport(fileInput.files[0]);
    });

    // ── Drag & Drop (mirrors the plugins page JAR drop) ──

    // Always prevent default drop behavior so Chrome doesn't open files in a new tab
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });

    var dropOverlay = document.getElementById('import-drop-overlay');
    if (dropOverlay) {
        var dragCounter = 0;

        function hideDropOverlay() {
            dragCounter = 0;
            dropOverlay.classList.add('d-none');
            dropOverlay.classList.remove('d-flex');
        }

        // No overlay while the import modal is open: the modal is already the
        // drop target, and the overlay (z-index 1050) would render BEHIND the
        // modal dialog (1055) as a broken-looking background blur. Dropping
        // still works — the drop handler below runs either way.
        document.addEventListener('dragenter', function (e) {
            e.preventDefault();
            if (isOverlayVisible() || uploading || isModalOpen()) return;
            dragCounter++;
            if (dragCounter === 1) {
                dropOverlay.classList.remove('d-none');
                dropOverlay.classList.add('d-flex');
            }
        });

        document.addEventListener('dragleave', function (e) {
            e.preventDefault();
            if (isOverlayVisible() || uploading || isModalOpen()) return;
            dragCounter--;
            if (dragCounter === 0) hideDropOverlay();
        });

        document.addEventListener('drop', function (e) {
            if (isOverlayVisible() || uploading || mrpackUploading) return;
            hideDropOverlay();
            if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;

            // .mrpack -> create a new server from the modpack; .zip -> import
            var mrpackFile = Array.prototype.find.call(e.dataTransfer.files, function (f) {
                return f.name.toLowerCase().endsWith('.mrpack');
            });
            if (mrpackFile) {
                openMrpackModal(mrpackFile);
                return;
            }

            var zipFile = Array.prototype.find.call(e.dataTransfer.files, function (f) {
                return f.name.toLowerCase().endsWith('.zip');
            });
            if (!zipFile) {
                showToast('Drop a .zip transfer archive to import, or a .mrpack modpack to create a server.', 'danger');
                return;
            }

            // Show the modal (with the file reflected in the input) and start
            // uploading immediately, like the plugins page. The modal may
            // already be open (user clicked Import, then dropped a file) —
            // getOrCreateInstance reuses the live instance, and show() is a
            // no-op while shown, so no duplicate backdrop.
            resetModal();
            try {
                var dt = new DataTransfer();
                dt.items.add(zipFile);
                fileInput.files = dt.files;
            } catch (_) { /* input stays empty — upload proceeds regardless */ }
            bootstrap.Modal.getOrCreateInstance(modalEl).show();
            startImport(zipFile);
        });
    }

    // ── Create server from a dropped .mrpack ──

    var mrpackForm = document.getElementById('mrpack-create-form');
    var mrpackConfirmBtn = document.getElementById('mrpack-create-confirm');
    var mrpackConfirmHtml = mrpackConfirmBtn ? mrpackConfirmBtn.innerHTML : '';
    var mrpackProgressWrap = document.getElementById('mrpack-progress');
    var mrpackProgressBar = mrpackProgressWrap ? mrpackProgressWrap.querySelector('.progress-bar') : null;
    var mrpackDroppedFile = null;
    var mrpackUploading = false;
    var mrpackUpload = null; // AbortController while an upload is running

    function openMrpackModal(file) {
        if (!mrpackModalEl || !mrpackForm) return;
        mrpackDroppedFile = file;
        mrpackUploading = false;
        mrpackConfirmBtn.innerHTML = mrpackConfirmHtml;
        mrpackProgressWrap.classList.add('d-none');
        mrpackProgressBar.style.width = '0%';
        document.getElementById('mrpack-drop-filename').textContent = file.name;

        // Suggest a server name from the pack filename (allowed charset only)
        var nameInput = document.getElementById('mrpack-name');
        if (!nameInput.value.trim()) {
            nameInput.value = file.name
                .replace(/\.mrpack$/i, '')
                .replace(/[^a-zA-Z0-9 _\-]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 50);
        }
        // Re-run the shared data-validate-required check against the new values
        mrpackForm.dispatchEvent(new Event('input'));
        bootstrap.Modal.getOrCreateInstance(mrpackModalEl).show();
    }

    if (mrpackForm) {
        mrpackForm.addEventListener('submit', function (e) {
            e.preventDefault();
            if (mrpackUploading || !mrpackDroppedFile) return;
            if (!mrpackForm.reportValidity()) return;

            mrpackUploading = true;
            mrpackUpload = new AbortController();
            mrpackConfirmBtn.disabled = true;
            mrpackConfirmBtn.innerHTML =
                '<span class="spinner-border spinner-border-sm" role="status"></span> Creating...';
            mrpackProgressWrap.classList.remove('d-none');

            uploadFile('/api/v1/servers/from-mrpack', mrpackDroppedFile, {
                fieldName: 'mrpack',
                signal: mrpackUpload.signal,
                fields: {
                    name: document.getElementById('mrpack-name').value.trim(),
                    port: document.getElementById('mrpack-port').value,
                    memory: document.getElementById('mrpack-memory').value,
                    eula: document.getElementById('mrpack-eula').checked ? 'true' : 'false'
                },
                onProgress: function (loaded, total) {
                    mrpackProgressBar.style.width = Math.round((loaded / total) * 100) + '%';
                }
            }).then(function (res) {
                mrpackUpload = null;
                mrpackUploading = false;
                if (res.aborted) {
                    showToast('Upload cancelled.', 'info');
                    mrpackConfirmBtn.innerHTML = mrpackConfirmHtml;
                    mrpackForm.dispatchEvent(new Event('input'));
                    return;
                }
                if (res.status !== 201) {
                    showToast((res.data && (res.data.message || res.data.error)) || 'Failed to create server from modpack.', 'danger');
                    mrpackConfirmBtn.innerHTML = mrpackConfirmHtml;
                    mrpackProgressWrap.classList.add('d-none');
                    mrpackProgressBar.style.width = '0%';
                    mrpackForm.dispatchEvent(new Event('input'));
                    return;
                }
                flashToast('Modpack uploaded — installing...', 'info');
                var serverId = res.data && res.data.server && res.data.server.id;
                window.location.href = serverId ? '/servers/' + serverId : '/dashboard';
            });
        });

        // Closing the modal mid-upload aborts the transfer, like import
        mrpackModalEl.addEventListener('hide.bs.modal', function () {
            if (mrpackUpload) mrpackUpload.abort();
        });
    }
})();
