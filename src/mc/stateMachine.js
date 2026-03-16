const STATES = {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    CRASHED: 'crashed'
};

const VALID_TRANSITIONS = {
    [STATES.STOPPED]: [STATES.STARTING],
    [STATES.STARTING]: [STATES.RUNNING, STATES.CRASHED, STATES.STOPPING, STATES.STOPPED],
    [STATES.RUNNING]: [STATES.STOPPING, STATES.CRASHED],
    [STATES.STOPPING]: [STATES.STOPPED, STATES.CRASHED],
    [STATES.CRASHED]: [STATES.STARTING]
};

// Which actions are allowed in which states
const ALLOWED_ACTIONS = {
    start: [STATES.STOPPED, STATES.CRASHED],
    stop: [STATES.RUNNING, STATES.STARTING],
    restart: [STATES.RUNNING],
    kill: [STATES.RUNNING, STATES.STARTING, STATES.STOPPING]
};

function canTransition(from, to) {
    return (VALID_TRANSITIONS[from] || []).includes(to);
}

function canPerformAction(state, action) {
    return (ALLOWED_ACTIONS[action] || []).includes(state);
}

module.exports = { STATES, VALID_TRANSITIONS, ALLOWED_ACTIONS, canTransition, canPerformAction };
