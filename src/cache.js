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

  // Atomic write: write to a tmp file THIS process owns, then rename.
  //
  // The tmp name used to be a fixed `cache.json.tmp`, shared by every instance. Two
  // daemons saving at once meant the second one renamed a file the first had already
  // moved away, and the ENOENT came back through a timer callback as an uncaught
  // exception. That is what killed the :44444 daemon on 2026-08-20 while a second
  // instance kept running on :80.
  const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(entries));
    fs.renameSync(tmpFile, CACHE_FILE);
  } catch (err) {
    // The cache is a cache. Losing one write costs a rescan on the next boot; taking
    // the server down costs the server. Say it out loud rather than swallowing it.
    console.error(`[markmedown] cache save failed (${err.code || err.message}) — continuing`);
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
