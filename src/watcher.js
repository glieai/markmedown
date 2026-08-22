import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { recentlyWritten } from './server.js';
import { loadIgnorePatterns, shouldIgnoreDir } from './ignore.js';

const ignoreSet = loadIgnorePatterns();

// Never claim more than this share of the user's inotify quota. The graphical
// session (systemd --user, wireplumber, portals, editors) draws from the same
// per-UID pool, and draining it leaves the machine without audio until reboot.
// A recursive watch over $HOME did exactly that on 2026-07-30 and 2026-08-04.
const WATCH_BUDGET_SHARE = 0.25;
const CONSERVATIVE_BUDGET = 8192;
const POLL_INTERVAL = 1500; // 1.5s — fallback when inotify is unavailable (WSL2, containers, etc.)
const DEBOUNCE_MS = 300;

export function startWatcher(scanRoot, state, onChange, onFileChanged) {
  const ctx = {
    scanRoot,
    state,
    onChange,
    onFileChanged,
    watched: new Map(),
    budget: readWatchBudget(),
  };

  const dirs = collectWatchDirs(scanRoot, state);

  if (dirs.size > ctx.budget) {
    console.log(
      `[markmedown] ${dirs.size} directories exceed the ${ctx.budget}-watch budget, using polling`
    );
    return startPollingWatcher(scanRoot, state, onChange, onFileChanged);
  }

  for (const dir of dirs) {
    if (watchDir(ctx, dir) === 'exhausted') {
      console.log('[markmedown] inotify quota exhausted, falling back to polling');
      closeAll(ctx);
      return startPollingWatcher(scanRoot, state, onChange, onFileChanged);
    }
  }

  console.log(`[markmedown] watching ${ctx.watched.size} directories for changes`);
  return { close: () => closeAll(ctx) };
}

// Directories holding a known .md file, plus every ancestor up to the scan root.
// Ancestors are cheap and let us notice new subdirectories as they appear.
function collectWatchDirs(scanRoot, state) {
  const dirs = new Set([scanRoot]);

  for (const absPath of state.files.keys()) {
    let dir = path.dirname(absPath);
    while (dir.startsWith(scanRoot) && !dirs.has(dir)) {
      dirs.add(dir);
      if (dir === scanRoot) break;
      dir = path.dirname(dir);
    }
  }

  return dirs;
}

function readWatchBudget() {
  if (process.platform !== 'linux') return Infinity; // no per-user watch limit to respect

  try {
    const limit = parseInt(
      fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim(),
      10
    );
    if (!Number.isFinite(limit)) return CONSERVATIVE_BUDGET;
    return Math.floor(limit * WATCH_BUDGET_SHARE);
  } catch {
    return CONSERVATIVE_BUDGET;
  }
}

// Returns 'ok' (watching), 'skip' (nothing to watch here) or 'exhausted' (quota hit).
function watchDir(ctx, dir) {
  if (ctx.watched.has(dir)) return 'ok'; // idempotent — never two watches on one dir
  if (ctx.watched.size >= ctx.budget) return 'exhausted';

  let watcher;
  try {
    watcher = fs.watch(dir, (eventType, filename) => onDirEvent(ctx, dir, filename));
  } catch (err) {
    if (err.code === 'ENOSPC' || err.code === 'EMFILE') return 'exhausted';
    return 'skip'; // gone (ENOENT) or unreadable (EACCES) — not our problem to solve
  }

  watcher.on('error', () => {
    watcher.close();
    ctx.watched.delete(dir);
  });

  ctx.watched.set(dir, watcher);
  return 'ok';
}

function closeAll(ctx) {
  for (const watcher of ctx.watched.values()) {
    try { watcher.close(); } catch {}
  }
  ctx.watched.clear();
}

function onDirEvent(ctx, dir, filename) {
  if (!filename) return;

  const fullPath = path.join(dir, filename);

  if (filename.endsWith('.md')) {
    handleFileEvent(ctx, fullPath);
    return;
  }

  // Anything else may be a new directory worth following (git clone, moved folder).
  adoptDirectory(ctx, fullPath, filename);
}

async function adoptDirectory(ctx, fullPath, name) {
  if (shouldIgnoreDir(name, ignoreSet)) return;

  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isDirectory()) return;
  } catch {
    return; // vanished or unreadable
  }

  const added = await walkAndWatch(ctx, fullPath);
  if (added) ctx.onChange();
}

// Watch a freshly appeared subtree and index the .md files it brought with it.
async function walkAndWatch(ctx, dir) {
  if (watchDir(ctx, dir) !== 'ok') return false;

  let handle;
  try {
    handle = await fsp.opendir(dir);
  } catch {
    return false;
  }

  const subdirs = [];
  const files = [];

  for await (const entry of handle) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldIgnoreDir(entry.name, ignoreSet)) subdirs.push(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  let changed = false;

  for (const file of files) {
    if (await processFileChange(file, ctx.scanRoot, ctx.state)) {
      changed = true;
      if (ctx.onFileChanged) ctx.onFileChanged(file);
    }
  }

  for (const subdir of subdirs) {
    if (await walkAndWatch(ctx, subdir)) changed = true;
  }

  return changed;
}

// Debounce map to avoid rapid-fire events for the same file
const debounceTimers = new Map();

function handleFileEvent(ctx, fullPath) {
  const relativePath = path.relative(ctx.scanRoot, fullPath);

  // Check if any parent directory should be ignored
  for (const part of relativePath.split(path.sep)) {
    if (shouldIgnoreDir(part, ignoreSet)) return;
  }

  // Skip self-triggered events
  if (recentlyWritten.has(fullPath)) return;

  if (debounceTimers.has(fullPath)) {
    clearTimeout(debounceTimers.get(fullPath));
  }

  debounceTimers.set(fullPath, setTimeout(async () => {
    debounceTimers.delete(fullPath);
    const changed = await processFileChange(fullPath, ctx.scanRoot, ctx.state);
    if (changed) {
      ctx.onChange();
      if (ctx.onFileChanged) ctx.onFileChanged(fullPath);
    }
  }, DEBOUNCE_MS));
}

async function processFileChange(fullPath, scanRoot, state) {
  try {
    const stat = await fsp.stat(fullPath);

    const relativePath = path.relative(scanRoot, fullPath);
    const existing = state.files.get(fullPath);

    if (existing && existing.mtime === stat.mtimeMs) return false;

    state.files.set(fullPath, {
      absolutePath: fullPath,
      relativePath,
      mtime: stat.mtimeMs,
      size: stat.size,
      gitRoot: existing?.gitRoot ?? null,
    });

    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (state.files.has(fullPath)) {
        state.files.delete(fullPath);
        return true;
      }
    }
    return false;
  }
}

function startPollingWatcher(scanRoot, state, onChange, onFileChanged) {
  const interval = setInterval(async () => {
    // Quick check: compare file count and mtimes
    let treeChanged = false;
    const changedFiles = [];

    for (const [absPath, entry] of state.files) {
      try {
        const stat = await fsp.stat(absPath);
        if (stat.mtimeMs !== entry.mtime) {
          entry.mtime = stat.mtimeMs;
          entry.size = stat.size;
          changedFiles.push(absPath);
        }
      } catch {
        // File deleted
        state.files.delete(absPath);
        treeChanged = true;
      }
    }

    if (treeChanged || changedFiles.length) onChange();
    if (onFileChanged) {
      for (const p of changedFiles) onFileChanged(p);
    }
  }, POLL_INTERVAL);

  console.log(`[markmedown] polling for changes every ${POLL_INTERVAL / 1000}s`);
  return { close: () => clearInterval(interval) };
}
