// File editor enhancements — tab key inserts spaces, unsaved changes warning
(function () {
    var editor = document.getElementById('file-editor');
    if (!editor) return;

    var saved = true;

    editor.addEventListener('input', function () {
        saved = false;
    });

    // Tab key inserts 4 spaces instead of moving focus
    editor.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            var start = editor.selectionStart;
            var end = editor.selectionEnd;
            editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + 4;
            saved = false;
        }
    });

    var form = document.getElementById('editor-form');
    if (form) {
        var serverId = form.dataset.serverId;
        form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var btn = form.querySelector('button[type="submit"]');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
            }
            showOverlay('Saving file...', 'Please wait while your changes are applied.');

            var filePath = form.querySelector('input[name="filePath"]').value;
            var content = editor.value;
            var res = await apiFetch('/api/v1/servers/' + serverId + '/edit-file', {
                method: 'POST',
                body: { filePath: filePath, content: content }
            });
            hideOverlay();
            if (!res.ok) {
                showToast((res.data && (res.data.message || res.data.error)) || 'Failed to save file.', 'danger');
                if (btn) { btn.disabled = false; btn.textContent = 'Save File'; }
                return;
            }
            saved = true;
            flashToast('File saved.', 'success');
            var parentDir = filePath.split('/').slice(0, -1).join('/');
            window.location.href = '/servers/' + serverId + '/files' + (parentDir ? '/' + parentDir : '');
        });
    }

    // Warn about unsaved changes
    window.addEventListener('beforeunload', function (e) {
        if (!saved) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
})();
