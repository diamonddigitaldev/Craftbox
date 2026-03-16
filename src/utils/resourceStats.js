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
            // Java spawns a process tree (parent + child JVM).
            // Collect PIDs for the parent and all children, then sum memory.
            const pids = _getProcessTreePids(pid);
            let totalBytes = 0;
            let found = false;
            for (const p of pids) {
                const output = execSync(
                    `tasklist /FI "PID eq ${p}" /FO CSV /NH`,
                    { windowsHide: true, encoding: 'utf8', timeout: 5000 }
                );
                const match = output.match(/"([0-9,]+)\sK"/);
                if (match) {
                    totalBytes += parseInt(match[1].replace(/,/g, ''), 10) * 1024;
                    found = true;
                }
            }
            if (found) return totalBytes;
        } else {
            // On Linux, read parent + all children from /proc
            const pids = _getProcessTreePidsLinux(pid);
            let totalBytes = 0;
            let found = false;
            for (const p of pids) {
                const statusPath = `/proc/${p}/status`;
                if (fs.existsSync(statusPath)) {
                    const content = fs.readFileSync(statusPath, 'utf8');
                    const match = content.match(/VmRSS:\s+(\d+)\s+kB/);
                    if (match) {
                        totalBytes += parseInt(match[1], 10) * 1024;
                        found = true;
                    }
                }
            }
            if (found) return totalBytes;
        }
    } catch {
        // Process may have exited
    }
    return null;
}

/**
 * Get all PIDs in a process tree on Windows (parent + children).
 * Uses wmic to find child processes recursively.
 */
function _getProcessTreePids(rootPid) {
    const pids = [rootPid];
    try {
        const output = execSync(
            `wmic process where (ParentProcessId=${rootPid}) get ProcessId /FORMAT:CSV`,
            { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        // CSV output has header line, then lines like: Node,ProcessId
        const lines = output.trim().split(/\r?\n/).filter(l => l.trim());
        for (const line of lines) {
            const parts = line.split(',');
            const childPid = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(childPid) && childPid !== rootPid) {
                // Recursively get children of children
                pids.push(..._getProcessTreePids(childPid));
            }
        }
    } catch {
        // wmic may fail if process has already exited
    }
    return pids;
}

/**
 * Get all PIDs in a process tree on Linux (parent + children).
 * Reads /proc/<pid>/task/../children or uses pgrep.
 */
function _getProcessTreePidsLinux(rootPid) {
    const pids = [rootPid];
    try {
        const childrenPath = `/proc/${rootPid}/task/${rootPid}/children`;
        if (fs.existsSync(childrenPath)) {
            const content = fs.readFileSync(childrenPath, 'utf8').trim();
            if (content) {
                const childPids = content.split(/\s+/).map(p => parseInt(p, 10)).filter(p => !isNaN(p));
                for (const childPid of childPids) {
                    pids.push(..._getProcessTreePidsLinux(childPid));
                }
            }
        }
    } catch {
        // Process may have exited
    }
    return pids;
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
