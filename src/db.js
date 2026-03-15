const path = require('path');
const fs = require('fs');
const { QuickDB } = require('quick.db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Ensure data directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SERVERS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const db = new QuickDB({ filePath: path.join(DATA_DIR, 'craftbox.sqlite') });
const usersDb = db.table('users');
const serversDb = db.table('servers');
const configDb = db.table('config');
const backupsDb = db.table('backups');

async function initDb() {
    await db.init();
    await usersDb.init();
    await serversDb.init();
    await configDb.init();
    await backupsDb.init();
}

module.exports = { db, usersDb, serversDb, configDb, backupsDb, initDb, DATA_DIR, SERVERS_DIR, BACKUPS_DIR };
