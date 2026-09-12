/**
 * Format bytes to a human-readable string.
 *
 * Lives here rather than in BackupManager because downloads, exports and
 * backups all report sizes and none of them should reach into the others to
 * borrow the formatter. BackupManager re-exports it for its existing callers.
 */
function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

module.exports = { formatSize };
