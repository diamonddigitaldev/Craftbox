const crypto = require('crypto');

// Security headers middleware (OWASP compliant)
function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self'",
            "script-src 'self'",
            "connect-src 'self' ws: wss:",
            "img-src 'self' data:",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join('; ')
    );
    next();
}

// CSRF synchronizer token middleware
function csrfToken(req, res, next) {
    if (!req.session) return next();
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
    next();
}

function csrfValidate(req, res, next) {
    // Skip for non-mutating methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const token = req.body?._csrf || req.headers['x-csrf-token'];
    if (!token || !req.session?.csrfToken || token !== req.session.csrfToken) {
        return res.status(403).render('errors/403', {
            title: 'Forbidden',
            message: 'Invalid or missing CSRF token. Please try again.',
            navbar: false,
            user: null
        });
    }
    next();
}

// Rate limiter for login endpoint
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 5 } = {}) {
    const attempts = new Map();

    // Periodic cleanup of expired entries
    setInterval(() => {
        const now = Date.now();
        for (const [key, timestamps] of attempts) {
            const valid = timestamps.filter(t => now - t < windowMs);
            if (valid.length === 0) {
                attempts.delete(key);
            } else {
                attempts.set(key, valid);
            }
        }
    }, windowMs).unref();

    return (req, res, next) => {
        const key = req.ip || req.socket.remoteAddress;
        const now = Date.now();
        const timestamps = (attempts.get(key) || []).filter(t => now - t < windowMs);

        if (timestamps.length >= max) {
            return res.status(429).render('errors/429', {
                title: 'Too Many Requests',
                message: 'Too many login attempts. Please try again later.',
                navbar: false,
                user: null
            });
        }

        timestamps.push(now);
        attempts.set(key, timestamps);
        next();
    };
}

module.exports = { securityHeaders, csrfToken, csrfValidate, createRateLimiter };
