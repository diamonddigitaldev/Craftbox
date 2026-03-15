const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { STATES, canTransition } = require('./stateMachine');
const { serversDb } = require('../db');
const { log } = require('../utils/log');
const { getJavaForVersion, getDefaultJava } = require('../utils/javaVersion');

// Pattern that indicates the server is done starting
const DONE_PATTERN = /\]: Done \(/;
const OOM_PATTERN = /java\.lang\.OutOfMemoryError/;

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
        this._stopRequested = false;
        this._restartPending = false;
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

        // Broadcast state change to all WebSocket subscribers
        this.broadcast({
            type: 'state',
            serverId: this.id,
            state: newState,
            exitCode: this.config.exitCode || null
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

        // Forge: remove 0-byte .jar files left by the installer
        if (this.config.serverType === 'forge') {
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

        // Forge 1.17+ uses @args file instead of -jar
        if (this.config.serverType === 'forge') {
            const argsFile = this._findForgeArgsFile();
            if (argsFile) {
                args.push(`@${argsFile}`, 'nogui');
            } else if (fs.existsSync(jarPath)) {
                args.push('-jar', jarPath, 'nogui');
            } else {
                throw new Error('Forge server jar or args file not found.');
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
            const versions = fs.readdirSync(libDir);
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

        this._stopRequested = true;
        await this.setState(STATES.STOPPING);

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
            history: this.lastLines.slice(-200)
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

        this.child = null;

        log('info', `[${this.config.name}] Process exited with code ${code}, signal ${signal}`);
        this._appendLine(`[Craftbox] Server process exited (code: ${code}, signal: ${signal || 'none'})`);

        // Detect crash type
        const wasOOM = this.lastLines.some(l => OOM_PATTERN.test(l));

        if (this._stopRequested) {
            // Clean shutdown
            await this.setState(STATES.STOPPED);

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
                // ignore
            }

            // Handle pending restart
            if (this._restartPending) {
                this._restartPending = false;
                log('info', `[${this.config.name}] Restarting server...`);
                this._appendLine('[Craftbox] Restarting server...');
                setTimeout(() => this.start(), 2000);
            }
        } else {
            // Crash or unexpected exit
            const crashReason = wasOOM ? 'oom' : 'exit_code';
            await this.setState(STATES.CRASHED);

            this._appendLine(`[Craftbox] Server crashed! ${wasOOM ? 'Out of Memory detected.' : `Exit code: ${code}`}`);

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
                // ignore
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
        }

        this._stopRequested = false;
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
