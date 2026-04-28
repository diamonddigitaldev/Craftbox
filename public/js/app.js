// Global Craftbox scripts — loaded on every page

// ── apiFetch: shared wrapper for /api/v1 calls from the frontend ──
// Automatically sets Content-Type + X-CSRF-Token on mutations and JSON-parses
// the response. Returns { ok, status, data }. Never throws on HTTP errors.
function _findCsrfToken() {
    var el = document.querySelector('input[name="_csrf"]');
    return el ? el.value : '';
}
async function apiFetch(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    var headers = Object.assign({}, options.headers || {});
    if (method !== 'GET' && method !== 'HEAD') {
        headers['X-CSRF-Token'] = headers['X-CSRF-Token'] || _findCsrfToken();
    }
    var body = options.body;
    // If body is a plain object, JSON-encode it and set the content type
    if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        body = JSON.stringify(body);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    var res;
    try {
        res = await fetch(path, { method: method, headers: headers, body: body });
    } catch (err) {
        return { ok: false, status: 0, data: { error: 'network_error', message: err.message } };
    }
    var data = null;
    if (res.status !== 204) {
        try { data = await res.json(); } catch (_) { data = null; }
    }
    return { ok: res.ok, status: res.status, data: data };
}

// ── Client-side date formatting ──
// Formats an ISO string to the user's local date/time.
// style: 'datetime' (default) = full date+time, 'date' = date only
function formatDate(isoString, style) {
    var d = new Date(isoString);
    if (style === 'date') {
        return d.toLocaleDateString();
    }
    return d.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
}

// Auto-format all .format-date elements on page load
document.querySelectorAll('.format-date[data-iso]').forEach(function (el) {
    el.textContent = formatDate(el.dataset.iso, el.dataset.style);
});

// Initialize Bootstrap toasts (auto-show flash messages)
document.querySelectorAll('.toast').forEach(function (el) {
    new bootstrap.Toast(el).show();
});

// ── Flash toast (survives a navigation) ──
// Use when a toast must be visible AFTER a reload / location change.
// showToast() called immediately before window.location.reload() is wiped by
// the navigation; flashToast() instead stashes the toast in sessionStorage,
// and the drain handler below replays it on the destination page exactly once.
function flashToast(message, type) {
    try {
        var queue = JSON.parse(sessionStorage.getItem('craftboxFlashToasts') || '[]');
        if (!Array.isArray(queue)) queue = [];
        queue.push({ message: String(message), type: type || 'info' });
        sessionStorage.setItem('craftboxFlashToasts', JSON.stringify(queue));
    } catch (_) {
        // sessionStorage unavailable (private mode / quota) — fall back to a
        // direct toast. It will be wiped by an imminent reload, but better
        // than silently dropping the message.
        showToast(message, type);
    }
}

// Drain queued flash toasts on every page load. Clear FIRST so any unexpected
// re-execution of this script (rare but possible with bfcache restoration)
// cannot replay them.
(function drainFlashToasts() {
    try {
        var raw = sessionStorage.getItem('craftboxFlashToasts');
        if (!raw) return;
        sessionStorage.removeItem('craftboxFlashToasts');
        var queue = JSON.parse(raw);
        if (!Array.isArray(queue)) return;
        queue.forEach(function (item) {
            if (item && item.message) showToast(item.message, item.type || 'info');
        });
    } catch (_) { /* ignore */ }
})();

// ── Show a Bootstrap toast notification (matches flash.ejs style) ──
// type: 'danger' | 'success' | 'warning' | 'info' (defaults to 'danger')
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

var _overlayVisible = false;

function isOverlayVisible() {
    return _overlayVisible;
}

function showOverlay(title, desc) {
    var el = _getOverlay();
    document.getElementById('overlay-title').textContent = title || '';
    document.getElementById('overlay-desc').innerHTML = desc || '';
    el.classList.remove('d-none');
    _overlayVisible = true;
}

function hideOverlay() {
    if (_overlayEl) _overlayEl.classList.add('d-none');
    _overlayVisible = false;
}
