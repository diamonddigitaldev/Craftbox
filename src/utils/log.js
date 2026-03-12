const LOG_LEVELS = { NONE: -1, ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

const normalizeLogLevel = (value) => {
    const upper = String(value || '').trim().toUpperCase();
    return LOG_LEVELS[upper] !== undefined ? upper : 'INFO';
};

const rawLogLevel = process.env.LOG_LEVEL;
const LOG_LEVEL = normalizeLogLevel(rawLogLevel || 'INFO');
const LOG_LEVEL_NUM = LOG_LEVELS[LOG_LEVEL];

const shouldLog = (level) => {
    const normalized = normalizeLogLevel(level);
    return LOG_LEVELS[normalized] <= LOG_LEVEL_NUM;
};

const log = (level, message) => {
    const normalized = normalizeLogLevel(level);
    if (!shouldLog(normalized)) return;
    const prefix = `[${new Date().toISOString()}] [${normalized}]`;
    const out = `${prefix} ${message}`;
    if (normalized === 'ERROR') return console.error(out);
    if (normalized === 'WARN') return console.warn(out);
    if (normalized === 'INFO') return console.info(out);
    return console.debug(out);
};

if (rawLogLevel && normalizeLogLevel(rawLogLevel) === 'INFO' && String(rawLogLevel).trim().toUpperCase() !== 'INFO') {
    log('warn', 'Invalid LOG_LEVEL value. Defaulting to INFO.');
}

module.exports = { log, shouldLog, LOG_LEVEL };
