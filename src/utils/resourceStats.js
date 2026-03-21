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
 * Uses PowerShell Get-CimInstance (wmic was removed in Windows 11 22H2+).
 */
function _getProcessTreePids(rootPid) {
    const pids = [rootPid];
    try {
        const output = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${rootPid}\\" | Select-Object -ExpandProperty ProcessId"`,
            { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const lines = output.trim().split(/\r?\n/).filter(l => l.trim());
        for (const line of lines) {
            const childPid = parseInt(line.trim(), 10);
            if (!isNaN(childPid) && childPid !== rootPid) {
                pids.push(..._getProcessTreePids(childPid));
            }
        }
    } catch {
        // PowerShell may fail if process has already exited
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
 * Get CPU usage percentage for a process tree.
 * Uses a two-sample measurement over a short interval.
 * Returns a percentage value (can exceed 100 on multi-core).
 */
const _cpuPrev = new Map();

function getProcessCpu(pid) {
    if (!pid) return null;
    try {
        if (process.platform === 'win32') {
            const pids = _getProcessTreePids(pid);
            let totalTime = 0;
            for (const p of pids) {
                try {
                    const output = execSync(
                        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${p}\\").KernelModeTime, (Get-CimInstance Win32_Process -Filter \\"ProcessId=${p}\\").UserModeTime"`,
                        { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
                    );
                    const lines = output.trim().split(/\r?\n/).filter(l => l.trim());
                    for (const line of lines) {
                        const val = parseInt(line.trim(), 10);
                        if (!isNaN(val)) totalTime += val;
                    }
                } catch {}
            }
            // Convert from 100-nanosecond units to milliseconds
            const cpuTimeMs = totalTime / 10000;
            const now = Date.now();
            const prev = _cpuPrev.get(pid);
            _cpuPrev.set(pid, { time: now, cpu: cpuTimeMs });
            if (prev) {
                const elapsed = now - prev.time;
                if (elapsed > 0) {
                    return Math.round(((cpuTimeMs - prev.cpu) / elapsed) * 1000) / 10;
                }
            }
            return null; // First sample — no delta yet
        } else {
            // Linux: read /proc/<pid>/stat for each process in tree
            const pids = _getProcessTreePidsLinux(pid);
            let totalTicks = 0;
            const clockTick = 100; // sysconf(_SC_CLK_TCK) is typically 100 on Linux
            for (const p of pids) {
                try {
                    const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
                    const fields = stat.match(/\) .*/)?.[0].split(' ') || [];
                    // After splitting ") ...", fields[0]=")", fields[1]=state, ...
                    // utime is at index 12, stime at index 13
                    const utime = parseInt(fields[12], 10) || 0;
                    const stime = parseInt(fields[13], 10) || 0;
                    totalTicks += utime + stime;
                } catch {}
            }
            const cpuTimeMs = (totalTicks / clockTick) * 1000;
            const now = Date.now();
            const prev = _cpuPrev.get(pid);
            _cpuPrev.set(pid, { time: now, cpu: cpuTimeMs });
            if (prev) {
                const elapsed = now - prev.time;
                if (elapsed > 0) {
                    return Math.round(((cpuTimeMs - prev.cpu) / elapsed) * 1000) / 10;
                }
            }
            return null;
        }
    } catch {
        return null;
    }
}

/**
 * Clean up CPU tracking for a process that has exited.
 */
function clearCpuTracking(pid) {
    _cpuPrev.delete(pid);
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

module.exports = { getProcessMemory, getProcessCpu, clearCpuTracking, getDirectorySize, getUptime, formatSize, formatUptime };
