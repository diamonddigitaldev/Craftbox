const express = require('express');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');
const { templatesDb } = require('../db');

// GET /templates — Templates list page (view only; mutations live on /api/v1/templates)
router.get('/templates', ensureAuth, async (req, res) => {
    const rows = await templatesDb.all();
    const templates = rows
        .map(r => r.value)
        .filter(t => t && typeof t === 'object')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.render('templates', {
        title: 'Templates',
        description: 'View and manage server templates.',
        navbar: true,
        user: req.user,
        templates,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

module.exports = router;
