const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const { usersDb } = require('./db');
const { log } = require('./utils/log');

const BCRYPT_ROUNDS = 12;

// Find user by username (scans all users — fine for small user count)
async function findUserByUsername(username) {
    const all = await usersDb.all();
    const entry = all.find(row => row.value && row.value.username === username);
    return entry ? entry.value : null;
}

// Find user by ID
async function findUserById(id) {
    return usersDb.get(`user_${id}`);
}

// Hash a password
async function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Compare password against hash
async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}

// Configure passport
passport.use(new LocalStrategy(async (username, password, done) => {
    try {
        const user = await findUserByUsername(username);
        if (!user) {
            log('warn', `Failed login attempt for username: ${username}`);
            return done(null, false, { message: 'Invalid username or password.' });
        }

        const valid = await comparePassword(password, user.passwordHash);
        if (!valid) {
            log('warn', `Failed login attempt for username: ${username}`);
            return done(null, false, { message: 'Invalid username or password.' });
        }

        // Update last login
        user.lastLogin = new Date().toISOString();
        await usersDb.set(`user_${user.id}`, user);

        log('info', `User "${username}" logged in successfully.`);
        return done(null, user);
    } catch (err) {
        return done(err);
    }
}));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await findUserById(id);
        done(null, user || false);
    } catch (err) {
        done(err);
    }
});

module.exports = {
    passport,
    findUserByUsername,
    findUserById,
    hashPassword,
    comparePassword
};
