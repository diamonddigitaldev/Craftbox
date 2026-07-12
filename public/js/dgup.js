// DGUP (Dropgate Upload Protocol) client — chunked uploads for Craftbox.
// Protocol reference: https://github.com/diamonddigitaldev/Dropgate
//
// uploadFile(baseUrl, file, opts) -> Promise<{ ok, status, data }>
//   baseUrl   the upload endpoint, e.g. '/api/v1/servers/import'
//   opts:
//     fieldName   multipart field name for the small-file path (required)
//     fields      optional plain object of extra form fields. Small path:
//                 appended to the multipart FormData (multer puts them on
//                 req.body). Chunked path: merged into the /complete body,
//                 which the DGUP server passes through as req.body — the
//                 wrapped handler sees the same req.body either way.
//     onProgress  function(loadedBytes, totalBytes) — optional
//     csrfToken   optional; defaults to _findCsrfToken()
//     signal      optional AbortSignal — aborting stops the transfer, frees
//                 the server-side session, and resolves { aborted: true }
//
// Files that fit in one chunk are sent as a single multipart POST to baseUrl,
// exactly as before DGUP existed. Larger files go through
// baseUrl + '/upload/init' → '/upload/chunk' ×N → '/upload/complete', each
// request small enough to pass proxies that cap request bodies (Cloudflare
// Tunnel cuts uploads at 100 MB). The complete step returns the same response
// body the multipart path would have.

// Must match the server's chunk size only loosely: files at or under this go
// multipart; anything larger asks init for the authoritative chunkSize.
var DGUP_THRESHOLD = 5 * 1024 * 1024;

var DGUP_MAX_RETRIES = 5;        // per chunk (DGUP §7)
var DGUP_BACKOFF_MS = 1000;      // initial, doubles per retry
var DGUP_BACKOFF_MAX_MS = 30000;
var DGUP_TIMEOUT_MS = 60000;     // per chunk request

function _dgupSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// XHR wrapper (fetch has no upload-progress events).
// Resolves { status, data, failed } — `failed` means network error/timeout,
// status 0. Never rejects.
function _dgupXhr(url, headers, body, onProgress, timeoutMs, signal) {
    return new Promise(function (resolve) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.responseType = 'json';
        if (timeoutMs) xhr.timeout = timeoutMs;
        if (signal) {
            if (signal.aborted) { resolve({ status: 0, data: null, failed: true }); return; }
            signal.addEventListener('abort', function () { xhr.abort(); }, { once: true });
        }
        Object.keys(headers).forEach(function (k) {
            if (headers[k]) xhr.setRequestHeader(k, headers[k]);
        });
        if (onProgress) {
            xhr.upload.addEventListener('progress', function (e) {
                if (e.lengthComputable) onProgress(e.loaded, e.total);
            });
        }
        xhr.addEventListener('load', function () {
            resolve({ status: xhr.status, data: xhr.response || null, failed: false });
        });
        var fail = function () { resolve({ status: 0, data: null, failed: true }); };
        xhr.addEventListener('error', fail);
        xhr.addEventListener('timeout', fail);
        xhr.addEventListener('abort', fail);
        xhr.send(body);
    });
}

function _dgupAborted() {
    return { ok: false, status: 0, aborted: true, data: { error: 'Upload cancelled.' } };
}

async function uploadFile(baseUrl, file, opts) {
    opts = opts || {};
    var csrf = opts.csrfToken || _findCsrfToken();
    var onProgress = opts.onProgress || function () {};
    var signal = opts.signal || null;
    var fields = opts.fields || null;

    // ── Small file: today's single multipart POST, unchanged ──
    if (file.size <= DGUP_THRESHOLD) {
        var formData = new FormData();
        if (fields) {
            Object.keys(fields).forEach(function (k) { formData.append(k, fields[k]); });
        }
        formData.append(opts.fieldName, file);
        var res = await _dgupXhr(baseUrl, {
            'X-CSRF-Token': csrf,
            'X-Client-Id': window.CRAFTBOX_CLIENT_ID
        }, formData, function (loaded) { onProgress(Math.min(loaded, file.size), file.size); }, null, signal);
        if (signal && signal.aborted) return _dgupAborted();
        if (res.failed) {
            return { ok: false, status: 0, data: { error: 'Upload failed. Check your connection and try again.' } };
        }
        return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
    }

    // ── Large file: DGUP chunked upload, with one full restart if the
    //    server-side session disappears (expiry, panel restart) ──
    // DGUP lives at <endpoint>/upload/* — endpoints already ending in /upload
    // (plugins) host it at themselves, so don't double the segment.
    var dgupBase = /\/upload$/.test(baseUrl) ? baseUrl : baseUrl + '/upload';
    var result = await _dgupAttempt(dgupBase, file, csrf, onProgress, signal, fields);
    if (result.restart) {
        result = await _dgupAttempt(dgupBase, file, csrf, onProgress, signal, fields);
        if (result.restart) {
            return { ok: false, status: 410, data: { error: 'Upload session was lost. Please try again.' } };
        }
    }
    return result;
}

