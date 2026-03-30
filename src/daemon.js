import { createServer } from './server.js';
import { scan, buildTree } from './scanner.js';
import { loadCache, saveCache } from './cache.js';
import { startWatcher } from './watcher.js';
import os from 'node:os';
import path from 'node:path';

const port = parseInt(process.argv[2] || process.env.MARKMEDOWN_PORT || '44444', 10);
const scanRoot = os.homedir();

const state = {
  files: new Map(),
  tree: null,
  scanComplete: false,
  wsClients: new Set(),
};

async function main() {
  // Load cache for instant first response
  const cached = loadCache();
  if (cached) {
    state.files = cached;
    state.tree = buildTree(state.files);
  }

  // Start HTTP server
  const server = createServer(state, scanRoot);

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`[markmedown] running at http://localhost:${addr.port}`);
    console.log(`[markmedown] scanning ${scanRoot}...`);

    // Signal parent that we're ready
    if (process.send) {
      process.send({ status: 'ready', port: addr.port });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[markmedown] port ${port} is in use, try --port <n>`);
      process.exit(1);
    }
    throw err;
  });

  // Run full scan in background
  const scanStart = Date.now();
  let count = 0;
  for await (const entry of scan(scanRoot)) {
    state.files.set(entry.absolutePath, entry);
    count++;
  }
  state.tree = buildTree(state.files);
  state.scanComplete = true;

  const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
  console.log(`[markmedown] scan complete: ${count} files in ${elapsed}s`);

  // Save cache for next startup
  saveCache(state.files);

  // Notify connected browsers that scan is complete
  broadcastTree(state);

  // Start watching for changes
  startWatcher(scanRoot, state, () => {
    state.tree = buildTree(state.files);
    broadcastTree(state);
    saveCache(state.files);
  });

  // Clean shutdown
  const shutdown = () => {
    console.log('[markmedown] shutting down...');
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function broadcastTree(state) {
  const msg = JSON.stringify({ type: 'tree', data: state.tree });
  for (const ws of state.wsClients) {
    try { ws.send(msg); } catch {}
  }
}

main().catch((err) => {
  console.error('[markmedown] fatal:', err);
  process.exit(1);
});
