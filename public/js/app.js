// Global Craftbox scripts — loaded on every page

// Per-tab id, sent with every mutation so the tab that made a change can ignore
// its own live-update broadcast (it already updated its own DOM / navigated).
window.CRAFTBOX_CLIENT_ID = window.CRAFTBOX_CLIENT_ID
    || (Date.now().toString(36) + Math.random().toString(36).slice(2));

// ── apiFetch: shared wrapper for /api/v1 calls from the frontend ──
// Automatically sets Content-Type + X-CSRF-Token on mutations and JSON-parses
// the response. Returns { ok, status, data }. Never throws on HTTP errors.
function _findCsrfToken() {
    var el = document.querySelector('input[name="_csrf"]');
    if (el) return el.value;
    // Some pages (plugins, backups) expose the token as #csrf-token instead
    el = document.getElementById('csrf-token');
    return el ? el.value : '';
}
async function apiFetch(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    var headers = Object.assign({}, options.headers || {});
    headers['X-Client-Id'] = headers['X-Client-Id'] || window.CRAFTBOX_CLIENT_ID;
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
    if (res.status === 401) _handleSessionExpired();
    return { ok: res.ok, status: res.status, data: data };
}

// ── Session expiry ──
// Sessions are a 1-hour rolling idle timeout, so a tab left open overnight is
// signed out without anything on screen saying so. Every frontend call goes to
// /api/v1, which is guarded by ensureApiAuth ahead of CSRF validation, so an
// expired session is always a clean 401 — whose bare {error:'unauthorized'}
// body would otherwise reach the user as an unexplained "unauthorized" toast.
// Explain it instead and send them to sign in; ensureAuth's returnTo brings
// them back to the page they were on.
// The latch matters: pages fire several calls at once, and without it each one
// queues its own toast and races its own redirect.
var _sessionExpiredHandled = false;
function _handleSessionExpired() {
    if (_sessionExpiredHandled) return;
    if (window.location.pathname === '/login') return;
    _sessionExpiredHandled = true;
    flashToast('Your session has expired. Please sign in again.', 'warning');
    window.location.href = '/login';
}

