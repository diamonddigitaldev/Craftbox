// Server import (transfer archive upload) on the dashboard
(function () {
    var modalEl = document.getElementById('importServerModal');
    if (!modalEl) return;

    var fileInput = document.getElementById('import-file');
    var confirmBtn = document.getElementById('import-confirm');
    var progressWrap = document.getElementById('import-progress');
    var progressBar = progressWrap.querySelector('.progress-bar');
    var importBtn = document.getElementById('import-server-btn');

    importBtn?.addEventListener('click', function () {
        fileInput.value = '';
        fileInput.disabled = false;
        confirmBtn.disabled = true;
        progressWrap.classList.add('d-none');
        progressBar.style.width = '0%';
        new bootstrap.Modal(modalEl).show();
    });

    fileInput.addEventListener('change', function () {
        confirmBtn.disabled = !fileInput.files.length;
    });

    confirmBtn.addEventListener('click', function () {
        var file = fileInput.files[0];
        if (!file) return;

        confirmBtn.disabled = true;
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
            confirmBtn.disabled = false;
            fileInput.disabled = false;
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
    });
})();
