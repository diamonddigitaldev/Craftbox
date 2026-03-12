const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { usersDb, configDb } = require('../db');
const { passport, hashPassword, findUserByUsername } = require('../auth');
const { createRateLimiter } = require('../security');
const { log } = require('../utils/log');

const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

// GET /setup — Show setup wizard (only if setup not complete)
router.get('/setup', async (req, res) => {
    const setupComplete = await configDb.get('setup.complete');
    if (setupComplete) return res.redirect('/dashboard');
    res.render('setup', {
        title: 'Setup',
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
        req.session.flash = { error: 'Username must be 3–32 characters.' };
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

        // Regenerate session to prevent fixation
        const returnTo = req.session.returnTo;
        req.session.regenerate((err) => {
            if (err) return next(err);
            req.login(user, (err) => {
                if (err) return next(err);
                res.redirect(returnTo || '/dashboard');
            });
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

module.exports = router;
