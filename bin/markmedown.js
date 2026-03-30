#!/usr/bin/env node

import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.markmedown');
const PID_FILE = path.join(DATA_DIR, 'pid');
const PORT_FILE = path.join(DATA_DIR, 'port');
const LOG_FILE = path.join(DATA_DIR, 'markmedown.log');
const DEFAULT_PORT = 44444;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readPid() {
  try {
    return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function readPort() {
  try {
    return parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
  } catch {
    return DEFAULT_PORT;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleFiles() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(PORT_FILE); } catch {}
}

async function openBrowser(port) {
  const url = `http://localhost:${port}`;
  const { exec } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} ${url}`, (err) => {
    if (err) console.log(`Open ${url} in your browser`);
  });
}

async function startDaemon(port) {
  ensureDataDir();

  const serverPath = path.join(__dirname, '..', 'src', 'daemon.js');
  const logFd = fs.openSync(LOG_FILE, 'a');

  const child = fork(serverPath, [String(port)], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc'],
    env: { ...process.env, MARKMEDOWN_PORT: String(port) },
  });

  // Wait for the daemon to signal it's ready
  const ready = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    child.on('message', (msg) => {
      if (msg.status === 'ready') {
        clearTimeout(timeout);
        resolve(true);
      }
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });

  if (!ready) {
    console.error('Failed to start daemon');
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(child.pid));
  fs.writeFileSync(PORT_FILE, String(port));

  child.unref();
  child.disconnect();
  fs.closeSync(logFd);

  return child.pid;
}

function stopDaemon() {
  const pid = readPid();
  if (!pid) {
    console.log('markmedown is not running');
    return false;
  }

  if (!isProcessAlive(pid)) {
    console.log('markmedown was not running (stale pid file)');
    cleanupStaleFiles();
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`markmedown stopped (pid ${pid})`);
    cleanupStaleFiles();
    return true;
  } catch (err) {
    console.error(`Failed to stop: ${err.message}`);
    return false;
  }
}

function showStatus() {
  const pid = readPid();
  const port = readPort();

  if (!pid || !isProcessAlive(pid)) {
    if (pid) cleanupStaleFiles();
    console.log('markmedown is not running');
    return;
  }

  console.log(`markmedown is running`);
  console.log(`  PID:  ${pid}`);
  console.log(`  URL:  http://localhost:${port}`);
  console.log(`  Logs: ${LOG_FILE}`);
}

function generateSystemdService(port) {
  const nodePath = process.execPath;
  const daemonPath = path.resolve(path.join(__dirname, '..', 'src', 'daemon.js'));
  return `[Unit]
Description=markmedown - Markdown Knowledge Base
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${daemonPath} ${port}
Restart=on-failure
Environment=MARKMEDOWN_PORT=${port}

[Install]
WantedBy=default.target
`;
}

function generateLaunchdPlist(port) {
  const nodePath = process.execPath;
  const daemonPath = path.resolve(path.join(__dirname, '..', 'src', 'daemon.js'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.markmedown.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonPath}</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;
}

function installService(port) {
  ensureDataDir();

  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.markmedown.plist');
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, generateLaunchdPlist(port));
    console.log(`Installed launchd service: ${plistPath}`);
    console.log('Run: launchctl load ' + plistPath);
  } else {
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const servicePath = path.join(serviceDir, 'markmedown.service');
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, generateSystemdService(port));
    console.log(`Installed systemd service: ${servicePath}`);
    console.log('Run: systemctl --user enable --now markmedown');
  }
}

function uninstallService() {
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.markmedown.plist');
    try {
      fs.unlinkSync(plistPath);
      console.log('Removed launchd service');
    } catch {
      console.log('No launchd service found');
    }
  } else {
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'markmedown.service');
    try {
      fs.unlinkSync(servicePath);
      console.log('Removed systemd service');
      console.log('Run: systemctl --user daemon-reload');
    } catch {
      console.log('No systemd service found');
    }
  }
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0] || '';

// Parse --port flag
let port = DEFAULT_PORT;
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('Invalid port number');
    process.exit(1);
  }
}

switch (command) {
  case 'start': {
    const pid = readPid();
    if (pid && isProcessAlive(pid)) {
      console.log(`markmedown is already running (pid ${pid})`);
      console.log(`  URL: http://localhost:${readPort()}`);
      break;
    }
    if (pid) cleanupStaleFiles();

    const newPid = await startDaemon(port);
    console.log(`markmedown started (pid ${newPid})`);
    console.log(`  URL: http://localhost:${port}`);
    break;
  }

  case 'stop':
    stopDaemon();
    break;

  case 'status':
    showStatus();
    break;

  case 'install':
    installService(port);
    break;

  case 'uninstall':
    uninstallService();
    break;

  case 'help':
  case '--help':
  case '-h':
    console.log(`markmedown — Browse and edit all your markdown files

Usage:
  markmedown              Start daemon (if needed) and open browser
  markmedown start        Start daemon in background
  markmedown stop         Stop the daemon
  markmedown status       Show daemon status
  markmedown install      Auto-start on boot (systemd/launchd)
  markmedown uninstall    Remove auto-start

Options:
  --port <n>              Use custom port (default: ${DEFAULT_PORT})
  --help                  Show this help
`);
    break;

  default: {
    // Smart default: if daemon running → open browser, else start + open
    const existingPid = readPid();
    if (existingPid && isProcessAlive(existingPid)) {
      const existingPort = readPort();
      console.log(`markmedown is running at http://localhost:${existingPort}`);
      await openBrowser(existingPort);
    } else {
      if (existingPid) cleanupStaleFiles();
      const newPid = await startDaemon(port);
      console.log(`markmedown started (pid ${newPid})`);
      console.log(`  URL: http://localhost:${port}`);
      await openBrowser(port);
    }
    break;
  }
}
