const authRoutes = require('./auth');
const dashboardRoutes = require('./dashboard');
const serverRoutes = require('./servers');
const backupRoutes = require('./backups');
const apiRoutes = require('./api');

module.exports = function mountRoutes(app) {
    app.use(authRoutes);
    app.use(dashboardRoutes);
    app.use(serverRoutes);
    app.use(backupRoutes);
    app.use(apiRoutes);
};
