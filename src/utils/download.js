const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const contentDisposition = require('content-disposition');
const { log } = require('./log');
const { formatSize } = require('./formatSize');

// Staging area for archives being packed for download. An archive has to be
// finished before its byte count is known, and the byte count is what lets the
// browser draw a progress bar instead of counting up from "Resuming...", so
// every archive download is written here first and streamed from disk second.
//
// Everything in here is scratch: a staged file is deleted the moment its
// response ends, and the whole directory is wiped on boot to reclaim whatever
// a crash left behind.
const STAGING_DIR = path.join(os.tmpdir(), 'craftbox-downloads');

// A packing job that outlives this is either wedged or forgotten; the reaper
// deletes its file so a huge abandoned archive cannot sit on the disk.
const STAGED_FILE_TTL_MS = 60 * 60 * 1000;

function ensureStagingDir() {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
}

function sweepStagingDir() {
    try { fs.rmSync(STAGING_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    ensureStagingDir();
}

let reaperStarted = false;

function initDownloads() {
    sweepStagingDir();
    if (reaperStarted) return;
    reaperStarted = true;
    const timer = setInterval(() => {
        let entries;
        try { entries = fs.readdirSync(STAGING_DIR); } catch { return; }
        const now = Date.now();
        for (const name of entries) {
            const full = path.join(STAGING_DIR, name);
            try {
                if (now - fs.statSync(full).mtimeMs < STAGED_FILE_TTL_MS) continue;
                fs.unlinkSync(full);
                log('warn', `Reaped abandoned staged download: ${name}`);
            } catch { /* raced with its own cleanup */ }
        }
    }, 15 * 60 * 1000);
    timer.unref?.();
}


/** Bytes free on the volume holding the staging area, or null if unknowable. */
function stagingFreeBytes() {
    try {
        ensureStagingDir();
        const stat = fs.statfsSync(STAGING_DIR);
        return stat.bavail * stat.bsize;
    } catch {
        return null; // statfs unsupported — skip the check rather than guess
    }
}

/**
 * Reports how a download went to the panel over the per-server WebSocket.
 *
 * The panel starts downloads in a hidden iframe, which means it can see neither
 * the response nor the error body: a 409 and a mid-transfer abort would both
 * just look like nothing happening. So the request reports its own outcome, and
 * the click that started it is matched by the opaque `dl` token the panel puts
 * on the URL. Requests without one (API clients, a pasted URL) report nothing —
 * they read the HTTP status instead.
 */
class DownloadReporter {
    constructor({ req, serverManager, serverId, label } = {}) {
        const raw = req && req.query ? req.query.dl : null;
        this.token = typeof raw === 'string' && raw ? raw.slice(0, 64) : null;
        this.serverManager = serverManager || null;
        this.serverId = serverId || null;
        this.label = label || 'file';
        this.settled = false;
        this._lastProgressAt = 0;
    }

    get active() {
        return !!(this.token && this.serverManager && this.serverId);
    }

    _send(status, payload) {
        if (!this.active) return;
        try {
            this.serverManager.broadcastOperation(this.serverId, 'download', status, payload);
        } catch (err) {
            log('warn', `Download report failed: ${err.message}`);
        }
    }

    /**
     * Packing/sending progress. Throttled to one message a second: packing a
     * large server directory fires archiver's progress event thousands of times
     * a second and none of that belongs on the socket.
     */
    progress(phase, { done = 0, total = 0 } = {}) {
        if (!this.active || this.settled) return;
        const now = Date.now();
        if (now - this._lastProgressAt < 1000) return;
        this._lastProgressAt = now;
        this._send('progress', { token: this.token, label: this.label, phase, done, total });
    }

    complete(bytes) {
        if (this.settled) return;
        this.settled = true;
        this._send('complete', {
            token: this.token, label: this.label, bytes, sizeFormatted: formatSize(bytes)
        });
    }

    /** The client went away mid-transfer — not an error, but not a download either. */
    cancelled(bytes) {
        if (this.settled) return;
        this.settled = true;
        this._send('cancelled', {
            token: this.token, label: this.label, bytes, sizeFormatted: formatSize(bytes)
        });
    }

    failed(message) {
        if (this.settled) return;
        this.settled = true;
        if (!this.active) return;
        try {
            this.serverManager.broadcastOperation(
                this.serverId, 'download', 'failed', `${this.label}: ${message}`
            );
        } catch (err) {
            log('warn', `Download report failed: ${err.message}`);
        }
    }
}

/**
 * Attach the outcome listeners to a response that is about to stream.
 *
 * 'finish' means every byte reached the socket. A 'close' without it means the
 * client hung up early — the browser's Cancel button, a closed tab, a dropped
 * connection.
 */
function watchResponse(res, reporter, sizeBytes, describe) {
    let settled = false;
    const startedAt = res.socket ? res.socket.bytesWritten : 0;
    res.on('finish', () => {
        if (settled) return;
        settled = true;
        reporter.complete(sizeBytes);
    });
    res.on('close', () => {
        if (settled || res.writableFinished) return;
        settled = true;
        const sent = Math.max(0, (res.socket ? res.socket.bytesWritten : 0) - startedAt);
        log('warn', `${describe} cancelled by the client after ${formatSize(sent)} of ${formatSize(sizeBytes)}`);
        reporter.cancelled(sent);
    });
}

/**
 * Stream a file that already exists on disk as a download, with an exact
 * Content-Length so the browser can show size and progress.
 *
 * Errors raised before the first byte still produce a normal JSON response via
 * `onError`; once the stream is under way the connection is destroyed instead,
 * because a half-sent body cannot be turned back into an error document.
 */
function sendFileDownload(res, filePath, {
    filename,
    contentType = 'application/octet-stream',
    reporter = null,
    size = null,
    onError = null
} = {}) {
    let bytes = size;
    if (bytes == null) {
        try {
            bytes = fs.statSync(filePath).size;
        } catch (err) {
            if (onError) return onError(err);
            throw err;
        }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Content-Length', bytes);

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
        if (!res.headersSent && onError) return onError(err);
        if (reporter) reporter.failed(err.message);
        res.destroy(err);
    });
    if (reporter) watchResponse(res, reporter, bytes, `Download of "${filename}"`);
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}

/**
 * Pack a zip into the staging area, then stream it with an exact
 * Content-Length.
 *
 * Packing first costs a pass over the disk before the download appears, and
 * buys three things the old stream-as-you-pack route could not offer: a real
 * size (so the browser shows MB of MB and an ETA rather than "Resuming..."),
 * failures that land before any header is sent and so can still be reported as
 * JSON, and a much shorter window on whatever lock the caller is holding.
 *
 * @param {object} opts
 * @param {(archive: import('archiver').Archiver) => void} opts.build - add the entries
 * @param {string} opts.filename - download filename
 * @param {number} [opts.estimatedBytes] - uncompressed source size, for the free-space check
 * @returns {Promise<number>} bytes streamed (0 when the client left first)
 */
async function sendArchiveDownload(req, res, {
    build,
    filename,
    contentType = 'application/zip',
    estimatedBytes = 0,
    zlibLevel = 5,
    reporter = null,
    describe = null,
    onPacked = null
} = {}) {
    ensureStagingDir();

    // Refuse before doing any work rather than filling the disk and failing
    // somewhere less legible. The 5% headroom mirrors the chunked uploader.
    if (estimatedBytes > 0) {
        const free = stagingFreeBytes();
        if (free !== null && free < estimatedBytes * 1.05) {
            const err = new Error(
                `Not enough free space to prepare this download (${formatSize(estimatedBytes)} needed, ${formatSize(free)} free).`
            );
            err.status = 507;
            throw err;
        }
    }

    const stagedPath = path.join(STAGING_DIR, `${crypto.randomUUID()}.zip`);
    const label = describe || `Download of "${filename}"`;

    // A ServerResponse still reports itself writable after the client hangs up
    // — nothing has ended or destroyed it from this side — so watch for the
    // disconnect directly. Registered before packing starts, because packing is
    // the long window in which the client has time to leave.
    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    try {
        const size = await packArchive({
            build, stagedPath, zlibLevel, estimatedBytes, reporter, res, label
        });

        // Every source file has been read by now, so whatever the caller was
        // holding to keep them still (the backup lock, on an export) can go.
        if (onPacked) onPacked(size);

        // The client can hang up while packing — a big export gives them plenty
        // of time to change their mind. Nothing left to send it to.
        if (clientGone || res.writableEnded) {
            if (reporter) reporter.cancelled(0);
            return 0;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', contentDisposition(filename));
        res.setHeader('Content-Length', size);
        if (reporter) {
            reporter.progress('sending', { done: 0, total: size });
            watchResponse(res, reporter, size, label);
        }

        // Settled on the read stream's 'close' — the point at which its handle
        // on the staged file is released — so the cleanup below always has a
        // file it is allowed to delete.
        await new Promise((resolve) => {
            const stream = fs.createReadStream(stagedPath);
            stream.on('error', (err) => {
                log('error', `${label} failed while streaming: ${err.message}`);
                if (reporter) reporter.failed(err.message);
                res.destroy(err);
                stream.destroy();
            });
            stream.on('close', resolve);
            res.on('close', () => stream.destroy());
            stream.pipe(res);
        });

        return size;
    } finally {
        removeStagedFile(stagedPath);
    }
}

/**
 * Delete a staged archive, retrying briefly on Windows.
 *
 * Windows refuses to unlink a file any handle is still open on, and a handle
 * can outlive the event that closed its stream by a tick or two. Losing the
 * race would leave a full-sized archive behind until the reaper came round.
 */
function removeStagedFile(stagedPath, attempt = 0) {
    try {
        fs.unlinkSync(stagedPath);
    } catch (err) {
        if (err.code === 'ENOENT') return;
        if (attempt >= 5) {
            log('warn', `Could not remove staged download ${path.basename(stagedPath)}: ${err.message}`);
            return;
        }
        setTimeout(() => removeStagedFile(stagedPath, attempt + 1), 100 * (attempt + 1)).unref?.();
    }
}

/**
 * Run archiver into the staging file and resolve with the finished size, or
 * with 0 if the client walked away before it was done.
 *
 * Every path settles from the write stream's 'close' rather than at the moment
 * the outcome is decided, because 'close' is the point at which the staged
 * file's handle is definitely released. Resolving earlier races the caller's
 * cleanup, and on Windows an unlink against a still-open handle simply fails —
 * which is how an abandoned archive was left behind in the staging directory.
 */
function packArchive({ build, stagedPath, zlibLevel, estimatedBytes, reporter, res, label }) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: zlibLevel } });
        const out = fs.createWriteStream(stagedPath);
        let outcome = null; // { error } | { abandoned: true } | { packed: true }

        const fail = (err) => {
            if (outcome) return;
            outcome = { error: err };
            archive.abort();
            out.destroy();
        };

        // Abandon the pack if the client gives up on it — otherwise a cancelled
        // export keeps a CPU busy compressing bytes nobody will read.
        function onClientGone() {
            if (outcome || res.writableFinished) return;
            outcome = { abandoned: true };
            log('warn', `${label} cancelled by the client while packing`);
            archive.abort();
            out.destroy();
        }
        res.once('close', onClientGone);

        archive.on('warning', (err) => {
            // ENOENT here means a file vanished between the listing and the read
            // — worth a line, not worth failing the whole archive over.
            log('warn', `${label}: ${err.message}`);
        });
        archive.on('error', fail);
        out.on('error', fail);

        if (reporter) {
            archive.on('progress', (data) => {
                reporter.progress('packing', {
                    done: (data.fs && data.fs.processedBytes) || 0,
                    total: estimatedBytes || (data.fs && data.fs.totalBytes) || 0
                });
            });
        }

        out.on('close', () => {
            res.removeListener('close', onClientGone);
            if (!outcome) outcome = { packed: true };
            if (outcome.error) return reject(outcome.error);
            if (outcome.abandoned) return resolve(0);
            try {
                resolve(fs.statSync(stagedPath).size);
            } catch (err) {
                reject(err);
            }
        });

        archive.pipe(out);
        try {
            build(archive);
        } catch (err) {
            return fail(err);
        }
        archive.finalize().catch(fail);
    });
}

module.exports = {
    STAGING_DIR,
    initDownloads,
    stagingFreeBytes,
    DownloadReporter,
    sendFileDownload,
    sendArchiveDownload
};
