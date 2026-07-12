const express = require('express');
const router = express.Router();
const ensureAuth = require('../middleware/ensureAuth');

// GET /modpacks — Browse Modrinth modpacks
router.get('/modpacks', ensureAuth, (req, res) => {
    res.render('modpacks', {
        title: 'Modpacks',
        navbar: true,
        user: req.user,
        messages: req.session.flash || {},
        csrfToken: res.locals.csrfToken
    });
    delete req.session.flash;
});

module.exports = router;
