const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// Security headers middleware (OWASP compliant)
function securityHeaders(req, res, next) {
    // Per-request CSP nonce for the small bootstrap inline script in head.ejs
    // (window.CraftboxState). Templates can read res.locals.cspNonce.
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

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
            `script-src 'self' 'nonce-${nonce}'`,
            "connect-src 'self'",
            "img-src 'self' data:",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join('; ')
    );
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
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

    // Bearer-token auth on /api/v1/* is not CSRF-vulnerable — browsers can't
    // forge the Authorization header cross-origin without CORS preflight.
    if (req.apiKeyAuth) return next();

    const isApi = req.path.startsWith('/api/');
    const fail = (message) => {
        if (isApi) return res.status(403).json({ error: 'forbidden', message });
        return res.status(403).render('errors/403', {
            title: 'Forbidden',
            message,
            navbar: false,
            user: null
        });
    };

    const token = req.body?._csrf || req.headers['x-csrf-token'];
    if (!token || !req.session?.csrfToken) {
        return fail('Invalid or missing CSRF token. Please try again.');
    }

    // Constant-time comparison to prevent timing side-channel attacks
    const tokenBuf = Buffer.from(String(token));
    const expectedBuf = Buffer.from(req.session.csrfToken);
    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        return fail('Invalid or missing CSRF token. Please try again.');
    }

    next();
}

// Rate limiter for login endpoint (using express-rate-limit)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).render('errors/429', {
            title: 'Too Many Requests',
            message: 'Too many login attempts. Please try again later.',
            navbar: false,
            user: null
        });
    }
});

module.exports = { securityHeaders, csrfToken, csrfValidate, loginLimiter };
