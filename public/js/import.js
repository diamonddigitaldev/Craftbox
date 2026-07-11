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
        new bootstrap.Modal(modalEl).show();
    });

    fileInput.addEventListener('change', function () {
        confirmBtn.disabled = uploading || !fileInput.files.length;
    });

    function startImport(file) {
        if (!file || uploading) return;
        uploading = true;

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Importing...';
        fileInput.disabled = true;
        progressWrap.classList.remove('d-none');

        var formData = new FormData();
        formData.append('archive', file);

        // XMLHttpRequest instead of apiFetch — fetch has no upload-progress
        // events, and transfer archives can be gigabytes.
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/v1/servers/import');
        xhr.setRequestHeader('X-CSRF-Token', _findCsrfToken());
        xhr.responseType = 'json';

        xhr.upload.addEventListener('progress', function (e) {
            if (e.lengthComputable) {
                progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
            }
        });

        function fail(message) {
            showToast(message || 'Import failed.', 'danger');
            uploading = false;
            fileInput.disabled = false;
            confirmBtn.innerHTML = confirmBtnHtml;
            confirmBtn.disabled = !fileInput.files.length;
            progressWrap.classList.add('d-none');
            progressBar.style.width = '0%';
        }

        xhr.addEventListener('load', function () {
            var data = xhr.response || {};
            if (xhr.status !== 201) {
                fail(data && data.error);
                return;
            }
            (data.warnings || []).forEach(function (w) { flashToast(w, 'warning'); });
            flashToast('Import started — extracting files...', 'info');
            var serverId = data.server && data.server.id;
            window.location.href = serverId ? '/servers/' + serverId : '/dashboard';
        });
        xhr.addEventListener('error', function () {
            fail('Upload failed. Check your connection and try again.');
        });
        xhr.send(formData);
    }

    confirmBtn.addEventListener('click', function () {
        startImport(fileInput.files[0]);
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

        document.addEventListener('dragenter', function (e) {
            e.preventDefault();
            if (isOverlayVisible() || uploading) return;
            dragCounter++;
            if (dragCounter === 1) {
                dropOverlay.classList.remove('d-none');
                dropOverlay.classList.add('d-flex');
            }
        });

        document.addEventListener('dragleave', function (e) {
            e.preventDefault();
            if (isOverlayVisible() || uploading) return;
            dragCounter--;
            if (dragCounter === 0) hideDropOverlay();
        });

        document.addEventListener('drop', function (e) {
            if (isOverlayVisible() || uploading) return;
            hideDropOverlay();
            if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;

            var zipFile = Array.prototype.find.call(e.dataTransfer.files, function (f) {
                return f.name.toLowerCase().endsWith('.zip');
            });
            if (!zipFile) {
                showToast('Only .zip transfer archives can be imported.', 'danger');
                return;
            }

            // Show the modal (with the file reflected in the input) and start
            // uploading immediately, like the plugins page.
            resetModal();
            try {
                var dt = new DataTransfer();
                dt.items.add(zipFile);
                fileInput.files = dt.files;
            } catch (_) { /* input stays empty — upload proceeds regardless */ }
            new bootstrap.Modal(modalEl).show();
            startImport(zipFile);
        });
    }
})();
