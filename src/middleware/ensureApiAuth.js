const crypto = require('crypto');
const { apiKeysDb, usersDb } = require('../db');
const { log } = require('../utils/log');

// Authenticate requests on /api/v1/* routes.
// Accepts either an existing Passport session OR an `Authorization: Bearer <key>` header.
// Never redirects — always returns JSON on failure so API clients don't chase 302s to /login.
module.exports = async function ensureApiAuth(req, res, next) {
    // Fast path — session auth already succeeded (browser frontend).
    if (req.isAuthenticated && req.isAuthenticated()) return next();

    const header = req.headers['authorization'] || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const rawKey = match[1];
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

    try {
        const rows = await apiKeysDb.all();
        const record = rows.find(r => r?.value?.hash === hash)?.value;
        if (!record) {
            return res.status(401).json({ error: 'unauthorized' });
        }

        const user = await usersDb.get(`user_${record.userId}`);
        if (!user) {
            // Key's owner was deleted — orphaned key; reject.
            return res.status(401).json({ error: 'unauthorized' });
        }

        req.user = user;
        req.apiKeyAuth = true;
        req.apiKeyId = record.id;

        // Bump lastUsedAt (non-blocking — don't hold up the request).
        record.lastUsedAt = new Date().toISOString();
        apiKeysDb.set(`apikey_${record.id}`, record).catch(err => {
            log('warn', `Failed to update apikey lastUsedAt: ${err.message}`);
        });

        return next();
    } catch (err) {
        log('error', `ensureApiAuth failed: ${err.message}`);
        return res.status(500).json({ error: 'internal_error' });
    }
};
