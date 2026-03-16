const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Get memory usage of a process by PID (RSS in bytes).
 * Cross-platform: Windows uses tasklist, Linux reads /proc.
 */
function getProcessMemory(pid) {
    if (!pid) return null;
    try {
        if (process.platform === 'win32') {
            const output = execSync(
                `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
                { windowsHide: true, encoding: 'utf8', timeout: 5000 }
            );
            const match = output.match(/"([0-9,]+)\sK"/);
            if (match) {
                return parseInt(match[1].replace(/,/g, ''), 10) * 1024;
            }
        } else {
            const statusPath = `/proc/${pid}/status`;
            if (fs.existsSync(statusPath)) {
                const content = fs.readFileSync(statusPath, 'utf8');
                const match = content.match(/VmRSS:\s+(\d+)\s+kB/);
                if (match) {
                    return parseInt(match[1], 10) * 1024;
                }
            }
        }
    } catch {
        // Process may have exited
    }
    return null;
}

/**
 * Get total disk usage of a directory in bytes.
 */
function getDirectorySize(dirPath) {
    let totalSize = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            try {
                if (entry.isDirectory()) {
                    totalSize += getDirectorySize(fullPath);
                } else if (entry.isFile()) {
                    totalSize += fs.statSync(fullPath).size;
                }
            } catch {
                // Skip inaccessible files
            }
        }
    } catch {
        // Directory may not exist
    }
    return totalSize;
}

/**
 * Calculate uptime in seconds from a lastStarted ISO timestamp.
 */
function getUptime(lastStarted) {
    if (!lastStarted) return 0;
    const started = new Date(lastStarted).getTime();
    if (isNaN(started)) return 0;
    return Math.max(0, Math.floor((Date.now() - started) / 1000));
}

/**
 * Format bytes to human-readable string.
 */
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + units[i];
}

/**
 * Format seconds to human-readable uptime string.
 */
function formatUptime(seconds) {
    if (seconds <= 0) return 'Offline';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

module.exports = { getProcessMemory, getDirectorySize, getUptime, formatSize, formatUptime };
