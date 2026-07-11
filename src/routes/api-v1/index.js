const express = require('express');
const router = express.Router();

router.use(require('./apikeys'));
router.use(require('./servers'));
router.use(require('./groups'));
router.use(require('./backups'));
router.use(require('./events'));
router.use(require('./plugins'));
router.use(require('./templates'));

module.exports = router;
