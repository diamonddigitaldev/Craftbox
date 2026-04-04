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

// Restore saved library URLs for Browse tab and Back to Library button
(function () {
    var match = window.location.pathname.match(/\/servers\/([^/]+)/);
    if (!match) return;
    var id = match[1];

    // Browse tab → restore to last visited page (listing or project)
    var tabUrl = sessionStorage.getItem('libraryUrl:' + id);
    if (tabUrl) {
        document.querySelectorAll('a.nav-link[href*="/plugins/browse"]').forEach(function (el) { el.href = tabUrl; });
    }

    // Back button → always go to the listing page (not a project page)
    var listUrl = sessionStorage.getItem('libraryListUrl:' + id);
    if (listUrl) {
        var backBtn = document.getElementById('back-to-library');
        if (backBtn) backBtn.href = listUrl;
    }
})();

// ── Shared toast helper ──
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
    toastEl.innerHTML =
        '<div class="d-flex">' +
            '<div class="toast-body d-flex align-items-center gap-2">' +
                '<span class="material-icons-outlined" style="font-size: 1.2rem;">' + icon + '</span>' +
                '<span>' + message + '</span>' +
            '</div>' +
            '<button type="button" class="' + btnClass + ' me-2 m-auto" data-bs-dismiss="toast"></button>' +
        '</div>';

    container.appendChild(toastEl);
    new bootstrap.Toast(toastEl, { autohide: true, delay: 5000 }).show();
    toastEl.addEventListener('hidden.bs.toast', function () { toastEl.remove(); });
}

// ── Shared HTML escape helper ──
function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

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
