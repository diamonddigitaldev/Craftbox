const STATES = {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    CRASHED: 'crashed',
    BACKING_UP: 'backing_up',
    RESTORING: 'restoring',
    UPGRADING_JAR: 'upgrading_jar',
    PROVISIONING: 'provisioning'
};

const VALID_TRANSITIONS = {
    [STATES.STOPPED]: [STATES.STARTING, STATES.BACKING_UP, STATES.RESTORING, STATES.UPGRADING_JAR],
    [STATES.STARTING]: [STATES.RUNNING, STATES.CRASHED, STATES.STOPPING, STATES.STOPPED],
    [STATES.RUNNING]: [STATES.STOPPING, STATES.CRASHED],
    [STATES.STOPPING]: [STATES.STOPPED, STATES.CRASHED],
    [STATES.CRASHED]: [STATES.STARTING, STATES.BACKING_UP, STATES.UPGRADING_JAR],
    [STATES.BACKING_UP]: [STATES.STOPPED],
    [STATES.RESTORING]: [STATES.STOPPED],
    [STATES.UPGRADING_JAR]: [STATES.STOPPED, STATES.CRASHED],
    [STATES.PROVISIONING]: [STATES.STOPPED, STATES.CRASHED]
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
