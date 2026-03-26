const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { SERVERS_DIR } = require('../db');
const { log } = require('./log');

const ICON_FILENAME = 'server-icon.png';
const DEFAULT_ICON_PATH = path.resolve(__dirname, '../../public/img/craftbox-icon-64.png');

/**
 * Get the path to a server's icon file.
 */
function getIconPath(serverId) {
    return path.join(SERVERS_DIR, serverId, ICON_FILENAME);
}

/**
 * Check whether a server has a custom icon (or the Craftbox default).
 * Returns false only if server-icon.png does not exist at all.
 */
function hasIcon(serverId) {
    return fs.existsSync(getIconPath(serverId));
}

/**
 * Copy the default Craftbox icon into a server's directory.
 * Returns true if successful, false if the default icon file is missing.
 */
function copyDefaultIcon(serverId) {
    if (!fs.existsSync(DEFAULT_ICON_PATH)) {
        log('warn', `Default server icon not found at ${DEFAULT_ICON_PATH}`);
        return false;
    }
    const dest = getIconPath(serverId);
    fs.copyFileSync(DEFAULT_ICON_PATH, dest);
    return true;
}

/**
 * Process and save an uploaded icon for a server.
 * Resizes to exactly 64x64 PNG (Minecraft requirement).
 * @param {string} serverId
 * @param {string} tempFilePath - Path to the uploaded temp file
 * @returns {Promise<void>}
 */
async function setServerIcon(serverId, tempFilePath) {
    const dest = getIconPath(serverId);

    await sharp(tempFilePath)
        .resize(64, 64, { fit: 'cover' })
        .png()
        .toFile(dest);
}

/**
 * Reset a server's icon back to the Craftbox default.
 * @param {string} serverId
 * @returns {boolean} true if reset succeeded
 */
function resetServerIcon(serverId) {
    return copyDefaultIcon(serverId);
}

/**
 * Remove a server's icon file entirely (fallback to MC default).
 */
function removeServerIcon(serverId) {
    const iconPath = getIconPath(serverId);
    if (fs.existsSync(iconPath)) {
        fs.unlinkSync(iconPath);
    }
}

module.exports = {
    ICON_FILENAME,
    DEFAULT_ICON_PATH,
    getIconPath,
    hasIcon,
    copyDefaultIcon,
    setServerIcon,
    resetServerIcon,
    removeServerIcon
};
