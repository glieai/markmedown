import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { search as searchIndex, isIndexReady, getIndexedCount } from './indexer.js';
import { getFavorites, toggleFavorite, isFavorite } from './favorites.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', 'ui');
const HOME = os.homedir();

// Recently written files — watcher should ignore these
export const recentlyWritten = new Set();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// --- Path Security ---

function validateMdPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(HOME)) return null;
  if (!resolved.endsWith('.md')) return null;

  return resolved;
}

// --- Static File Serving ---

function serveStatic(req, res) {
  let filePath;

  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(UI_DIR, 'index.html');
  } else {
    // Prevent path traversal
    const safePath = path.normalize(req.url).replace(/^(\.\.[/\\])+/, '');
    filePath = path.join(UI_DIR, safePath);
  }

  // Ensure we stay within UI_DIR
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// --- API Handlers ---

function handleGetTree(state, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    tree: state.tree,
    totalFiles: state.files.size,
    scanComplete: state.scanComplete,
    indexReady: isIndexReady(),
    indexedFiles: getIndexedCount(),
  }));
}

function handleSearch(req, state, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = url.searchParams.get('q') || '';

  if (!query.trim()) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [], indexReady: isIndexReady() }));
    return;
  }

  const results = searchIndex(query, state.files);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ results, indexReady: isIndexReady() }));
}

async function handleGetFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = validateMdPath(url.searchParams.get('path'));

  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  try {
    const content = await fsp.readFile(filePath, 'utf8');
    const stat = await fsp.stat(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
    }));
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleSaveFile(req, res) {
  const body = await readBody(req);
  if (!body) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid body' }));
    return;
  }

  const filePath = validateMdPath(body.path);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  try {
    // Atomic write
    const tmpFile = filePath + '.markmedown.tmp';
    await fsp.writeFile(tmpFile, body.content, 'utf8');
    await fsp.rename(tmpFile, filePath);

    // Track to ignore watcher event
    recentlyWritten.add(filePath);
    setTimeout(() => recentlyWritten.delete(filePath), 2000);

    const stat = await fsp.stat(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mtime: stat.mtimeMs }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleCreateFile(req, res) {
  const body = await readBody(req);
  if (!body) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid body' }));
    return;
  }

  const filePath = validateMdPath(body.path);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path — must be under ~/ and end in .md' }));
    return;
  }

  try {
    // Check if file already exists
    try {
      await fsp.access(filePath);
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File already exists' }));
      return;
    } catch {
      // File doesn't exist — good
    }

    // Create parent directories
    await fsp.mkdir(path.dirname(filePath), { recursive: true });

    // Write file
    const content = body.content || `# ${path.basename(filePath, '.md')}\n`;
    await fsp.writeFile(filePath, content, 'utf8');

    recentlyWritten.add(filePath);
    setTimeout(() => recentlyWritten.delete(filePath), 2000);

    const stat = await fsp.stat(filePath);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: filePath, mtime: stat.mtimeMs }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleOpenVscode(req, res) {
  const body = await readBody(req);
  if (!body) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid body' }));
    return;
  }

  const filePath = validateMdPath(body.path);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  execFile('code', [filePath], (err) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not open VS Code. Is "code" in your PATH?' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
}

function handleVscodeCheck(res) {
  execFile('which', ['code'], (err) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: !err }));
  });
}

// --- Favorites ---

function handleGetFavorites(state, res) {
  const paths = getFavorites();
  // Enrich with file info from state
  const items = paths.map((p) => {
    const fileEntry = state.files.get(p);
    if (fileEntry) {
      return { path: p, name: fileEntry.relativePath.split('/').pop(), relativePath: fileEntry.relativePath, gitRoot: fileEntry.gitRoot, type: 'file' };
    }
    // Could be a folder path — collect files under it
    const folderFiles = [];
    for (const [k, entry] of state.files) {
      if (k.startsWith(p + '/')) {
        folderFiles.push({
          path: k,
          name: entry.relativePath.split('/').pop(),
          relativePath: entry.relativePath,
          // sub-path relative to the favorite folder
          subPath: k.slice(p.length + 1),
          gitRoot: entry.gitRoot,
        });
      }
    }
    if (folderFiles.length > 0) {
      folderFiles.sort((a, b) => a.subPath.localeCompare(b.subPath));
      return { path: p, name: p.split('/').pop(), relativePath: p.replace(HOME + '/', ''), type: 'folder', files: folderFiles };
    }
    // Orphan favorite (file removed) — still return it
    return { path: p, name: p.split('/').pop(), relativePath: p.replace(HOME + '/', ''), type: 'unknown' };
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ favorites: items }));
}

async function handleToggleFavorite(req, res) {
  const body = await readBody(req);
  if (!body || !body.path) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid body' }));
    return;
  }

  const nowFavorite = toggleFavorite(body.path);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, favorite: nowFavorite }));
}

// --- WebSocket (minimal implementation) ---

function handleUpgrade(req, socket, head, state) {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC085B41')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  const ws = createWsWrapper(socket);
  state.wsClients.add(ws);

  // Send current tree immediately
  ws.send(JSON.stringify({
    type: 'tree',
    data: state.tree,
    totalFiles: state.files.size,
    scanComplete: state.scanComplete,
  }));

  socket.on('close', () => state.wsClients.delete(ws));
  socket.on('error', () => state.wsClients.delete(ws));
}

function createWsWrapper(socket) {
  return {
    send(data) {
      const payload = Buffer.from(data);
      let header;

      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text frame
        header[1] = payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }

      socket.write(Buffer.concat([header, payload]));
    },
    close() {
      socket.end();
    },
  };
}

// --- Helpers ---

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// --- Server Factory ---

export function createServer(state, scanRoot) {
  const server = http.createServer(async (req, res) => {
    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // API routes
      if (pathname === '/api/tree' && req.method === 'GET') {
        handleGetTree(state, res);
      } else if (pathname === '/api/search' && req.method === 'GET') {
        handleSearch(req, state, res);
      } else if (pathname === '/api/file' && req.method === 'GET') {
        await handleGetFile(req, res);
      } else if (pathname === '/api/file' && req.method === 'PUT') {
        await handleSaveFile(req, res);
      } else if (pathname === '/api/file' && req.method === 'POST') {
        await handleCreateFile(req, res);
      } else if (pathname === '/api/vscode' && req.method === 'POST') {
        await handleOpenVscode(req, res);
      } else if (pathname === '/api/vscode/check' && req.method === 'GET') {
        handleVscodeCheck(res);
      } else if (pathname === '/api/favorites' && req.method === 'GET') {
        handleGetFavorites(state, res);
      } else if (pathname === '/api/favorites' && req.method === 'POST') {
        await handleToggleFavorite(req, res);
      } else {
        // Static files
        serveStatic(req, res);
      }
    } catch (err) {
      console.error('[markmedown] request error:', err);
      res.writeHead(500);
      res.end('Internal server error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, state);
  });

  return server;
}
