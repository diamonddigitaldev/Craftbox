const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { log } = require('../../utils/log');

/**
 * Check if an IP address is private/loopback/link-local.
 * Covers IPv4 private ranges, IPv4-mapped IPv6, and IPv6 loopback.
 */
function isPrivateIP(ip) {
    // Normalize IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1 → 127.0.0.1)
    const normalized = ip.replace(/^::ffff:/, '');

    // IPv6 loopback
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

    // IPv4 checks
    const parts = normalized.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p))) {
        const [a, b] = parts;
        if (a === 0) return true;                              // 0.0.0.0/8
        if (a === 10) return true;                             // 10.0.0.0/8
        if (a === 127) return true;                            // 127.0.0.0/8
        if (a === 169 && b === 254) return true;               // 169.254.0.0/16 (link-local / cloud metadata)
        if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
        if (a === 192 && b === 168) return true;               // 192.168.0.0/16
    }

    return false;
}

module.exports = {
    id: 'custom',
    name: 'Custom',
    description: 'Bring your own server jar via URL',
    icon: 'upload_file',
    logo: '/img/server-types/custom.svg',

    async listVersions() {
        // Custom type has no version list
        return null;
    },

    async getBuilds() {
        return null;
    },

    /**
     * Download a jar from a user-provided URL.
     * @param {string} url - The direct download URL for the jar file
     * @param {*} build - Unused
     * @param {string} destPath - Where to save the jar
     */
    async downloadJar(url, build, destPath) {
        if (!url || typeof url !== 'string') {
            throw new Error('A valid download URL is required for custom server jars.');
        }

        // Basic URL validation
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error('Invalid URL format.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('URL must use HTTP or HTTPS.');
        }

        // SSRF protection — resolve hostname and validate the actual IP address
        // This prevents bypasses via DNS rebinding, IPv6 alternate forms, decimal/octal IPs, etc.
        let resolved;
        try {
            resolved = await dns.lookup(parsed.hostname);
        } catch {
            throw new Error('Could not resolve hostname.');
        }
        if (isPrivateIP(resolved.address)) {
            throw new Error('URL must point to a public host.');
        }

        log('info', `Downloading custom server jar from ${url}...`);
        const jarRes = await fetch(url);
        if (!jarRes.ok) throw new Error(`Failed to download jar: HTTP ${jarRes.status}`);

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await jarRes.arrayBuffer());

        if (buffer.length === 0) {
            throw new Error('Downloaded file is empty.');
        }

        fs.writeFileSync(destPath, buffer);
        log('info', `Custom server jar downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
    }
};
