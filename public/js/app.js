// Global Craftbox scripts — loaded on every page

// Initialize Bootstrap toasts (auto-show flash messages)
document.querySelectorAll('.toast').forEach(function (el) {
    new bootstrap.Toast(el).show();
});

// ── Required field validation — disable submit until all required fields are filled ──
// Applies to any <form> with a [data-validate-required] submit button inside it.
// The button stays disabled/muted until every [required] input in the form has a value.
(function () {
    var buttons = document.querySelectorAll('[data-validate-required]');
    buttons.forEach(function (btn) {
        var form = btn.closest('form') || btn.closest('[data-form-scope]');
        if (!form) return;

        function check() {
            var fields = form.querySelectorAll('[required]');
            var allFilled = true;
            fields.forEach(function (f) {
                if (f.type === 'checkbox') {
                    if (!f.checked) allFilled = false;
                } else if (!f.value.trim()) {
                    allFilled = false;
                }
            });
            btn.disabled = !allFilled;
        }

        // Listen on all current and future required inputs
        form.addEventListener('input', check);
        form.addEventListener('change', check);

        // Initial state
        check();
    });
})();

// ── Shared overlay spinner ──
var _overlayEl = null;
function _getOverlay() {
    if (_overlayEl) return _overlayEl;
    _overlayEl = document.createElement('div');
    _overlayEl.className = 'd-none position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center';
    _overlayEl.style.cssText = 'z-index: 1050; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);';
    _overlayEl.innerHTML =
        '<div class="text-center">' +
            '<div class="spinner-border text-success mb-3" style="width: 3rem; height: 3rem;" role="status">' +
                '<span class="visually-hidden">Loading...</span>' +
            '</div>' +
            '<h5 class="mb-1" id="overlay-title"></h5>' +
            '<p class="text-body-secondary mb-0" id="overlay-desc"></p>' +
        '</div>';
    document.body.appendChild(_overlayEl);
    return _overlayEl;
}

function showOverlay(title, desc) {
    var el = _getOverlay();
    document.getElementById('overlay-title').textContent = title || '';
    document.getElementById('overlay-desc').innerHTML = desc || '';
    el.classList.remove('d-none');
}

function hideOverlay() {
    if (_overlayEl) _overlayEl.classList.add('d-none');
}
