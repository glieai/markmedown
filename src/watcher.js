import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { recentlyWritten } from './server.js';
import { loadIgnorePatterns, shouldIgnoreDir } from './ignore.js';

const ignoreSet = loadIgnorePatterns();

export function startWatcher(scanRoot, state, onChange) {
  // Check if recursive watching is viable
  if (process.platform === 'linux') {
    try {
      const maxWatches = parseInt(
        fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim(),
        10
      );
      if (maxWatches < 8192) {
        console.log(`[markmedown] inotify limit low (${maxWatches}), using polling fallback`);
        return startPollingWatcher(scanRoot, state, onChange);
      }
    } catch {
      // Can't read limit — try recursive watch anyway
    }
  }

  try {
    const watcher = fs.watch(scanRoot, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      handleWatchEvent(eventType, filename, scanRoot, state, onChange);
    });

    watcher.on('error', (err) => {
      console.error('[markmedown] watcher error:', err.message);
      console.log('[markmedown] falling back to polling');
      watcher.close();
      startPollingWatcher(scanRoot, state, onChange);
    });

    console.log('[markmedown] watching for changes (recursive)');
    return watcher;
  } catch {
    console.log('[markmedown] recursive watch not available, using polling');
    return startPollingWatcher(scanRoot, state, onChange);
  }
}

// Debounce map to avoid rapid-fire events for the same file
const debounceTimers = new Map();

function handleWatchEvent(eventType, filename, scanRoot, state, onChange) {
  // Only care about .md files
  if (!filename.endsWith('.md')) return;

  const fullPath = path.join(scanRoot, filename);

  // Check if any parent directory should be ignored
  const parts = filename.split(path.sep);
  for (const part of parts) {
    if (shouldIgnoreDir(part, ignoreSet)) return;
  }

  // Skip self-triggered events
  if (recentlyWritten.has(fullPath)) return;

  // Debounce: wait 300ms before processing
  if (debounceTimers.has(fullPath)) {
    clearTimeout(debounceTimers.get(fullPath));
  }

  debounceTimers.set(fullPath, setTimeout(async () => {
    debounceTimers.delete(fullPath);
    await processFileChange(fullPath, scanRoot, state, onChange);
  }, 300));
}

async function processFileChange(fullPath, scanRoot, state, onChange) {
  try {
    const stat = await fsp.stat(fullPath);

    // File exists — update or add
    const relativePath = path.relative(scanRoot, fullPath);
    const existing = state.files.get(fullPath);

    // Skip if mtime hasn't changed
    if (existing && existing.mtime === stat.mtimeMs) return;

    state.files.set(fullPath, {
      absolutePath: fullPath,
      relativePath,
      mtime: stat.mtimeMs,
      size: stat.size,
      gitRoot: existing?.gitRoot ?? null, // preserve git root from scan
    });

    onChange();
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File was deleted
      if (state.files.has(fullPath)) {
        state.files.delete(fullPath);
        onChange();
      }
    }
  }
}

function startPollingWatcher(scanRoot, state, onChange) {
  const POLL_INTERVAL = 30000; // 30 seconds

  const interval = setInterval(async () => {
    // Quick check: compare file count and mtimes
    let changed = false;

    for (const [absPath, entry] of state.files) {
      try {
        const stat = await fsp.stat(absPath);
        if (stat.mtimeMs !== entry.mtime) {
          entry.mtime = stat.mtimeMs;
          entry.size = stat.size;
          changed = true;
        }
      } catch {
        // File deleted
        state.files.delete(absPath);
        changed = true;
      }
    }

    if (changed) {
      onChange();
    }
  }, POLL_INTERVAL);

  console.log(`[markmedown] polling for changes every ${POLL_INTERVAL / 1000}s`);
  return { close: () => clearInterval(interval) };
}
