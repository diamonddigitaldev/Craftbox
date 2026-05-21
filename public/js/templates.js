(function () {
    var deleteModal = new bootstrap.Modal(document.getElementById('deleteTemplateModal'));
    var deleteNameSpan = document.getElementById('delete-template-name');
    var confirmBtn = document.getElementById('confirm-delete-template-btn');
    var pendingBtn = null;

    document.querySelectorAll('.delete-template-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            pendingBtn = btn;
            deleteNameSpan.textContent = btn.dataset.templateName;
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Delete';
            deleteModal.show();
        });
    });

    confirmBtn.addEventListener('click', async function () {
        if (!pendingBtn) return;

        var id = pendingBtn.dataset.templateId;

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';

        var res = await apiFetch('/api/v1/templates/' + id, { method: 'DELETE' });
        if (!res.ok) {
            deleteModal.hide();
            pendingBtn.disabled = false;
            showToast((res.data && (res.data.message || res.data.error)) || 'Delete failed.', 'danger');
            pendingBtn = null;
            return;
        }

        deleteModal.hide();

        var row = pendingBtn.closest('tr');
        if (row) row.remove();

        // Show empty state if no templates left
        var tbody = document.getElementById('templates-table');
        if (tbody && tbody.children.length === 0) {
            // Reload to render the empty-state UI; flashToast survives the navigation.
            flashToast('Template deleted.', 'success');
            location.reload();
        } else {
            showToast('Template deleted.', 'success');
        }

        pendingBtn = null;
    });
})();
