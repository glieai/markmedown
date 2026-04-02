import { createServer } from './server.js';
import { scan, buildTree } from './scanner.js';
import { loadCache, saveCache } from './cache.js';
import { startWatcher } from './watcher.js';
import { buildIndex } from './indexer.js';
import { loadFavorites } from './favorites.js';
import os from 'node:os';

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

  // Load favorites
  loadFavorites();

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
  broadcastUpdate(state);

  // Build full-text search index in background
  console.log(`[markmedown] building search index...`);
  await buildIndex(state.files);
  broadcastUpdate(state);

  // Start watching for changes
  startWatcher(scanRoot, state, () => {
    state.tree = buildTree(state.files);
    broadcastUpdate(state);
    saveCache(state.files);
  }, (changedPath) => {
    // Notify browsers that a specific file changed (for auto-refresh)
    const msg = JSON.stringify({ type: 'file-changed', path: changedPath });
    for (const ws of state.wsClients) {
      try { ws.send(msg); } catch {}
    }
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

function broadcastUpdate(state) {
  const msg = JSON.stringify({
    type: 'tree',
    data: state.tree,
    totalFiles: state.files.size,
    scanComplete: state.scanComplete,
  });
  for (const ws of state.wsClients) {
    try { ws.send(msg); } catch {}
  }
}

main().catch((err) => {
  console.error('[markmedown] fatal:', err);
  process.exit(1);
});