// The server rejects a WebSocket upgrade from an expired session with a 401,
// but browsers hide the handshake status from JS — all a client sees is a close
// with code 1006, identical to a network blip. So once a socket has failed to
// reconnect a few times, spend one cheap authenticated request to find out
// which it is: a 401 routes into the handling above, anything else means the
// panel is simply unreachable and the existing backoff should carry on.
// Called from every reconnect loop; probes at the 3rd failure and every 3rd
// after, which the 30s backoff cap keeps to at most one probe per 90s.
function probeSessionAfterFailures(attempts) {
    if (attempts < 3 || attempts % 3 !== 0) return;
    apiFetch('/api/v1/servers');
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

// Formats a Date as a short relative age: "just now", "5m ago", "2h ago", "3d ago".
function timeAgo(date) {
    var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
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

// ── Wait for a background operation to finish ──
// Resolves with the `operation` WebSocket message for this server (dispatched as
// craftbox:operation by console.js / serverState.js). Call this BEFORE kicking
// off the request that starts the work — a fast backend can broadcast before the
// POST's promise settles. Call .cancel() if the request never started the work.
function awaitOperation(serverId, operation) {
    var handler;
    var promise = new Promise(function (resolve) {
        handler = function (e) {
            var msg = e.detail || {};
            if (msg.serverId !== serverId || msg.operation !== operation) return;
            document.removeEventListener('craftbox:operation', handler);
            resolve(msg);
        };
        document.addEventListener('craftbox:operation', handler);
    });
    promise.cancel = function () {
        document.removeEventListener('craftbox:operation', handler);
    };
    return promise;
}

// ── Show a Bootstrap toast notification (matches flash.ejs style) ──
// type: 'danger' | 'success' | 'warning' | 'info' (defaults to 'danger')
function showToast(message, type) {
    type = type || 'danger';
    var icons = { danger: 'error', success: 'check_circle', warning: 'warning', info: 'info' };
    var icon = icons[type] || 'error';
    // warning/info render dark text on a light background — match the X to the text
    var btnClass = (type === 'warning' || type === 'info') ? 'btn-close' : 'btn-close btn-close-white';

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

// ── Dropped folders ──
// A folder dragged onto the page does not arrive as the files inside it. The
// browser puts a single entry in dataTransfer.files standing for the directory
// itself — a File with size 0 and an empty type, which looks like an ordinary
// (if odd) file right up until something tries to read it. Handing that to
// FormData builds a request the browser then fails to send, and apiFetch has
// nothing to report but a bare `network_error`, which is what the user saw.
//
// Nothing here can upload a directory tree: every upload endpoint takes flat
// files and reduces a name to its basename (safeEntryName, src/utils/
// fileBrowser.js). So the fix is to recognise a folder before it is queued and
// say so, rather than to send it and mistranslate the failure.
//
// dataTransfer.items is the part that actually knows: webkitGetAsEntry() must
// be called synchronously inside the drop handler (the item list is emptied
// once it returns), and its entry.isDirectory is definitive. Every browser
// Craftbox targets has it; the size/type shape check below only stands in if
// it is missing, where it costs an empty extension-less file being called a
// folder — rarer, and less confusing, than the failed request it replaces.
function _looksLikeFolder(file) {
    return file.size === 0 && !file.type && !/\.[^.]+$/.test(file.name);
}

// Call synchronously from a `drop` handler. Returns the droppable files and the
// names of anything that was a folder, for the caller to phrase its own message
// around — what to do instead differs per page.
function readDroppedItems(dataTransfer) {
    var files = dataTransfer && dataTransfer.files
        ? Array.prototype.slice.call(dataTransfer.files)
        : [];

    // items carries dragged strings (links, selected text) as well as files;
    // the file-kind ones line up with dataTransfer.files in order.
    var fileItems = [];
    if (dataTransfer && dataTransfer.items) {
        Array.prototype.forEach.call(dataTransfer.items, function (item) {
            if (item.kind === 'file') fileItems.push(item);
        });
    }
    var aligned = fileItems.length === files.length;

    var kept = [];
    var folders = [];
    files.forEach(function (file, i) {
        var isDirectory = null;
        if (aligned && typeof fileItems[i].webkitGetAsEntry === 'function') {
            try {
                var entry = fileItems[i].webkitGetAsEntry();
                if (entry) isDirectory = entry.isDirectory;
            } catch (_) { /* fall through to the shape check */ }
        }
        if (isDirectory === null) isDirectory = _looksLikeFolder(file);
        if (isDirectory) folders.push(file.name); else kept.push(file);
    });

    return { files: kept, folders: folders };
}

// Shared opening for those messages, so every page words the refusal the same
// way and only differs in the advice that follows.
function folderDropMessage(folders, advice) {
    var lead = folders.length === 1
        ? '"' + folders[0] + '" is a folder, and folders cannot be uploaded.'
        : 'Folders cannot be uploaded, and ' + folders.length + ' of the dropped items are folders.';
    // `advice` has to read for one folder and for several, so keep it plural
    // where the caller can — the lead already names the single case.
    return lead + ' ' + advice;
}

// ── File input extension guard ──
// The `accept` attribute only filters the OS file dialog — the user can switch it
// to "All files" and pick anything — so check the extension the moment a file is
// added rather than waiting for the upload to be submitted and rejected.
// Files that don't match are dropped from the selection (which empties a
// single-file input entirely), and a `change` event is re-fired so whatever gates
// the page's submit button re-evaluates.
// `extensions` are lowercase and include the dot, e.g. ['.jar'].
function guardFileInput(input, extensions, message) {
    if (!input) return;
    input.addEventListener('change', function () {
        if (input.files.length === 0) return;

        var kept = Array.prototype.filter.call(input.files, function (f) {
            var name = f.name.toLowerCase();
            return extensions.some(function (ext) { return name.endsWith(ext); });
        });
        if (kept.length === input.files.length) return; // everything is valid

        showToast(message, 'danger');
        try {
            var dt = new DataTransfer();
            kept.forEach(function (f) { dt.items.add(f); });
            input.files = dt.files;
        } catch (_) {
            input.value = ''; // no DataTransfer support — drop the lot
        }
        // Safe against recursion: the re-fired event now sees a valid selection
        // (or none at all) and returns above.
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

// ── Live state gating ──
// Controls that require a stopped server used to be gated once, server-side, at
// render time. The page then receives live state over the WebSocket, so the gate
// froze at whatever the state was when the page loaded: stop a server and the
// upload button stayed dead until a manual reload.
//
// Mark a control `data-enable-when="stopped crashed"` and it tracks the live
// state. `data-show-when` / `data-hide-when` toggle `.d-none` on the same basis
// — use them for the explanatory alerts that accompany a gate.
// Optional `data-disabled-title` / `data-enabled-title` swap the tooltip.
//
// The live state is read from #server-nav-header's data-state, which both
// WebSocket owners (serverState.js and console.js) write on every update.
function currentServerState() {
    var el = document.getElementById('server-nav-header');
    return (el && el.dataset.state) || '';
}

function isServerStopped(state) {
    return ['stopped', 'crashed'].indexOf(state || currentServerState()) !== -1;
}

function applyStateGates(state) {
    state = state || currentServerState();

    document.querySelectorAll('[data-enable-when]').forEach(function (el) {
        var ok = el.dataset.enableWhen.split(/\s+/).indexOf(state) !== -1;
        if ('disabled' in el) {
            el.disabled = !ok;
        } else {
            // Anchors have no disabled property. Bootstrap's .disabled kills
            // pointer events on .btn; the attributes keep it out of the tab
            // order and announce the state.
            el.classList.toggle('disabled', !ok);
            el.setAttribute('aria-disabled', String(!ok));
            if (ok) el.removeAttribute('tabindex');
            else el.setAttribute('tabindex', '-1');
        }
        var title = ok ? el.dataset.enabledTitle : el.dataset.disabledTitle;
        if (title !== undefined) el.title = title;
    });

    document.querySelectorAll('[data-show-when]').forEach(function (el) {
        el.classList.toggle('d-none', el.dataset.showWhen.split(/\s+/).indexOf(state) === -1);
    });

    document.querySelectorAll('[data-hide-when]').forEach(function (el) {
        el.classList.toggle('d-none', el.dataset.hideWhen.split(/\s+/).indexOf(state) !== -1);
    });

    // Pages with bespoke gating (button labels, request payloads) listen for
    // this rather than duplicating the attribute walk.
    document.dispatchEvent(new CustomEvent('craftbox:stategates', { detail: { state: state } }));
}

document.addEventListener('craftbox:state', function (e) {
    applyStateGates((e.detail && e.detail.state) || currentServerState());
});

// Server-rendered markup is already correct on load; this only matters for
// elements whose gate attributes were added without a matching server-side
// render, and it keeps the two paths from drifting.
applyStateGates();

// ── Lock every control inside a container during an async operation ──
// Buttons that dismiss a modal are deliberately left enabled: the upload flows
// wire `hide.bs.modal` to abort the transfer, so Cancel / X / Esc must stay
// reachable while everything else is frozen.
// Forms are marked [data-busy] so the required-field validator below cannot
// re-enable the submit button out from under the lock.
// Unlocking re-enables every control, so callers that derive a button's state
// from validation should re-run that check afterwards.
function setControlsLocked(root, locked) {
    if (!root) return;
    root.querySelectorAll('input, select, textarea, button:not([data-bs-dismiss="modal"])')
        .forEach(function (el) { el.disabled = locked; });

    var forms = Array.prototype.slice.call(root.querySelectorAll('form'));
    if (root.tagName === 'FORM') forms.push(root);
    forms.forEach(function (form) {
        if (locked) form.setAttribute('data-busy', '');
        else form.removeAttribute('data-busy');
    });
}

// ── Centre form fields left alone on their row ──
// A .row down to one visible column renders as a lopsided half-width field
// pinned to the left edge: the create form's port field once modpack mode
// hides the version picker, or Assign Group, which sits alone by design.
// Centre those, and un-centre again if a sibling column comes back — callers
// with columns that appear and disappear re-run this as the layout changes.
// `root` scopes it to one form; every other row on the page is left alone.
function centerLoneRowItems(root) {
    if (!root) return;
    root.querySelectorAll('.row').forEach(function (row) {
        var cols = row.querySelectorAll(':scope > [class*="col-"]');
        if (cols.length === 0) return;
        var visible = Array.prototype.filter.call(cols, function (c) {
            return !c.classList.contains('d-none');
        });
        row.classList.toggle('justify-content-center', visible.length === 1);
    });
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
            // A busy form is locked by setControlsLocked — leave its submit
            // button alone or an incidental input/change event unlocks it.
            if (form.hasAttribute('data-busy')) return;
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
