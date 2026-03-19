const session = require('express-session');
const { QuickDB } = require('quick.db');
const path = require('path');

const Store = session.Store;

class QuickDBStore extends Store {
    /**
     * @param {object} options
     * @param {QuickDB} options.db - A quick.db table instance for sessions
     * @param {number} [options.ttl=3600000] - Session TTL in milliseconds (default: 1 hour)
     * @param {number} [options.reapInterval=600000] - Cleanup interval in ms (default: 10 min)
     */
    constructor(options = {}) {
        super(options);
        this.db = options.db;
        this.ttl = options.ttl || 60 * 60 * 1000; // 1 hour
        this.reapInterval = options.reapInterval || 10 * 60 * 1000; // 10 minutes

        // Periodically clean up expired sessions
        this._reapTimer = setInterval(() => this._reap(), this.reapInterval);
        this._reapTimer.unref();
    }

    async get(sid, callback) {
        try {
            const data = await this.db.get(`sess_${sid}`);
            if (!data) return callback(null, null);

            // Check expiry
            if (data.expires && Date.now() > data.expires) {
                await this.destroy(sid, () => {});
                return callback(null, null);
            }

            callback(null, data.session);
        } catch (err) {
            callback(err);
        }
    }

    async set(sid, session, callback) {
        try {
            const expires = Date.now() + this.ttl;
            await this.db.set(`sess_${sid}`, { session, expires });
            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    async destroy(sid, callback) {
        try {
            await this.db.delete(`sess_${sid}`);
            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    async touch(sid, session, callback) {
        try {
            const data = await this.db.get(`sess_${sid}`);
            if (data) {
                data.expires = Date.now() + this.ttl;
                data.session = session;
                await this.db.set(`sess_${sid}`, data);
            }
            if (callback) callback(null);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    /**
     * Remove all expired sessions.
     */
    async _reap() {
        try {
            const all = await this.db.all();
            const now = Date.now();
            for (const row of all) {
                if (row.value?.expires && now > row.value.expires) {
                    await this.db.delete(row.id);
                }
            }
        } catch {
            // Ignore reap errors — best effort cleanup
        }
    }

    /**
     * Stop the reap timer (for graceful shutdown).
     */
    stopReap() {
        if (this._reapTimer) {
            clearInterval(this._reapTimer);
            this._reapTimer = null;
        }
    }
}

module.exports = QuickDBStore;
