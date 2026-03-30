import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_FILE = path.join(os.homedir(), '.markmedown', 'cache.json');

export function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    const map = new Map();

    for (const entry of entries) {
      map.set(entry.absolutePath, entry);
    }

    return map;
  } catch {
    return null;
  }
}

export function saveCache(filesMap) {
  const entries = Array.from(filesMap.values());
  const dir = path.dirname(CACHE_FILE);

  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: write to tmp, then rename
  const tmpFile = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(entries));
  fs.renameSync(tmpFile, CACHE_FILE);
}
