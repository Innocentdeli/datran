#!/usr/bin/env node

/**
 * DATRAN UNIFIED RUNNER
 * Launches both the Native Rust Core Reactor and the Next.js Web Portal.
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT_DIR = path.resolve(__dirname, '..');
const CORE_DIR = path.join(ROOT_DIR, 'core-reactor');
const APP_DIR = path.join(ROOT_DIR, 'diocom-app');

const RUST_PORT = process.env.REACTOR_PORT || '3005';
const NEXT_PORT = process.env.PORT || '3001';

console.log('\x1b[36m%s\x1b[0m', '╔══════════════════════════════════════════════════════════════════╗');
console.log('\x1b[36m%s\x1b[0m', '║              ⚡ DATRAN HIGH-THROUGHPUT SYSTEM                    ║');
console.log('\x1b[36m%s\x1b[0m', '║       Starting Native Rust Core Reactor + Next.js Portal        ║');
console.log('\x1b[36m%s\x1b[0m', '╚══════════════════════════════════════════════════════════════════╝');

// Configure PATH for Windows MinGW toolchain if installed via WinGet
let env = { ...process.env, REACTOR_PORT: RUST_PORT, PORT: NEXT_PORT };
if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || '';
    const winlibsBin = path.join(
        userProfile,
        'AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin'
    );
    const cargoBin = path.join(userProfile, '.cargo/bin');
    const extraPaths = [winlibsBin, cargoBin].filter(p => fs.existsSync(p));
    if (extraPaths.length > 0) {
        env.PATH = `${extraPaths.join(';')};${env.PATH || ''}`;
    }
}

let rustProcess = null;
let nextProcess = null;
let stopped = false;

// Synchronous so it also works from the 'exit' handler, where async work never runs.
function killTree(child) {
    if (!child || child.exitCode !== null) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
            child.kill('SIGTERM');
        }
    } catch { }
}

function stopChildren() {
    if (stopped) return;
    stopped = true;
    console.log('\n\x1b[33m[DATRAN] Shutting down services...\x1b[0m');
    killTree(nextProcess);
    killTree(rustProcess);
}

function shutdown(code = 0) {
    stopChildren();
    process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', stopChildren);

// Determine Rust executable
function getRustCommand() {
    const isWindows = process.platform === 'win32';
    const releaseExe = path.join(CORE_DIR, 'target', 'release', isWindows ? 'core-reactor.exe' : 'core-reactor');
    const debugExe = path.join(CORE_DIR, 'target', 'debug', isWindows ? 'core-reactor.exe' : 'core-reactor');

    if (fs.existsSync(releaseExe)) {
        return { cmd: releaseExe, args: [], label: 'Precompiled Release Binary' };
    }
    if (fs.existsSync(debugExe)) {
        return { cmd: debugExe, args: [], label: 'Precompiled Debug Binary' };
    }
    return { cmd: 'cargo', args: ['run', '--release'], label: 'Cargo Run (Release)' };
}

// With a reactor available, new uploads go to its chunked object store (NETWORK_SPEC §2), unless the user chose a
// backend explicitly (an existing STORAGE_BACKEND=local|s3|reactor is always respected).
function preferReactorStore(reason) {
    if (process.env.STORAGE_BACKEND) return;
    env.STORAGE_BACKEND = 'reactor';
    console.log(`\x1b[32m[RUST CORE] STORAGE_BACKEND=reactor (${reason})\x1b[0m`);
}

// Check health of Rust reactor
function checkRustHealth() {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${RUST_PORT}/health`, (res) => {
            if (res.statusCode === 200) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function startRust() {
    // If an existing instance is already running on the port, reuse it
    const alreadyRunning = await checkRustHealth();
    if (alreadyRunning) {
        console.log(`\x1b[32m[RUST CORE] Active daemon detected on http://127.0.0.1:${RUST_PORT} (not managed by this runner)\x1b[0m`);
        if (!process.env.REACTOR_TOKEN) {
            console.warn('\x1b[33m[RUST CORE] REACTOR_TOKEN is not set; if that daemon requires one, the app will use the TS fallback.\x1b[0m');
            console.warn('\x1b[33m[RUST CORE] Uploads stay on the default storage backend without a token (set STORAGE_BACKEND=reactor to force).\x1b[0m');
        } else {
            preferReactorStore('existing daemon');
        }
        return;
    }

    // Shared secret between the app and the reactor we launch.
    env.REACTOR_TOKEN = process.env.REACTOR_TOKEN || crypto.randomBytes(24).toString('base64url');

    const { cmd, args, label } = getRustCommand();
    console.log(`\x1b[34m[RUST CORE] Launching via ${label}...\x1b[0m`);

    rustProcess = spawn(cmd, args, {
        cwd: CORE_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: cmd === 'cargo',
    });

    rustProcess.stdout.on('data', (d) => {
        const text = d.toString().trim();
        if (text) console.log(`\x1b[34m[RUST CORE]\x1b[0m ${text}`);
    });

    rustProcess.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (text) console.error(`\x1b[31m[RUST CORE ERR]\x1b[0m ${text}`);
    });

    rustProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`\x1b[31m[RUST CORE] Process exited with code ${code}\x1b[0m`);
        }
    });

    // Poll until healthy
    console.log(`\x1b[34m[RUST CORE] Waiting for port ${RUST_PORT}...\x1b[0m`);
    let attempts = 0;
    while (attempts < 20) {
        await new Promise((r) => setTimeout(r, 500));
        if (await checkRustHealth()) {
            console.log(`\x1b[32m[RUST CORE] ⚡ Engine online at http://127.0.0.1:${RUST_PORT}\x1b[0m`);
            preferReactorStore('launched daemon');
            return;
        }
        attempts++;
    }
    console.warn(`\x1b[33m[RUST CORE] Warning: Health check timed out. Proceeding with Next.js fallback.\x1b[0m`);
}

function startNext() {
    console.log(`\x1b[35m[NEXT.JS] Launching Web Portal on port ${NEXT_PORT}...\x1b[0m`);

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    nextProcess = spawn(npmCmd, ['run', 'dev', '--', '-p', NEXT_PORT], {
        cwd: APP_DIR,
        env,
        stdio: 'inherit',
    });

    nextProcess.on('exit', (code) => {
        console.log(`\x1b[35m[NEXT.JS] Dev server exited with code ${code}\x1b[0m`);
        shutdown(code ?? 0);
    });
}

async function main() {
    await startRust();
    startNext();
}

main().catch((err) => {
    console.error('Fatal runner error:', err);
    shutdown(1);
});
