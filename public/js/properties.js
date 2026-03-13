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
