const authRoutes = require('./auth');
const dashboardRoutes = require('./dashboard');
const serverRoutes = require('./servers');
const backupRoutes = require('./backups');
const eventRoutes = require('./events');
const pluginRoutes = require('./plugins');
const libraryRoutes = require('./library');
const templateRoutes = require('./templates');
const apiRoutes = require('./api');

module.exports = function mountRoutes(app) {
    app.use(authRoutes);
    app.use(dashboardRoutes);
    app.use(serverRoutes);
    app.use(backupRoutes);
    app.use(eventRoutes);
    app.use(pluginRoutes);
    app.use(libraryRoutes);
    app.use(templateRoutes);
    app.use(apiRoutes);
};
