const express = require('express');
const crypto = require('crypto');
const { apiKeysDb } = require('../../db');
const { log } = require('../../utils/log');

const router = express.Router();

// Never allow API-key-authed requests to manage keys. Rotating/creating/deleting
// keys must require an interactive login — otherwise a leaked key could
// bootstrap replacement keys or delete an admin's audit trail.
// Path-scoped so this doesn't bleed into other /api/v1/* routers mounted
// alongside this one in api-v1/index.js.
router.use('/account/apikeys', function requireSession(req, res, next) {
    if (req.apiKeyAuth) {
        return res.status(403).json({
            error: 'session_required',
            message: 'API keys cannot be managed via API key auth. Sign in to continue.'
        });
    }
    next();
});

const NAME_PATTERN = /^[A-Za-z0-9 _\-]{1,50}$/;
const KEY_PREFIX_LEN = 12; // first 12 chars of "cbx_…" shown in UI to identify the key

function publicKeyShape(record) {
    return {
        id: record.id,
        name: record.name,
        prefix: record.prefix,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt || null
    };
}

// GET /api/v1/account/apikeys — list keys owned by the current user
router.get('/account/apikeys', async (req, res) => {
    try {
        const rows = await apiKeysDb.all();
        const keys = rows
            .map(r => r.value)
            .filter(k => k && k.userId === req.user.id)
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
            .map(publicKeyShape);
        res.json({ keys });
    } catch (err) {
        log('error', `List API keys failed: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/v1/account/apikeys — generate a new key
router.post('/account/apikeys', async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name || !NAME_PATTERN.test(name)) {
        return res.status(400).json({
            error: 'invalid_name',
            message: 'Name must be 1-50 characters (letters, numbers, spaces, hyphens, underscores).'
        });
    }

    try {
        const rawKey = 'cbx_' + crypto.randomBytes(32).toString('base64url');
        const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const id = crypto.randomUUID();

        const record = {
            id,
            userId: req.user.id,
            name,
            hash,
            prefix: rawKey.slice(0, KEY_PREFIX_LEN),
            createdAt: new Date().toISOString(),
            lastUsedAt: null
        };

        await apiKeysDb.set(`apikey_${id}`, record);
        log('info', `User "${req.user.username}" created API key "${name}" (${record.prefix}...)`);

        res.status(201).json({
            id,
            name,
            key: rawKey, // shown exactly once
            prefix: record.prefix,
            createdAt: record.createdAt
        });
    } catch (err) {
        log('error', `Create API key failed: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

// DELETE /api/v1/account/apikeys/:id — delete a key
router.delete('/account/apikeys/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const record = await apiKeysDb.get(`apikey_${id}`);
        // 404 if missing or not owned by current user (don't leak existence)
        if (!record || record.userId !== req.user.id) {
            return res.status(404).json({ error: 'not_found' });
        }

        await apiKeysDb.delete(`apikey_${id}`);
        log('info', `User "${req.user.username}" deleted API key "${record.name}" (${record.prefix}...)`);
        res.status(204).end();
    } catch (err) {
        log('error', `Delete API key failed: ${err.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
