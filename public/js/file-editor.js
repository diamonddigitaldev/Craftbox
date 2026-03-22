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

    // Mark saved on form submit
    var form = document.getElementById('editor-form');
    if (form) {
        form.addEventListener('submit', function () {
            saved = true;
            showOverlay('Saving file...', 'Please wait while your changes are applied.');
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
