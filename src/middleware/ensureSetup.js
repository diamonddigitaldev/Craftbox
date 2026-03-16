const { configDb } = require('../db');

const SKIP_PREFIXES = ['/vendor', '/css', '/js', '/setup', '/status'];

module.exports = async function ensureSetup(req, res, next) {
    // Skip for static assets and the setup route itself
    if (SKIP_PREFIXES.some(prefix => req.path.startsWith(prefix))) {
        return next();
    }

    try {
        const setupComplete = await configDb.get('setup.complete');
        if (!setupComplete) {
            return res.redirect('/setup');
        }
        next();
    } catch (err) {
        next(err);
    }
};
