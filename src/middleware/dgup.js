// DGUP (Dropgate Upload Protocol) server implementation for Craftbox.
// Protocol reference: https://github.com/diamonddigitaldev/Dropgate
// (docs/technical/DGUP.md, protocol version 3).
//
// Craftbox implements the init / chunk / complete / cancel lifecycle with
// per-chunk SHA-256 integrity. The Dropgate-specific layers (E2EE, bundles,
// lifetimes, download links) do not apply: Craftbox must read the uploaded
// bytes server-side (zip extraction, sharp re-encoding, JAR validation).
//
// Each existing multipart upload endpoint gets a DGUP sub-router mounted
// beneath it (e.g. POST /servers/import/upload/init). On complete, the
// assembled file is renamed into os.tmpdir() with a multer-shaped req.file /
// req.files, and the route's EXISTING handler runs unchanged — so the final
// response body is identical to the plain multipart path.
//
// Deviations from the DGUP spec, both deliberate:
// - A duplicate chunk returns 200 (ack) instead of 400. If a chunk's 200 is
//   lost in transit, the client retries it; rejecting the retry would strand
//   the upload. The bytes are already on disk, so acking is truthful.
// - init accepts { filename, totalSize } and returns the server-dictated
//   { chunkSize, totalChunks }, removing the need for a capability-discovery
//   round trip. A client-supplied totalChunks is validated if present.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UPLOAD_DIR, ensureUploadDir, sweepUploadDir } = require('../utils/uploadSafety');
const { log } = require('../utils/log');

const CHUNK_SIZE = (() => {
    const env = parseInt(process.env.UPLOAD_CHUNK_SIZE_BYTES, 10);
    // DGUP minimum is 64 KiB; default 5 MiB sits safely inside Cloudflare's
    // ~100 s origin-response window down to ~440 kbps uplinks.
    return Number.isInteger(env) && env >= 64 * 1024 ? env : 5 * 1024 * 1024;
})();

const MAX_CHUNK_COUNT = 100000;          // DGUP §5.1 hard limit
const MAX_SESSIONS_PER_USER = 5;
const IDLE_SESSION_MS = 10 * 60 * 1000;  // in-progress sessions idle past this are reaped
const DONE_SESSION_MS = 10 * 60 * 1000;  // completed sessions linger so a lost final
                                         // response can be replayed to a retry
const REAPER_INTERVAL_MS = 60 * 1000;

const HASH_RE = /^[0-9a-f]{64}$/;

// key: `${userId}:${uploadId}` -> session
const sessions = new Map();

function sessionKey(req, uploadId) {
    return `${req.user.id}:${uploadId}`;
}

function jsonError(res, status, message, code) {
    const body = { error: message };
    if (code) body.code = code;
    return res.status(status).json(body);
}

// Sends the response the wrapped handler produced earlier. Used when a client
// retries `complete` after losing the original response in transit — without
// this, a retried import would create a second server.
function replayCachedResponse(res, session) {
    return res.status(session.cachedResponse.status).json(session.cachedResponse.body);
}

function destroySession(key, session) {
    sessions.delete(key);
    if (session.partPath) {
        fs.promises.unlink(session.partPath).catch(() => {});
    }
}

