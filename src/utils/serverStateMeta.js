// Single source of truth for server-state visual metadata (badge color,
// Material icon, display name). Consumed by:
//  - EJS partials and views via res.locals (injected by middleware below).
//  - Browser JS via window.CraftboxState (rendered into the page in head.ejs).
//
// Keep these maps in sync with src/mc/stateMachine.js — every state added
// there should get an entry here, otherwise the UI falls back to defaults.

const stateColors = {
    stopped: 'secondary',
    starting: 'info',
    running: 'success',
    stopping: 'warning',
    crashed: 'danger',
    backing_up: 'info',
    restoring: 'info',
    upgrading_jar: 'info',
    provisioning: 'info'
};

const stateIcons = {
    stopped: 'stop_circle',
    starting: 'hourglass_top',
    running: 'play_circle',
    stopping: 'pending',
    crashed: 'error',
    backing_up: 'backup',
    restoring: 'settings_backup_restore',
    upgrading_jar: 'upgrade',
    provisioning: 'build'
};

const stateDisplayNames = {
    backing_up: 'Backing Up',
    restoring: 'Restoring',
    upgrading_jar: 'Upgrading Jar',
    provisioning: 'Provisioning'
};

function getColor(state) {
    return stateColors[state] || 'secondary';
}
function getIcon(state) {
    return stateIcons[state] || 'help';
}
function getDisplayName(state) {
    if (stateDisplayNames[state]) return stateDisplayNames[state];
    if (!state) return '';
    return state.charAt(0).toUpperCase() + state.slice(1);
}

// Express middleware: makes maps + helpers available to every EJS template
// without each render call needing to pass them.
function injectIntoLocals(req, res, next) {
    res.locals.stateColors = stateColors;
    res.locals.stateIcons = stateIcons;
    res.locals.stateDisplayNames = stateDisplayNames;
    res.locals.getStateColor = getColor;
    res.locals.getStateIcon = getIcon;
    res.locals.getStateDisplayName = getDisplayName;
    next();
}

module.exports = {
    stateColors,
    stateIcons,
    stateDisplayNames,
    getColor,
    getIcon,
    getDisplayName,
    injectIntoLocals
};
