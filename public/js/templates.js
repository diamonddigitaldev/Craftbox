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
        var csrf = pendingBtn.dataset.csrf;

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';

        try {
            var res = await fetch('/api/templates/' + id, {
                method: 'DELETE',
                headers: { 'x-csrf-token': csrf }
            });

            if (!res.ok) {
                var data = await res.json().catch(function () { return {}; });
                throw new Error(data.error || 'Delete failed.');
            }

            deleteModal.hide();

            var row = pendingBtn.closest('tr');
            if (row) row.remove();

            // Show empty state if no templates left
            var tbody = document.getElementById('templates-table');
            if (tbody && tbody.children.length === 0) {
                location.reload();
            }
        } catch (err) {
            deleteModal.hide();
            pendingBtn.disabled = false;
        }

        pendingBtn = null;
    });
})();
