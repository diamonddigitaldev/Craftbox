const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { usersDb, configDb, apiKeysDb } = require('../db');
const { passport, hashPassword, comparePassword, findUserByUsername } = require('../auth');
const { loginLimiter } = require('../security');
const ensureAuth = require('../middleware/ensureAuth');
const { log } = require('../utils/log');

// GET /setup — Show setup wizard (only if setup not complete)
router.get('/setup', async (req, res) => {
    const setupComplete = await configDb.get('setup.complete');
    if (setupComplete) return res.redirect('/dashboard');
    res.render('setup', {
        title: 'Setup',
        ogTitle: 'Craftbox',
        navbar: false,
        user: null,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// POST /setup — Create admin account
router.post('/setup', async (req, res, next) => {
    const setupComplete = await configDb.get('setup.complete');
    if (setupComplete) return res.redirect('/dashboard');

    const { username, password, confirmPassword } = req.body;

    // Validation
    if (!username || !password || !confirmPassword) {
        req.session.flash = { error: 'All fields are required.' };
        return res.redirect('/setup');
    }

    const trimmedUsername = username.trim();

    if (trimmedUsername.length < 3 || trimmedUsername.length > 32) {
        req.session.flash = { error: 'Username must be 3-32 characters.' };
        return res.redirect('/setup');
    }

    if (!/^[a-zA-Z0-9_\-]+$/.test(trimmedUsername)) {
        req.session.flash = { error: 'Username can only contain letters, numbers, hyphens, and underscores.' };
        return res.redirect('/setup');
    }

    if (password.length < 8) {
        req.session.flash = { error: 'Password must be at least 8 characters.' };
        return res.redirect('/setup');
    }

    if (password !== confirmPassword) {
        req.session.flash = { error: 'Passwords do not match.' };
        return res.redirect('/setup');
    }

    try {
        const id = uuidv4();
        const passwordHash = await hashPassword(password);
        const user = {
            id,
            username: trimmedUsername,
            passwordHash,
            role: 'admin',
            createdAt: new Date().toISOString(),
            lastLogin: new Date().toISOString()
        };

        await usersDb.set(`user_${id}`, user);
        await configDb.set('setup.complete', true);
        log('info', `Admin account "${trimmedUsername}" created during setup.`);

        // Auto-login after setup
        req.login(user, (err) => {
            if (err) return next(err);
            res.redirect('/dashboard');
        });
    } catch (err) {
        log('error', `Setup failed: ${err.message}`);
        req.session.flash = { error: 'An error occurred during setup. Please try again.' };
        res.redirect('/setup');
    }
});

// GET /login — Show login page
router.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.render('login', {
        title: 'Login',
        ogTitle: 'Craftbox',
        navbar: false,
        user: null,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// POST /login — Authenticate
router.post('/login', loginLimiter, (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) return next(err);
        if (!user) {
            req.session.flash = { error: info?.message || 'Invalid username or password.' };
            return res.redirect('/login');
        }

        // Passport 0.7 internally regenerates the session to prevent fixation
        const returnTo = req.session.returnTo;
        delete req.session.returnTo;

        // Prevent open redirect — only allow relative paths, block protocol-relative URLs
        const safeReturn = (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//'))
            ? returnTo : '/dashboard';

        req.login(user, (err) => {
            if (err) return next(err);
            res.redirect(safeReturn);
        });
    })(req, res, next);
});

// POST /logout — Destroy session
router.post('/logout', (req, res) => {
    const username = req.user?.username;
    req.logout((err) => {
        if (err) {
            log('error', `Logout error: ${err.message}`);
        }
        req.session.destroy(() => {
            if (username) log('info', `User "${username}" logged out.`);
            res.redirect('/login');
        });
    });
});

// ═══════════════════════════════════════════
// Account Settings
// ═══════════════════════════════════════════

// GET /account — Account settings page
router.get('/account', ensureAuth, async (req, res) => {
    const rows = await apiKeysDb.all();
    const apiKeys = rows
        .map(r => r.value)
        .filter(k => k && k.userId === req.user.id)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map(k => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            createdAt: k.createdAt,
            lastUsedAt: k.lastUsedAt || null
        }));

    res.render('account', {
        title: 'Account Settings',
        ogTitle: 'Craftbox',
        navbar: true,
        user: req.user,
        apiKeys,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

// POST /account — Update username and/or password
router.post('/account', ensureAuth, async (req, res) => {
    const { currentPassword, newUsername, newPassword, confirmNewPassword } = req.body;

    // Current password is always required for any change
    if (!currentPassword) {
        req.session.flash = { error: 'Current password is required.' };
        return res.redirect('/account');
    }

    // Verify current password
    const user = await usersDb.get(`user_${req.user.id}`);
    if (!user) {
        req.session.flash = { error: 'Account not found.' };
        return res.redirect('/account');
    }

    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) {
        req.session.flash = { error: 'Current password is incorrect.' };
        return res.redirect('/account');
    }

    const trimmedUsername = (newUsername || '').trim();
    const hasUsernameChange = trimmedUsername.length > 0 && trimmedUsername !== user.username;
    const hasPasswordChange = newPassword && newPassword.length > 0;

    if (!hasUsernameChange && !hasPasswordChange) {
        req.session.flash = { error: 'No changes provided.' };
        return res.redirect('/account');
    }

    // Validate new username
    if (hasUsernameChange) {
        if (trimmedUsername.length < 3 || trimmedUsername.length > 32) {
            req.session.flash = { error: 'Username must be 3-32 characters.' };
            return res.redirect('/account');
        }
        if (!/^[a-zA-Z0-9_\-]+$/.test(trimmedUsername)) {
            req.session.flash = { error: 'Username can only contain letters, numbers, hyphens, and underscores.' };
            return res.redirect('/account');
        }
        // Check for duplicate username
        const existing = await findUserByUsername(trimmedUsername);
        if (existing && existing.id !== user.id) {
            req.session.flash = { error: 'That username is already taken.' };
            return res.redirect('/account');
        }
    }

    // Validate new password
    if (hasPasswordChange) {
        if (newPassword.length < 8) {
            req.session.flash = { error: 'New password must be at least 8 characters.' };
            return res.redirect('/account');
        }
        if (newPassword !== confirmNewPassword) {
            req.session.flash = { error: 'New passwords do not match.' };
            return res.redirect('/account');
        }
    }

    try {
        if (hasUsernameChange) {
            const oldUsername = user.username;
            user.username = trimmedUsername;
            log('info', `User "${oldUsername}" changed username to "${trimmedUsername}".`);
        }
        if (hasPasswordChange) {
            user.passwordHash = await hashPassword(newPassword);
            log('info', `User "${user.username}" changed their password.`);
        }

        await usersDb.set(`user_${user.id}`, user);

        // Destroy session so the user must re-authenticate with new credentials
        req.logout((err) => {
            if (err) log('error', `Logout error after account update: ${err.message}`);
            req.session.destroy(() => {
                res.redirect('/login');
            });
        });
    } catch (err) {
        log('error', `Account update failed: ${err.message}`);
        req.session.flash = { error: 'An error occurred while updating your account.' };
        res.redirect('/account');
    }
});

module.exports = router;
