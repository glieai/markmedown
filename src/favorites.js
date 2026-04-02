import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FAVORITES_FILE = path.join(os.homedir(), '.markmedown', 'favorites.json');

let favorites = new Set();

export function loadFavorites() {
  try {
    const raw = fs.readFileSync(FAVORITES_FILE, 'utf8');
    const entries = JSON.parse(raw);
    favorites = new Set(entries);
  } catch {
    favorites = new Set();
  }
  return favorites;
}

function saveFavorites() {
  const dir = path.dirname(FAVORITES_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const tmpFile = FAVORITES_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify([...favorites]));
  fs.renameSync(tmpFile, FAVORITES_FILE);
}

export function getFavorites() {
  return [...favorites];
}

export function addFavorite(filePath) {
  favorites.add(filePath);
  saveFavorites();
}

export function removeFavorite(filePath) {
  favorites.delete(filePath);
  saveFavorites();
}

export function isFavorite(filePath) {
  return favorites.has(filePath);
}

export function toggleFavorite(filePath) {
  if (favorites.has(filePath)) {
    favorites.delete(filePath);
  } else {
    favorites.add(filePath);
  }
  saveFavorites();
  return favorites.has(filePath);
}
