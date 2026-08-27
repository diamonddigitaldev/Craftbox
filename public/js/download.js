// ── Download tracking ──
// Browser downloads are opaque to the page that starts them: a plain link hands
// the transfer to the browser and never says whether it finished, was cancelled,
// or was refused with a 409. So Craftbox starts every panel download itself and
// lets the request report its own outcome back over the server WebSocket, keyed
// by a token minted here and put on the URL as `dl`.
//
// Any anchor tagged `data-download="<label>"` is picked up automatically:
//
//     <a href="/servers/x/download-zip" data-download="Server files">…</a>
//
// The request is sent through a hidden iframe rather than by navigating, so an
// error response can never replace the page the user is standing on. Each
// download in flight gets its own frame, so starting a second one leaves the
// first streaming untouched.
(function () {
    'use strict';

    var pending = {};   // token -> { label, statusEl, frame }

    // One frame per in-flight download. Setting .src on a frame that is still
    // streaming aborts that transfer at the browser level, so a download in
    // progress never shares its frame with a later one.
    //
    // Frames are reused only once their download has terminally settled, which
    // keeps a page that downloads repeatedly from growing an unbounded row of
    // them.
    var freeFrames = [];

    function acquireFrame() {
        var frame = freeFrames.pop();
        if (frame) return frame;
        frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.display = 'none';
        document.body.appendChild(frame);
        return frame;
    }

    function releaseFrame(frame) {
        if (frame && freeFrames.indexOf(frame) === -1) freeFrames.push(frame);
    }

    function newToken() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    }

    function withToken(url, token) {
        return url + (url.indexOf('?') === -1 ? '?' : '&') + 'dl=' + encodeURIComponent(token);
    }

    // "12.4 MB of 340.0 MB" — the server sends bytes, the status line reads better
    // in the same units the browser's own download shelf uses.
    function formatSize(bytes) {
        if (!isFinite(bytes) || bytes <= 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
    }

    // A sticky toast for the life of one download: Bootstrap toasts autohide,
    // and a packing run can take minutes.
    //
    // Held back for a moment before it appears — a small file is served before
    // the eye can register anything, and a status toast that flashes up and
    // straight back out again is worse than no status toast at all.
    var STATUS_DELAY_MS = 400;

    function openStatus(label) {
        var message = 'Preparing ' + label + '…';
        var text = null;
        var toast = null;
        var toastEl = null;
        var closed = false;

        var timer = setTimeout(function () {
            if (closed) return;
            var container = document.querySelector('.toast-container');
            if (!container) {
                container = document.createElement('div');
                container.className = 'toast-container position-fixed top-0 end-0 p-3';
                container.style.zIndex = '1090';
                document.body.appendChild(container);
            }

            toastEl = document.createElement('div');
            toastEl.className = 'toast align-items-center text-bg-info border-0';
            toastEl.setAttribute('role', 'status');

            var wrapper = document.createElement('div');
            wrapper.className = 'd-flex';

            var body = document.createElement('div');
            body.className = 'toast-body d-flex align-items-center gap-2';

            var spinner = document.createElement('span');
            spinner.className = 'spinner-border spinner-border-sm flex-shrink-0';

            text = document.createElement('span');
            text.textContent = message;

            body.appendChild(spinner);
            body.appendChild(text);
            wrapper.appendChild(body);
            toastEl.appendChild(wrapper);
            container.appendChild(toastEl);

            toast = new bootstrap.Toast(toastEl, { autohide: false });
            toast.show();
        }, STATUS_DELAY_MS);

        return {
            set: function (next) {
                message = next;
                if (text) text.textContent = next;
            },
            close: function () {
                closed = true;
                clearTimeout(timer);
                if (!toast) return;
                toastEl.addEventListener('hidden.bs.toast', function () { toastEl.remove(); });
                toast.hide();
            }
        };
    }

    function describeProgress(label, payload) {
        var done = Number(payload.done) || 0;
        var total = Number(payload.total) || 0;
        if (payload.phase === 'sending') {
            return 'Downloading ' + label + ' (' + formatSize(total) + ')…';
        }
        if (total > 0) {
            var pct = Math.min(100, Math.round((done / total) * 100));
            return 'Preparing ' + label + ' — ' + formatSize(done) + ' of ' + formatSize(total) + ' (' + pct + '%)';
        }
        if (done > 0) return 'Preparing ' + label + ' — ' + formatSize(done) + ' packed';
        return 'Preparing ' + label + '…';
    }

    // `release` says whether the transfer is known to be over. Only a terminal
    // report from the server proves that; a silence timeout proves nothing, so
    // that frame is retired rather than handed to another download that would
    // abort it.
    function settle(token, finish, release) {
        var entry = pending[token];
        if (!entry) return;
        delete pending[token];
        clearTimeout(entry.timer);
        entry.statusEl.close();
        if (release) releaseFrame(entry.frame);
        finish(entry);
    }

    // The outcome arrives over the server WebSocket. Pages outside a server
    // context do not have one, and a socket can drop mid-transfer, so stop
    // waiting after a stretch of silence rather than spinning forever. Any
    // progress message pushes the deadline back, so a long packing run is
    // never mistaken for a dead socket.
    var SILENCE_TIMEOUT_MS = 60000;

    function armTimeout(token) {
        var entry = pending[token];
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(function () {
            // Quietly: the browser's own download UI has the transfer from here.
            settle(token, function () {});
        }, SILENCE_TIMEOUT_MS);
    }

    document.addEventListener('craftbox:operation', function (e) {
        var msg = e.detail || {};
        if (msg.operation !== 'download') return;

        // A failure is reported as a plain string, so it carries no token and
        // cannot be matched to one click. With downloads started one at a time
        // this is the one in flight; with several, the message still names what
        // failed, which beats staying silent.
        if (msg.status === 'failed') {
            var tokens = Object.keys(pending);
            if (tokens.length === 1) {
                settle(tokens[0], function () {}, true);
            }
            showToast(msg.error || 'Download failed.', 'danger');
            return;
        }

        var payload = msg.payload || {};
        var entry = pending[payload.token];
        if (!entry) return;

        if (msg.status === 'progress') {
            entry.statusEl.set(describeProgress(entry.label, payload));
            armTimeout(payload.token);
            return;
        }
        if (msg.status === 'complete') {
            settle(payload.token, function (done) {
                showToast(done.label + ' downloaded (' + (payload.sizeFormatted || '') + ').', 'success');
            }, true);
            return;
        }
        if (msg.status === 'cancelled') {
            settle(payload.token, function (done) {
                showToast(done.label + ' download cancelled.', 'warning');
            }, true);
        }
    });

    function start(url, label) {
        label = label || 'file';
        var token = newToken();
        var frame = acquireFrame();
        pending[token] = { label: label, statusEl: openStatus(label), timer: null, frame: frame };
        armTimeout(token);
        frame.src = withToken(url, token);
    }

    document.addEventListener('click', function (e) {
        var link = e.target.closest ? e.target.closest('a[data-download]') : null;
        if (!link) return;
        // Live state gating (app.js) marks blocked links aria-disabled rather
        // than removing the href.
        if (link.getAttribute('aria-disabled') === 'true' || link.classList.contains('disabled')) {
            e.preventDefault();
            return;
        }
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        start(link.href, link.dataset.download);
    });

    window.CraftboxDownload = { start: start };
})();
