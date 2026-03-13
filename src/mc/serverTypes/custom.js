const fs = require('fs');
const path = require('path');
const { log } = require('../../utils/log');

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

        // Block private/loopback addresses (SSRF protection)
        const hostname = parsed.hostname.toLowerCase();
        if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/.test(hostname)) {
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