// Windows AV/indexers can transiently hold files open (EPERM/EBUSY); retry
// briefly before giving up. Same hazard class as the note in api-v1/servers.js
// about deleting open files.
async function renameWithRetry(from, to) {
    const delays = [0, 50, 100, 200];
    for (let i = 0; i < delays.length; i++) {
        if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
        try {
            await fs.promises.rename(from, to);
            return;
        } catch (err) {
            if (i === delays.length - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        }
    }
}

// Reads the raw request body into a buffer, hard-capped at maxLen. Resolves
// { ok: true, buf } or { ok: false } if the cap was exceeded (response sent).
function readRawBody(req, res, maxLen) {
    return new Promise((resolve) => {
        const parts = [];
        let received = 0;
        let settled = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        req.on('data', (part) => {
            received += part.length;
            if (received > maxLen) {
                jsonError(res, 413, 'Chunk exceeds expected size.');
                req.destroy();
                settle({ ok: false });
                return;
            }
            parts.push(part);
        });
        req.on('end', () => settle({ ok: true, buf: Buffer.concat(parts) }));
        req.on('error', () => settle({ ok: false }));
        req.on('aborted', () => settle({ ok: false }));
    });
}

/**
 * Builds a DGUP sub-router for one upload destination.
 *
 * @param {object} spec
 *   routeKey  unique name binding sessions to this destination ('plugins'…)
 *   field     multipart field name the wrapped handler expects
 *   fileMode  'single' (sets req.file) or 'array' (sets req.files)
 *   maxBytes  per-file size cap (Infinity for none)
 *   ext       allowed filename extensions, lowercase, with dot
 *   mimetype  mimetype stamped on the synthesized file object
 *   validate  optional async (req) => null | { status, error } run at init,
 *             so doomed uploads are rejected before any bytes are sent
 * @param {function} handler the route's existing (req, res) handler
 */
function createDgupRouter(spec, handler) {
    const router = express.Router({ mergeParams: true });

    router.post('/init', async (req, res) => {
        const { filename, totalSize, totalChunks } = req.body || {};

        if (typeof filename !== 'string' || filename.length === 0) {
            return jsonError(res, 400, 'No filename specified.');
        }
        const safeName = path.basename(filename).replace(/[/\\]/g, '');
        // eslint-disable-next-line no-control-regex
        if (safeName.length === 0 || safeName.length > 255 || /[\x00-\x1f]/.test(safeName)) {
            return jsonError(res, 400, 'Invalid filename.');
        }
        if (spec.ext && !spec.ext.some(e => safeName.toLowerCase().endsWith(e))) {
            return jsonError(res, 400, spec.extError || 'File type not allowed.');
        }

        if (!Number.isInteger(totalSize) || totalSize < 1) {
            return jsonError(res, 400, 'Invalid totalSize.');
        }
        if (totalSize > spec.maxBytes) {
            return jsonError(res, 413, `File exceeds the ${Math.floor(spec.maxBytes / (1024 * 1024))} MB limit.`);
        }

        const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
        if (chunkCount > MAX_CHUNK_COUNT) {
            return jsonError(res, 413, 'File exceeds the maximum chunk count.');
        }
        // DGUP §5.1 requires totalChunks; our client omits it and uses the
        // returned value. Validate it when a spec-faithful client sends one.
        if (totalChunks !== undefined && (!Number.isInteger(totalChunks) || Math.abs(totalChunks - chunkCount) > 1)) {
            return jsonError(res, 400, 'totalChunks is inconsistent with totalSize and the server chunk size.');
        }

        let active = 0;
        for (const s of sessions.values()) {
            if (s.userId === req.user.id && s.state !== 'done') active++;
        }
        if (active >= MAX_SESSIONS_PER_USER) {
            return jsonError(res, 429, 'Too many uploads in progress. Finish or cancel one first.');
        }

        // Destination-specific preflight (server exists, is stopped, supports
        // plugins, …) so a doomed multi-GB upload fails before its first byte.
        if (spec.validate) {
            const failure = await spec.validate(req);
            if (failure) return jsonError(res, failure.status, failure.error);
        }

        // Quota safety (DGUP 507): refuse uploads the staging disk cannot
        // hold. Probe os.tmpdir() — same volume as UPLOAD_DIR, always exists.
        try {
            const stat = fs.statfsSync(os.tmpdir());
            if (stat.bavail * stat.bsize < totalSize * 1.05) {
                return jsonError(res, 507, 'Insufficient storage space for this upload.');
            }
        } catch { /* statfs unsupported — skip the check */ }

        const uploadId = crypto.randomUUID();
        const partPath = path.join(UPLOAD_DIR, `${uploadId}.part`);
        try {
            ensureUploadDir();
            // Pre-create so positional writes can land out of order.
            fs.closeSync(fs.openSync(partPath, 'w'));
        } catch (err) {
            log('error', `DGUP: failed to create part file: ${err.message}`);
            return jsonError(res, 500, 'Failed to initialise upload.');
        }

        sessions.set(sessionKey(req, uploadId), {
            userId: req.user.id,
            routeKey: spec.routeKey,
            scopeId: req.params.id ?? null,
            filename: safeName,
            totalSize,
            totalChunks: chunkCount,
            receivedChunks: new Set(),
            partPath,
            writing: false,
            state: 'uploading',
            cachedResponse: null,
            updatedAt: Date.now()
        });

        log('info', `Chunked upload ${uploadId} started by ${req.user.username}: "${safeName}" `
            + `(${(totalSize / (1024 * 1024)).toFixed(1)} MB, ${chunkCount} chunks) → ${spec.routeKey}`
            + `${req.params.id ? ` for server ${req.params.id}` : ''}`);
        res.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks: chunkCount });
    });

    router.post('/chunk', async (req, res) => {
        const uploadId = req.get('x-upload-id');
        const indexRaw = req.get('x-chunk-index');
        const hash = (req.get('x-chunk-hash') || '').toLowerCase();

        const session = uploadId && sessions.get(sessionKey(req, uploadId));
        if (!session || session.routeKey !== spec.routeKey || session.scopeId !== (req.params.id ?? null)) {
            return jsonError(res, 404, 'Upload session not found.');
        }
        if (session.state !== 'uploading') {
            return jsonError(res, 400, 'Upload has already been completed.');
        }
        if (!HASH_RE.test(hash)) {
            return jsonError(res, 400, 'Invalid chunk hash format.');
        }
        const index = parseInt(indexRaw, 10);
        if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks || String(index) !== indexRaw) {
            return jsonError(res, 400, 'Invalid chunk index.');
        }
        if (session.writing) {
            return jsonError(res, 409, 'Another chunk write is in progress for this upload.');
        }

        session.updatedAt = Date.now();

        const isLast = index === session.totalChunks - 1;
        const expectedLen = isLast ? session.totalSize - (session.totalChunks - 1) * CHUNK_SIZE : CHUNK_SIZE;

        const body = await readRawBody(req, res, expectedLen);
        if (!body.ok) return; // response already sent or connection gone
        if (body.buf.length !== expectedLen) {
            return jsonError(res, 400, `Chunk ${index} has the wrong size.`);
        }

        const digest = crypto.createHash('sha256').update(body.buf).digest('hex');
        if (digest !== hash) {
            // `code` lets the client distinguish transit corruption (retryable)
            // from genuine validation failures (fatal).
            return jsonError(res, 400, 'Chunk hash mismatch.', 'hash_mismatch');
        }

        // Bytes verified — ack a duplicate rather than rejecting it (see the
        // deviations note at the top of this file).
        if (session.receivedChunks.has(index)) {
            return res.json({ success: true, received: session.receivedChunks.size });
        }

        session.writing = true;
        let fd;
        try {
            // Positional write at the chunk's absolute offset. Never append:
            // a torn write from an aborted request would shift every later
            // chunk and silently corrupt the file.
            fd = await fs.promises.open(session.partPath, 'r+');
            await fd.write(body.buf, 0, body.buf.length, index * CHUNK_SIZE);
        } catch (err) {
            session.writing = false;
            if (err.code === 'ENOSPC') {
                destroySession(sessionKey(req, uploadId), session);
                return jsonError(res, 507, 'Server ran out of storage space.');
            }
            log('error', `DGUP: chunk write failed: ${err.message}`);
            return jsonError(res, 500, 'Failed to write chunk.');
        } finally {
            if (fd) await fd.close().catch(() => {});
        }
        session.writing = false;

        // Only mark received after the write fully succeeded — a failed write
        // leaves the chunk unclaimed so the client's retry rewrites the offset.
        session.receivedChunks.add(index);
        session.updatedAt = Date.now();
        res.json({ success: true, received: session.receivedChunks.size });
    });

    router.post('/complete', async (req, res) => {
        const { uploadId } = req.body || {};
        const key = uploadId && sessionKey(req, uploadId);
        const session = key && sessions.get(key);
        if (!session || session.routeKey !== spec.routeKey || session.scopeId !== (req.params.id ?? null)) {
            return jsonError(res, 404, 'Upload session not found.');
        }

        // A retried complete (lost response) replays the original outcome
        // instead of re-running the handler — completing twice would, for
        // imports, create a second server.
        if (session.state === 'done') {
            return replayCachedResponse(res, session);
        }
        if (session.state === 'completing') {
            return jsonError(res, 409, 'Completion already in progress.');
        }

        if (session.receivedChunks.size !== session.totalChunks) {
            return jsonError(res, 400,
                `Upload is incomplete: ${session.receivedChunks.size} of ${session.totalChunks} chunks received.`);
        }

        let size;
        try {
            size = (await fs.promises.stat(session.partPath)).size;
        } catch {
            destroySession(key, session);
            return jsonError(res, 500, 'Upload data is missing.');
        }
        if (size !== session.totalSize) {
            destroySession(key, session);
            return jsonError(res, 400, 'Assembled file size does not match the declared size.');
        }

        session.state = 'completing';
        session.updatedAt = Date.now();

        // Move the assembled file into os.tmpdir() under a multer-style random
        // name; from here the existing handler (and cleanupTempFiles) treats it
        // exactly like a multer temp file.
        const finalPath = path.join(os.tmpdir(), crypto.randomBytes(16).toString('hex'));
        try {
            await renameWithRetry(session.partPath, finalPath);
        } catch (err) {
            session.state = 'uploading';
            log('error', `DGUP: failed to finalise upload: ${err.message}`);
            return jsonError(res, 500, 'Failed to finalise upload.');
        }
        session.partPath = null; // the handler owns (and deletes) finalPath now

        log('info', `Chunked upload ${uploadId} complete: "${session.filename}" assembled `
            + `(${(session.totalSize / (1024 * 1024)).toFixed(1)} MB) — running ${spec.routeKey} handler`);

        const fileObj = {
            fieldname: spec.field,
            originalname: session.filename,
            encoding: '7bit',
            mimetype: spec.mimetype,
            destination: os.tmpdir(),
            filename: path.basename(finalPath),
            path: finalPath,
            size: session.totalSize
        };
        if (spec.fileMode === 'array') {
            req.files = [fileObj];
        } else {
            req.file = fileObj;
        }

        // Capture the handler's response so a retried complete can replay it.
        const origJson = res.json.bind(res);
        res.json = (payload) => {
            if (session.state !== 'done') {
                session.state = 'done';
                session.cachedResponse = { status: res.statusCode, body: payload };
                session.updatedAt = Date.now();
            }
            return origJson(payload);
        };

        try {
            await handler(req, res);
        } catch (err) {
            log('error', `DGUP: upload handler failed: ${err.message}`);
            if (!res.headersSent) {
                jsonError(res, 500, 'Upload processing failed.');
            }
        }
        // If the handler somehow responded without res.json, drop the session
        // so it cannot be completed twice with a consumed file.
        if (session.state !== 'done') {
            destroySession(key, session);
        }
    });

    router.post('/cancel', (req, res) => {
        const { uploadId } = req.body || {};
        const key = uploadId && sessionKey(req, uploadId);
        const session = key && sessions.get(key);
        if (!session || session.routeKey !== spec.routeKey || session.scopeId !== (req.params.id ?? null)) {
            return jsonError(res, 404, 'Upload session not found.');
        }
        if (session.state === 'completing') {
            return jsonError(res, 409, 'Upload is being finalised and cannot be cancelled.');
        }
        destroySession(key, session);
        log('info', `Chunked upload ${uploadId} cancelled by ${req.user.username}: "${session.filename}" `
            + `(${session.receivedChunks.size}/${session.totalChunks} chunks received)`);
        res.json({ success: true });
    });

    return router;
}

