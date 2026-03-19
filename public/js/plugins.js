/* global bootstrap */
(function () {
    'use strict';

    var serverId = window.location.pathname.split('/')[2];
    var csrf = document.getElementById('csrf-token')?.value || '';

    // ── Search / Filter ──

    var searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            var query = searchInput.value.toLowerCase();
            document.querySelectorAll('table tbody tr[data-filename]').forEach(function (row) {
                var name = row.getAttribute('data-filename').toLowerCase();
                row.style.display = name.includes(query) ? '' : 'none';
            });
        });
    }

    /**
     * Show a Bootstrap toast notification (matches flash.ejs style).
     */
    function showToast(message, type) {
        type = type || 'danger';
        var icons = { danger: 'error', success: 'check_circle', warning: 'warning', info: 'info' };
        var icon = icons[type] || 'error';
        var btnClass = type === 'warning' ? 'btn-close' : 'btn-close btn-close-white';

        var container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container position-fixed top-0 end-0 p-3';
            container.style.zIndex = '1090';
            document.body.appendChild(container);
        }

        var toastEl = document.createElement('div');
        toastEl.className = 'toast align-items-center text-bg-' + type + ' border-0';
        toastEl.setAttribute('role', 'alert');

        var wrapper = document.createElement('div');
        wrapper.className = 'd-flex';

        var body = document.createElement('div');
        body.className = 'toast-body d-flex align-items-center gap-2';

        var iconEl = document.createElement('span');
        iconEl.className = 'material-icons-outlined';
        iconEl.style.fontSize = '1.2rem';
        iconEl.textContent = icon;

        var msgEl = document.createElement('span');
        msgEl.textContent = message;

        body.appendChild(iconEl);
        body.appendChild(msgEl);

        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = btnClass + ' me-2 m-auto';
        closeBtn.setAttribute('data-bs-dismiss', 'toast');

        wrapper.appendChild(body);
        wrapper.appendChild(closeBtn);
        toastEl.appendChild(wrapper);

        container.appendChild(toastEl);
        var toast = new bootstrap.Toast(toastEl, { autohide: true, delay: 5000 });
        toastEl.addEventListener('hidden.bs.toast', function () { toastEl.remove(); });
        toast.show();
    }

    // ── Upload ──

    var fileInput = document.getElementById('file-input');
    var uploadBtn = document.getElementById('upload-btn');
    var uploadLabel = uploadBtn ? (uploadBtn.dataset.label || 'files') : 'files';

    if (fileInput && uploadBtn) {
        fileInput.addEventListener('change', function () {
            uploadBtn.disabled = fileInput.files.length === 0;
        });

        uploadBtn.addEventListener('click', async function () {
            if (fileInput.files.length === 0) return;

            uploadBtn.disabled = true;
            fileInput.disabled = true;
            showOverlay('Uploading ' + uploadLabel + '...', 'This may take a moment for large files.');

            var formData = new FormData();
            for (var i = 0; i < fileInput.files.length; i++) {
                formData.append('files', fileInput.files[i]);
            }

            try {
                var res = await fetch('/servers/' + serverId + '/plugins/upload', {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': csrf },
                    body: formData
                });

                var data = await res.json();
                if (res.ok && data.success) {
                    window.location.reload();
                } else {
                    showToast(data.error || 'Upload failed.', 'danger');
                    uploadBtn.disabled = false;
                    fileInput.disabled = false;
                    hideOverlay();
                }
            } catch {
                showToast('Upload failed. Please try again.', 'danger');
                uploadBtn.disabled = false;
                fileInput.disabled = false;
                hideOverlay();
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
                confirmDeleteBtn.textContent = 'Deleting...';

                try {
                    var res = await fetch('/servers/' + serverId + '/plugins/delete', {
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

                try {
                    var res = await fetch('/servers/' + serverId + '/plugins/delete-all', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrf
                        },
                        body: JSON.stringify({})
                    });

                    var data = await res.json();
                    if (res.ok && data.success) {
                        bsDeleteAllModal.hide();
                        window.location.reload();
                    } else {
                        showToast(data.error || 'Delete all failed.', 'danger');
                        confirmDeleteAllBtn.disabled = false;
                        confirmDeleteAllBtn.textContent = 'Delete All';
                    }
                } catch {
                    showToast('Delete all failed. Please try again.', 'danger');
                    confirmDeleteAllBtn.disabled = false;
                    confirmDeleteAllBtn.textContent = 'Delete All';
                }
            });
        }
    }
})();
