// Show overlay on save
(function () {
    var form = document.querySelector('form[action$="/properties"]');
    if (!form) return;
    form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        }
        showOverlay('Saving properties...', 'Please wait while your changes are applied.');
    });
})();

// Update Enabled/Disabled label text when boolean toggles are changed
(function () {
    document.querySelectorAll('.prop-toggle').forEach(function (input) {
        input.addEventListener('change', function () {
            var label = input.parentElement.querySelector('.prop-toggle-label');
            if (label) {
                label.textContent = input.checked ? 'Enabled' : 'Disabled';
            }
        });
    });
})();