// Converts multer's callback error into the JSON shape API clients expect.
// Previously duplicated verbatim at each upload route. Oversize now surfaces
// as an honest 413 instead of a generic 400.
function multerShim(mw) {
    return function (req, res, next) {
        mw(req, res, function (err) {
            if (err) {
                const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                return res.status(status).json({ error: err.message || 'Upload failed.' });
            }
            next();
        });
    };
}

let reaperStarted = false;
function initDgup() {
    sweepUploadDir();
    if (reaperStarted) return;
    reaperStarted = true;
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, session] of sessions) {
            const ttl = session.state === 'done' ? DONE_SESSION_MS : IDLE_SESSION_MS;
            if (now - session.updatedAt > ttl && !session.writing && session.state !== 'completing') {
                // Reaping a finished session is routine; reaping an unfinished
                // one means a client went away mid-upload — worth a line.
                if (session.state !== 'done') {
                    log('info', `Reaped stale chunked upload: "${session.filename}" → ${session.routeKey} `
                        + `(${session.receivedChunks.size}/${session.totalChunks} chunks, idle ${Math.round((now - session.updatedAt) / 60000)} min)`);
                }
                destroySession(key, session);
            }
        }
    }, REAPER_INTERVAL_MS);
    timer.unref();
}

module.exports = { createDgupRouter, multerShim, initDgup, CHUNK_SIZE };
