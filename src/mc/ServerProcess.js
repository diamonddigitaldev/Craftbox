const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { STATES, canTransition } = require('./stateMachine');
const { serversDb } = require('../db');
const { log } = require('../utils/log');
const { getJavaForVersion, getDefaultJava } = require('../utils/javaVersion');
const { logEvent, pruneEvents } = require('../utils/eventLogger');
const { getProvider } = require('./serverTypes');
const { clearCpuTracking } = require('../utils/resourceStats');

// Pattern that indicates the server is done starting
const DONE_PATTERN = /\]: Done \(/;
const OOM_PATTERN = /java\.lang\.OutOfMemoryError/;
const CRASH_REPORT_PATTERN = /Preparing crash report|This crash report has been saved to/;
const JOIN_PATTERN = /\]: (\S+) joined the game$/;
const LEAVE_PATTERN = /\]: (\S+) left the game$/;

class ServerProcess extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.id = config.id;
        this.state = config.state || STATES.STOPPED;
        this.child = null;
        this.subscribers = new Set(); // WebSocket clients
        this.lastLines = []; // Last 200 lines for history
        this.logStream = null;
        this.players = new Set(); // Currently online player names
        this._stopRequested = false;
        this._restartPending = false;
        this._crashDetected = false; // Set when crash report is detected in logs
        this._oomKillInProgress = false; // Guards against multiple OOM kill attempts
        this._initiatedBy = null; // Who triggered the current action (username or system label)
    }

    get serverDir() {
        return path.resolve(this.config.directory);
    }

    get logFilePath() {
        return path.join(this.serverDir, 'logs', 'craftbox-console.log');
    }

    /**
     * Transition to a new state with validation.
     */
    async setState(newState) {
        if (!canTransition(this.state, newState)) {
            log('warn', `[${this.config.name}] Invalid state transition: ${this.state} -> ${newState}`);
            return;
        }

        const oldState = this.state;
        this.state = newState;
        log('info', `[${this.config.name}] State: ${oldState} -> ${newState}`);

        // Clear players on stop/crash
        if ([STATES.STOPPED, STATES.CRASHED].includes(newState)) {
            this.players.clear();
        }

        // Persist to database
        try {
            const server = await serversDb.get(`server_${this.id}`);
            if (server) {
                server.state = newState;
                if (newState === STATES.RUNNING) server.lastStarted = new Date().toISOString();
                if (newState === STATES.STOPPED) server.lastStopped = new Date().toISOString();
                await serversDb.set(`server_${this.id}`, server);
            }
        } catch (err) {
            log('error', `[${this.config.name}] Failed to persist state: ${err.message}`);
        }

        // Log state-change events
        const eventTypes = {
            [STATES.RUNNING]: 'started',
            [STATES.STOPPED]: 'stopped',
            [STATES.CRASHED]: 'crashed'
        };
        if (eventTypes[newState]) {
            // Crashes are system events — never attribute to the user who started the server
            const extra = (this._initiatedBy && newState !== STATES.CRASHED)
                ? { initiatedBy: this._initiatedBy }
                : {};
            logEvent(this.id, eventTypes[newState], `Server ${eventTypes[newState]}`, extra).catch(() => {});
            pruneEvents(this.id, 500).catch(() => {});
        }

        // Broadcast state change to all WebSocket subscribers
        this.broadcast({
            type: 'state',
            serverId: this.id,
            state: newState,
            exitCode: this.config.exitCode || null,
            crashReason: this.config.crashReason || null
        });

        this.emit('stateChange', newState, oldState);
    }

    /**
     * Start the Minecraft server process.
     */
    async start() {
        if (this.child) {
            throw new Error('Server process already exists.');
        }

        this._stopRequested = false;
        this._crashDetected = false;
        this._oomKillInProgress = false;

        // Forge/NeoForge: remove 0-byte .jar files left by the installer
        if (this.config.serverType === 'forge' || this.config.serverType === 'neoforge') {
            try {
                const files = fs.readdirSync(this.serverDir);
                for (const file of files) {
                    if (file.endsWith('.jar')) {
                        const filePath = path.join(this.serverDir, file);
                        const stat = fs.statSync(filePath);
                        if (stat.size === 0) {
                            fs.unlinkSync(filePath);
                            log('info', `[${this.config.name}] Removed 0-byte jar: ${file}`);
                        }
                    }
                }
            } catch (err) {
                log('warn', `[${this.config.name}] Failed to clean 0-byte jars: ${err.message}`);
            }
        }

        await this.setState(STATES.STARTING);

        // Resolve the correct Java binary for this MC version
        const javaPath = this.config.version
            ? getJavaForVersion(this.config.version)
            : getDefaultJava();

        // Build the Java command
        const jarPath = path.join(this.serverDir, this.config.jarFile || 'server.jar');

        const args = [];
        args.push(`-Xmx${this.config.memory || 2048}M`);
        args.push(`-Xms${Math.min(this.config.memory || 2048, 1024)}M`);

        // Parse additional JVM args safely
        if (this.config.javaArgs) {
            const extraArgs = this.config.javaArgs.split(/\s+/).filter(a => a.length > 0);
            args.push(...extraArgs);
        }

        // Forge/NeoForge 1.17+ uses @args file instead of -jar
        if (this.config.serverType === 'forge' || this.config.serverType === 'neoforge') {
            const argsFile = this.config.serverType === 'neoforge'
                ? this._findNeoForgeArgsFile()
                : this._findForgeArgsFile();
            if (argsFile) {
                args.push(`@${argsFile}`, 'nogui');
            } else if (fs.existsSync(jarPath)) {
                args.push('-jar', jarPath, 'nogui');
            } else {
                throw new Error(`${this.config.serverType === 'neoforge' ? 'NeoForge' : 'Forge'} server jar or args file not found.`);
            }
        } else {
            if (!fs.existsSync(jarPath)) {
                throw new Error(`Server jar not found: ${jarPath}`);
            }
            args.push('-jar', jarPath, 'nogui');
        }

        log('info', `[${this.config.name}] Using Java: ${javaPath}`);
        log('info', `[${this.config.name}] Spawning: ${javaPath} ${args.join(' ')}`);

        // Open log stream
        const logsDir = path.join(this.serverDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });

        this.child = spawn(javaPath, args, {
            cwd: this.serverDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });

        // Display server type, version, and Java info in console
        const provider = getProvider(this.config.serverType);
        const typeName = provider ? provider.name : this.config.serverType || 'Unknown';
        const version = this.config.serverType === 'custom'
            ? '(Unknown Version)'
            : (this.config.version || '(Unknown Version)');
        let javaVer = 'Unknown';
        try {
            const javaVerOutput = execSync(`"${javaPath}" -version 2>&1`, {
                windowsHide: true,
                timeout: 5000
            }).toString();
            const match = javaVerOutput.match(/version "([^"]+)"/);
            if (match) javaVer = match[1];
        } catch {}
        this._appendLine(`[Craftbox] Starting ${typeName} ${version} using Java ${javaVer} (${javaPath})`);

        // Process stdout line by line
        const stdoutRL = readline.createInterface({ input: this.child.stdout });
        stdoutRL.on('line', (line) => this._handleLine(line, 'stdout'));

        // Process stderr line by line
        const stderrRL = readline.createInterface({ input: this.child.stderr });
        stderrRL.on('line', (line) => this._handleLine(line, 'stderr'));

        // Handle process exit
        this.child.on('close', (code, signal) => this._handleClose(code, signal));

        this.child.on('error', (err) => {
            log('error', `[${this.config.name}] Process error: ${err.message}`);
            this._appendLine(`[Craftbox] Process error: ${err.message}`);
        });
    }

    /**
     * Find Forge args file for 1.17+ style installations.
     */
    _findForgeArgsFile() {
        const libDir = path.join(this.serverDir, 'libraries', 'net', 'minecraftforge', 'forge');
        if (!fs.existsSync(libDir)) return null;

        try {
            const versions = fs.readdirSync(libDir).sort((a, b) => {
                const aParts = a.split(/[.\-]/).map(s => parseInt(s, 10) || 0);
                const bParts = b.split(/[.\-]/).map(s => parseInt(s, 10) || 0);
                for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                    const diff = (bParts[i] || 0) - (aParts[i] || 0);
                    if (diff !== 0) return diff;
                }
                return 0;
            });
            for (const ver of versions) {
                const argsName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
                const argsPath = path.join(libDir, ver, argsName);
                if (fs.existsSync(argsPath)) {
                    return path.relative(this.serverDir, argsPath);
                }
            }
        } catch {}
        return null;
    }

    /**
     * Find NeoForge args file for modern installations.
     * Sorts version directories descending so the newest version is picked first.
     */
    _findNeoForgeArgsFile() {
        const libDir = path.join(this.serverDir, 'libraries', 'net', 'neoforged', 'neoforge');
        if (!fs.existsSync(libDir)) return null;

        try {
            const versions = fs.readdirSync(libDir).sort((a, b) => {
                const aParts = a.split('.').map(s => parseInt(s, 10) || 0);
                const bParts = b.split('.').map(s => parseInt(s, 10) || 0);
                for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                    const diff = (bParts[i] || 0) - (aParts[i] || 0);
                    if (diff !== 0) return diff;
                }
                return 0;
            });
            for (const ver of versions) {
                const argsName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
                const argsPath = path.join(libDir, ver, argsName);
                if (fs.existsSync(argsPath)) {
                    return path.relative(this.serverDir, argsPath);
                }
            }
        } catch {}
        return null;
    }

    /**
     * Stop the server gracefully by sending the /stop command.
     */
    async stop() {
        if (!this.child) {
            throw new Error('Server is not running.');
        }

        const wasStarting = this.state === STATES.STARTING;
        this._stopRequested = true;
        await this.setState(STATES.STOPPING);

        if (wasStarting) {
            // Server hasn't finished loading — the "stop" command won't be processed.
            // Kill the process tree directly for a clean shutdown.
            log('info', `[${this.config.name}] Server was still starting, force killing.`);
            this._appendLine('[Craftbox] Server was still starting — terminating process.');
            this._killTree();
            return;
        }

        this.sendCommand('stop');

        // Safety timeout — force kill after 30s if not stopped
        this._stopTimeout = setTimeout(() => {
            if (this.child) {
                log('warn', `[${this.config.name}] Server did not stop within 30s, force killing.`);
                this._killTree();
            }
        }, 30000);
    }

    /**
     * Restart the server.
     */
    async restart() {
        this._restartPending = true;
        await this.stop();
        // The actual restart happens in _handleClose when _restartPending is true
    }

    /**
     * Kill the entire process tree (Java spawns child processes).
     * On Windows, child.kill() only terminates the direct child,
     * so we use taskkill /T to kill the whole tree.
     */
    _killTree() {
        if (!this.child) return;
        if (process.platform === 'win32') {
            try {
                execSync(`taskkill /F /T /PID ${this.child.pid}`, {
                    windowsHide: true,
                    stdio: 'ignore'
                });
            } catch {
                // Process may have already exited
            }
        } else {
            this.child.kill('SIGKILL');
        }
    }

    /**
     * Force kill the server.
     */
    async kill() {
        if (!this.child) {
            throw new Error('Server is not running.');
        }

        this._stopRequested = true;

        // Transition to stopping so the state machine stays valid
        if (this.state !== STATES.STOPPING) {
            await this.setState(STATES.STOPPING);
        }

        log('warn', `[${this.config.name}] Force killing server.`);
        this._killTree();
    }

    /**
     * Send a command to the server stdin.
     */
    sendCommand(line) {
        if (!this.child || !this.child.stdin?.writable) {
            return;
        }

        this.child.stdin.write(line + '\n');
        this._appendLine(`> ${line}`, 'command');
    }

    /**
     * Subscribe a WebSocket client.
     */
    subscribe(ws) {
        this.subscribers.add(ws);
        // Send history
        const msg = JSON.stringify({
            type: 'subscribed',
            serverId: this.id,
            state: this.state,
            history: this.lastLines.slice(-200),
            players: Array.from(this.players),
            playerCount: this.players.size,
            exitCode: this.config.exitCode || null,
            crashReason: this.config.crashReason || null
        });
        if (ws.readyState === 1) ws.send(msg);
    }

    /**
     * Unsubscribe a WebSocket client.
     */
    unsubscribe(ws) {
        this.subscribers.delete(ws);
    }

    /**
     * Broadcast a message to all subscribers.
     */
    broadcast(data) {
        const msg = JSON.stringify(data);
        for (const ws of this.subscribers) {
            if (ws.readyState === 1) {
                ws.send(msg);
            } else {
                this.subscribers.delete(ws);
            }
        }
    }

    /**
     * Handle a line of output.
     */
    _handleLine(line, source) {
        const timestamp = new Date().toISOString();

        // Store in history buffer
        this.lastLines.push(line);
        if (this.lastLines.length > 500) {
            this.lastLines = this.lastLines.slice(-200);
        }

        // Write to persistent log
        if (this.logStream?.writable) {
            this.logStream.write(`[${timestamp}] ${line}\n`);
        }

        // Broadcast to WebSocket subscribers
        this.broadcast({
            type: 'console',
            serverId: this.id,
            line,
            timestamp
        });

        // Detect server ready
        if (this.state === STATES.STARTING && DONE_PATTERN.test(line)) {
            this.setState(STATES.RUNNING);
        }

        // Detect crash report (Minecraft watchdog / fatal error)
        if (CRASH_REPORT_PATTERN.test(line)) {
            this._crashDetected = true;
        }

        // Live OOM detection — immediately kill the server to prevent data corruption
        if (OOM_PATTERN.test(line) && this.child && !this._oomKillInProgress) {
            this._oomKillInProgress = true;
            log('error', `[${this.config.name}] OutOfMemoryError detected! Killing server immediately to prevent data corruption.`);
            this._appendLine('[Craftbox] ⚠ OutOfMemoryError detected! Emergency shutdown initiated to prevent data corruption.');
            // Force kill without setting _stopRequested so _handleClose treats it as a crash
            this._crashDetected = true;
            this._killTree();
        }

        // Player join/leave detection
        if (this.state === STATES.RUNNING) {
            const joinMatch = JOIN_PATTERN.exec(line);
            if (joinMatch) {
                const playerName = joinMatch[1];
                this.players.add(playerName);
                this.broadcast({
                    type: 'players',
                    serverId: this.id,
                    players: Array.from(this.players),
                    count: this.players.size
                });
                logEvent(this.id, 'player_join', `${playerName} joined`, { playerName }).catch(() => {});
            }

            const leaveMatch = LEAVE_PATTERN.exec(line);
            if (leaveMatch) {
                const playerName = leaveMatch[1];
                this.players.delete(playerName);
                this.broadcast({
                    type: 'players',
                    serverId: this.id,
                    players: Array.from(this.players),
                    count: this.players.size
                });
                logEvent(this.id, 'player_leave', `${playerName} left`, { playerName }).catch(() => {});
            }
        }
    }

    /**
     * Append an internal line (not from MC process).
     */
    _appendLine(line, type = 'info') {
        const timestamp = new Date().toISOString();
        this.lastLines.push(line);
        if (this.lastLines.length > 500) {
            this.lastLines = this.lastLines.slice(-200);
        }
        if (this.logStream?.writable) {
            this.logStream.write(`[${timestamp}] ${line}\n`);
        }
        this.broadcast({
            type: 'console',
            serverId: this.id,
            line,
            timestamp
        });
    }

    /**
     * Handle process close event (watchdog).
     */
    async _handleClose(code, signal) {
        // Clear stop timeout if any
        if (this._stopTimeout) {
            clearTimeout(this._stopTimeout);
            this._stopTimeout = null;
        }

        // Close log stream
        if (this.logStream) {
            this.logStream.end();
            this.logStream = null;
        }

        // Clean up CPU tracking for this process
        if (this.child?.pid) clearCpuTracking(this.child.pid);

        this.child = null;

        log('info', `[${this.config.name}] Process exited with code ${code}, signal ${signal}`);
        this._appendLine(`[Craftbox] Server process exited (code: ${code}, signal: ${signal || 'none'})`);

        // Detect crash type — check multiple signals
        const wasOOM = this.lastLines.some(l => OOM_PATTERN.test(l));
        const hadCrashReport = this._crashDetected;
        const wasNonZeroExit = code !== null && code !== 0;
        const isCrash = !this._stopRequested && (wasOOM || hadCrashReport || wasNonZeroExit);

        if (this._stopRequested && !hadCrashReport) {
            // Clean shutdown — user requested stop
            await this._setStateRobust(STATES.STOPPED);

            // Update DB
            try {
                const server = await serversDb.get(`server_${this.id}`);
                if (server) {
                    server.exitCode = code;
                    server.crashReason = null;
                    server.crashDetected = false;
                    await serversDb.set(`server_${this.id}`, server);
                }
            } catch (err) {
                log('warn', `[${this.config.name}] Failed to update DB after stop: ${err.message}`);
            }

            // Handle pending restart
            if (this._restartPending) {
                this._restartPending = false;
                log('info', `[${this.config.name}] Restarting server...`);
                this._appendLine('[Craftbox] Restarting server...');
                logEvent(this.id, 'restarted', 'Server restarted').catch(() => {});
                setTimeout(() => this.start(), 2000);
            }
        } else if (isCrash) {
            // Crash or unexpected exit
            const crashReason = wasOOM ? 'oom' : hadCrashReport ? 'crash_report' : 'exit_code';
            await this._setStateRobust(STATES.CRASHED);

            const crashMsg = wasOOM
                ? 'Out of Memory detected.'
                : hadCrashReport
                    ? 'Crash report detected.'
                    : `Exit code: ${code}`;
            this._appendLine(`[Craftbox] Server crashed! ${crashMsg}`);

            // Update DB with crash info
            try {
                const server = await serversDb.get(`server_${this.id}`);
                if (server) {
                    server.exitCode = code;
                    server.crashReason = crashReason;
                    server.crashDetected = true;
                    await serversDb.set(`server_${this.id}`, server);
                }
            } catch (err) {
                log('warn', `[${this.config.name}] Failed to update DB after crash: ${err.message}`);
            }

            // Auto-restart on crash if enabled
            if (this.config.autoRestart && !this._stopRequested) {
                log('info', `[${this.config.name}] Auto-restarting in 5 seconds...`);
                this._appendLine('[Craftbox] Auto-restart enabled. Restarting in 5 seconds...');
                setTimeout(() => {
                    if (this.state === STATES.CRASHED) {
                        this.start();
                    }
                }, 5000);
            }
        } else {
            // Process exited with code 0 but stop wasn't requested — treat as clean stop
            await this._setStateRobust(STATES.STOPPED);

            try {
                const server = await serversDb.get(`server_${this.id}`);
                if (server) {
                    server.exitCode = code;
                    server.crashReason = null;
                    server.crashDetected = false;
                    await serversDb.set(`server_${this.id}`, server);
                }
            } catch (err) {
                log('warn', `[${this.config.name}] Failed to update DB after exit: ${err.message}`);
            }
        }

        this._stopRequested = false;
        this._crashDetected = false;
        this._oomKillInProgress = false;
        this._initiatedBy = null;
    }

    /**
     * Robust state setter — if the normal state transition is rejected,
     * force-correct the state to prevent zombie processes stuck in a stale state.
     * This is a safety net; under normal circumstances setState() should succeed.
     */
    async _setStateRobust(targetState) {
        const oldState = this.state;

        // Try the normal validated transition first
        await this.setState(targetState);

        // If setState rejected the transition, force it — the process is gone,
        // so keeping a stale state (like 'running') would be worse.
        if (this.state !== targetState) {
            log('warn', `[${this.config.name}] Force-correcting state: ${this.state} -> ${targetState} (process is dead)`);
            this.state = targetState;

            // Clear players on stop/crash
            if ([STATES.STOPPED, STATES.CRASHED].includes(targetState)) {
                this.players.clear();
            }

            // Persist the forced state
            try {
                const server = await serversDb.get(`server_${this.id}`);
                if (server) {
                    server.state = targetState;
                    if (targetState === STATES.STOPPED) server.lastStopped = new Date().toISOString();
                    await serversDb.set(`server_${this.id}`, server);
                }
            } catch (err) {
                log('error', `[${this.config.name}] Failed to persist forced state: ${err.message}`);
            }

            // Log event for forced transition
            const eventTypes = {
                [STATES.STOPPED]: 'stopped',
                [STATES.CRASHED]: 'crashed'
            };
            if (eventTypes[targetState]) {
                const extra = (this._initiatedBy && targetState !== STATES.CRASHED)
                    ? { initiatedBy: this._initiatedBy }
                    : {};
                logEvent(this.id, eventTypes[targetState], `Server ${eventTypes[targetState]} (forced from ${oldState})`, extra).catch(() => {});
            }

            // Broadcast state change
            this.broadcast({
                type: 'state',
                serverId: this.id,
                state: targetState,
                exitCode: this.config.exitCode || null,
                crashReason: this.config.crashReason || null
            });

            this.emit('stateChange', targetState, oldState);
        }
    }

    /**
     * Wait for the process to reach a target state.
     * Returns a Promise that resolves when the state is reached or rejects on timeout.
     */
    waitForState(targetState, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            if (this.state === targetState) return resolve();
            const terminalStates = [STATES.STOPPED, STATES.CRASHED];
            const onStateChange = (state) => {
                if (state === targetState) {
                    clearTimeout(timeout);
                    this.removeListener('stateChange', onStateChange);
                    resolve();
                } else if (terminalStates.includes(state) && state !== targetState) {
                    clearTimeout(timeout);
                    this.removeListener('stateChange', onStateChange);
                    reject(new Error(`Server reached state '${state}' while waiting for '${targetState}'`));
                }
            };
            const timeout = setTimeout(() => {
                this.removeListener('stateChange', onStateChange);
                reject(new Error(`Timed out waiting for state: ${targetState}`));
            }, timeoutMs);
            this.on('stateChange', onStateChange);
        });
    }

    /**
     * Clean up resources.
     */
    destroy() {
        if (this.child) {
            this._killTree();
        }
        if (this.logStream) {
            this.logStream.end();
            this.logStream = null;
        }
        this.subscribers.clear();
        this.removeAllListeners();
    }
}

module.exports = ServerProcess;
