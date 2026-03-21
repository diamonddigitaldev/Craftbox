const { log, LOG_LEVEL } = require('./utils/log');

log('info', 'Craftbox is starting...');
log('info', `LOG_LEVEL: ${LOG_LEVEL}`);

const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { version } = require('../package.json');
const { initDb, configDb, sessionsDb, statsDb, markAllServersStopped } = require('./db');
const QuickDBStore = require('./sessionStore');
const { passport } = require('./auth');
const { securityHeaders, csrfToken, csrfValidate } = require('./security');
const { initWebSocket } = require('./websocket');
const ServerManager = require('./mc/ServerManager');
const BackupScheduler = require('./mc/BackupScheduler');
const mountRoutes = require('./routes');

const rawPort = process.env.PORT;
const PORT = rawPort !== undefined ? Number(rawPort) : 6464;
if (isNaN(PORT) || PORT < 0 || PORT > 65535 || !Number.isInteger(PORT)) {
    log('error', 'Invalid PORT environment variable. Must be an integer between 0 and 65535.');
    process.exit(1);
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const validNodeEnvs = ['development', 'production', 'test'];
if (!validNodeEnvs.includes(NODE_ENV)) {
    log('warn', `Unrecognised NODE_ENV "${NODE_ENV}". Expected one of: ${validNodeEnvs.join(', ')}. Proceeding anyway.`);
}
log('info', `NODE_ENV: ${NODE_ENV}`);

(async () => {
    try {
        // ── 1. Initialize database ──
        log('info', 'Initializing database...');
        await initDb();

        // ── 2. Generate or retrieve session secret ──
        let sessionSecret = await configDb.get('session.secret');
        if (!sessionSecret) {
            sessionSecret = crypto.randomBytes(64).toString('hex');
            await configDb.set('session.secret', sessionSecret);
            log('info', 'Generated new session secret.');
        }

        // ── 3. Create Express app ──
        const app = express();

        // Trust proxy when behind reverse proxy / Docker
        // Set TRUST_PROXY=true if running behind a reverse proxy (e.g. Nginx, Caddy)
        app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

        // View engine
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, '..', 'views'));

        // ── 4. Initialize ServerManager & BackupScheduler ──
        const serverManager = new ServerManager();
        app.set('serverManager', serverManager);

        const backupScheduler = new BackupScheduler(serverManager);
        app.set('backupScheduler', backupScheduler);

        // ── 5. Middleware stack ──

        // Security headers
        app.use(securityHeaders);

        // Body parsing
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));

        // Session (backed by quick.db with 1-hour expiry)
        const sessionStore = new QuickDBStore({ db: sessionsDb, ttl: 60 * 60 * 1000 });
        const sessionMiddleware = session({
            store: sessionStore,
            secret: sessionSecret,
            resave: false,
            saveUninitialized: false,
            cookie: {
                httpOnly: true,
                secure: NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 60 * 60 * 1000 // 1 hour
            }
        });
        app.use(sessionMiddleware);

        // Passport
        app.use(passport.initialize());
        app.use(passport.session());

        // Make app version available to all views
        app.use((req, res, next) => {
            res.locals.version = version;
            next();
        });

        // Static assets — vendor (from node_modules)
        app.use('/vendor/bootstrap', express.static(
            path.join(__dirname, '..', 'node_modules', 'bootstrap', 'dist'),
            { maxAge: '7d', immutable: true }
        ));
        app.use('/vendor/material-icons', express.static(
            path.join(__dirname, '..', 'node_modules', 'material-icons', 'iconfont'),
            { maxAge: '7d', immutable: true }
        ));
        app.use('/vendor/chart.js', express.static(
            path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist'),
            { maxAge: '7d', immutable: true }
        ));

        // Static assets — app
        app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));

        // Public status routes (mounted before auth/CSRF — GET-only, no mutations)
        const statusRoutes = require('./routes/status');
        app.use(statusRoutes);

        // Setup check (global — before auth-protected routes)
        const ensureSetup = require('./middleware/ensureSetup');
        app.use(ensureSetup);

        // CSRF token injection + validation
        app.use(csrfToken);
        app.use(csrfValidate);

        // ── 6. Mount routes ──
        mountRoutes(app);

        // ── 7. Error handling ──

        // 404 handler
        app.use((req, res) => {
            res.status(404).render('errors/404', {
                title: '404',
                navbar: !!req.user,
                user: req.user || null,
                message: null
            });
        });

        // Global error handler
        app.use((err, req, res, next) => {
            log('error', `Unhandled error: ${err.message}`);
            if (NODE_ENV !== 'production') {
                log('error', err.stack);
            }
            res.status(500).render('errors/500', {
                title: 'Error',
                navbar: !!req.user,
                user: req.user || null,
                message: NODE_ENV === 'production' ? null : err.message
            });
        });

        // ── 8. Start HTTP server ──
        const server = http.createServer(app);

        // ── 9. Initialize WebSocket ──
        const wss = initWebSocket(server, sessionMiddleware, serverManager);

        // ── 10. Listen ──
        server.listen(PORT, () => {
            log('info', `Craftbox v${version} is running. | PORT: ${PORT}`);
        });

        // ── 11. Catch-up backups & auto-start servers ──
        await backupScheduler.init();
        await serverManager.autoStartServers();

        // ── 12. Graceful shutdown ──
        let shuttingDown = false;
        const handleShutdown = async () => {
            if (shuttingDown) return;
            shuttingDown = true;
            log('info', 'Craftbox is shutting down...');

            // Stop backup schedules
            backupScheduler.stopAll();

            // Stop all Minecraft servers gracefully
            try {
                await serverManager.stopAll();
            } catch (err) {
                log('error', `Error stopping servers: ${err.message}`);
            }

            // Ensure stale RUNNING/STARTING/STOPPING states never persist across restarts
            await markAllServersStopped({ reason: 'shutdown' });

            // Clear resource stats so they don't persist across restarts
            await statsDb.deleteAll();

            // Close WebSocket server and all connections
            log('info', 'Closing WebSocket connections...');
            for (const client of wss.clients) {
                client.close(1001, 'Server shutting down');
            }
            wss.close();

            // Close HTTP server
            log('info', 'Closing HTTP server...');
            server.close(() => {
                log('info', 'Craftbox shut down cleanly.');
                process.exit(0);
            });

            // Hard timeout
            setTimeout(() => {
                log('warn', 'Shutdown timed out. Forcing exit.');
                process.exit(1);
            }, 35000).unref();
        };

        process.on('SIGINT', handleShutdown);
        process.on('SIGTERM', handleShutdown);

    } catch (err) {
        log('error', `Fatal startup error: ${err.message}`);
        log('error', err.stack);
        process.exit(1);
    }
})();
