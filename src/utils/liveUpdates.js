// Live-update notifications for open panel pages.
//
// A mutation made through the API is reflected on the page that made it by
// that page's own script; these tell every OTHER open page about it, over the
// WebSocket, so nothing has to be reloaded by hand. Each carries the origin
// client id (`X-Client-Id`, minted per tab in public/js/app.js) so the tab
// that made the change can recognise its own broadcast and skip it — it has
// already updated itself, and a second refresh would only race the first.

// The server list or grouping changed (create/delete/import/rename/regroup).
// Goes to every authenticated socket: the dashboard subscribes per card, so a
// new server has no subscription to be told through yet.
function notifyDashboard(req) {
    req.app.get('serverManager')?.broadcastGlobal?.({
        type: 'dashboard-changed',
        origin: originOf(req)
    });
}

// One of a server's listings changed. Goes to that server's subscribers only.
// `extra` is scope detail — for files, the directory (relative to the server
// root, '' = root) whose listing changed, so a page on another directory can
// leave it alone.
function notifyContentChanged(req, serverId, scope, extra = {}) {
    req.app.get('serverManager')?.broadcastContentChanged?.(serverId, scope, {
        ...extra,
        origin: originOf(req)
    });
}

// The header is echoed to every subscriber, so it is capped rather than
// trusted to be the short id the panel sends.
function originOf(req) {
    return String(req.get('x-client-id') || '').slice(0, 64) || null;
}

module.exports = { notifyDashboard, notifyContentChanged };
