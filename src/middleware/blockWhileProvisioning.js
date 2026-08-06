const { serversDb } = require('../db');
const { STATES } = require('../mc/stateMachine');

// Close the management pages while a server is still being provisioned.
//
// Provisioning means the panel is mid-way through assembling the server
// directory — downloading a jar, extracting a modpack, unpacking a transfer
// archive. Settings, Properties, Plugins, Files and Backups all read or write
// those files, so acting on them races the provisioning job and reports state
// that isn't true yet. Console and Events stay open so the user can watch it
// finish.
//
// Mount after ensureAuth on routes carrying a :id param.
module.exports = async function blockWhileProvisioning(req, res, next) {
    const id = req.params.id;
    if (!id) return next();

    const server = await serversDb.get(`server_${id}`);
    // Unknown server — let the route render its own 404.
    if (!server) return next();

    const proc = req.app.get('serverManager')?.getProcess(id);
    const state = proc ? proc.state : server.state;
    if (state !== STATES.PROVISIONING) return next();

    req.session.flash = {
        info: 'This server is still being set up. Management pages open once it finishes.'
    };
    return res.redirect(`/servers/${id}`);
};