async function _dgupAttempt(dgupBase, file, csrf, onProgress, signal, fields) {
    // init — server dictates chunk size and chunk count
    var initRes = await apiFetch(dgupBase + '/init', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
        body: { filename: file.name, totalSize: file.size }
    });
    if (!initRes.ok) {
        if (initRes.status === 0) {
            return { ok: false, status: 0, data: { error: 'Upload failed. Check your connection and try again.' } };
        }
        return initRes;
    }
    var uploadId = initRes.data.uploadId;
    var chunkSize = initRes.data.chunkSize;
    var totalChunks = initRes.data.totalChunks;

    // chunks — sequential, hashed, retried per DGUP §7
    for (var index = 0; index < totalChunks; index++) {
        if (signal && signal.aborted) {
            _dgupCancel(dgupBase, uploadId, csrf);
            return _dgupAborted();
        }
        var start = index * chunkSize;
        var blob = file.slice(start, Math.min(start + chunkSize, file.size));
        var buf = await blob.arrayBuffer();
        var hash = await sha256Hex(buf);

        var sent = false;
        for (var attempt = 0; attempt <= DGUP_MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                await _dgupSleep(Math.min(DGUP_BACKOFF_MS * Math.pow(2, attempt - 1), DGUP_BACKOFF_MAX_MS));
            }
            var res = await _dgupXhr(dgupBase + '/chunk', {
                'Content-Type': 'application/octet-stream',
                'X-CSRF-Token': csrf,
                'X-Upload-ID': uploadId,
                'X-Chunk-Index': String(index),
                'X-Chunk-Hash': hash
            }, buf, function (loaded) {
                onProgress(Math.min(start + loaded, file.size), file.size);
            }, DGUP_TIMEOUT_MS, signal);

            if (signal && signal.aborted) {
                _dgupCancel(dgupBase, uploadId, csrf);
                return _dgupAborted();
            }
            if (res.status >= 200 && res.status < 300) {
                sent = true;
                break;
            }
            if (res.status === 404 || res.status === 410) {
                return { restart: true }; // session gone — start over, don't retry into the void
            }
            if (res.status === 401) {
                return { ok: false, status: 401, data: { error: 'Your session has expired. Please log in again.' } };
            }
            var retryable = res.failed
                || res.status >= 500
                || res.status === 409
                || (res.data && res.data.code === 'hash_mismatch');
            if (!retryable) {
                _dgupCancel(dgupBase, uploadId, csrf);
                return { ok: false, status: res.status, data: res.data || { error: 'Upload failed.' } };
            }
        }
        if (!sent) {
            _dgupCancel(dgupBase, uploadId, csrf);
            return { ok: false, status: 0, data: { error: 'Upload failed after several retries. Check your connection and try again.' } };
        }
        onProgress(Math.min(start + chunkSize, file.size), file.size);
    }

    // A cancel that lands before complete is sent must win — completing would
    // finalise work the user just cancelled (e.g. create the imported server).
    if (signal && signal.aborted) {
        _dgupCancel(dgupBase, uploadId, csrf);
        return _dgupAborted();
    }

    // complete — retried too: if only the response was lost, the server
    // replays the original outcome instead of processing the upload twice.
    // No abort checks between retries: once the first attempt is sent the
    // outcome may already be committed server-side, so learn it rather than
    // walk away from it.
    for (var cAttempt = 0; cAttempt <= DGUP_MAX_RETRIES; cAttempt++) {
        if (cAttempt > 0) {
            await _dgupSleep(Math.min(DGUP_BACKOFF_MS * Math.pow(2, cAttempt - 1), DGUP_BACKOFF_MAX_MS));
        }
        // Extra form fields ride along in the complete body (uploadId wins any
        // name collision) so the wrapped handler sees them on req.body.
        var completeRes = await apiFetch(dgupBase + '/complete', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrf },
            body: Object.assign({}, fields || {}, { uploadId: uploadId })
        });
        if (completeRes.status === 0 || completeRes.status >= 500 || completeRes.status === 409) {
            continue; // transient — safe to retry, see above
        }
        if (completeRes.status === 404 || completeRes.status === 410) {
            return { restart: true };
        }
        return completeRes;
    }
    return { ok: false, status: 0, data: { error: 'Upload could not be finalised. Check your connection and try again.' } };
}

// Fire-and-forget: frees the server-side session after a fatal failure.
function _dgupCancel(dgupBase, uploadId, csrf) {
    try {
        apiFetch(dgupBase + '/cancel', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrf },
            body: { uploadId: uploadId }
        });
    } catch (_) { /* ignore */ }
}
