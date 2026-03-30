import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_IGNORE = new Set([
  // Version control
  '.git', '.svn', '.hg',
  // Package managers & dependencies
  'node_modules', 'bower_components', '.npm', '.yarn', '.pnpm-store',
  // Build output
  'dist', 'build', 'out', '_build', '.next', '.nuxt', '.output',
  // Runtime & cache
  '.cache', '.tmp', '.temp',
  // Python
  '__pycache__', '.venv', 'venv', '.tox', '.eggs', '*.egg-info',
  // Ruby
  '.bundle',
  // Rust
  'target',
  // Go
  'vendor',
  // System
  '.Trash', '.local', '.docker', '.kube', 'snap',
  'Library', // macOS
  // Node version managers
  '.nvm', '.fnm',
  // IDE
  '.idea', '.vscode-server',
  // Misc
  '.android', '.gradle', '.m2', '.cargo',
]);

const DEFAULT_IGNORE_FILES = new Set([
  '.DS_Store', 'thumbs.db', 'desktop.ini',
]);

export function loadIgnorePatterns() {
  const patterns = new Set(DEFAULT_IGNORE);

  // Load user's custom ignore file
  const ignoreFile = path.join(os.homedir(), '.markmedownignore');
  try {
    const content = fs.readFileSync(ignoreFile, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        patterns.add(trimmed);
      }
    }
  } catch {
    // No custom ignore file — that's fine
  }

  return patterns;
}

export function shouldIgnoreDir(name, ignoreSet) {
  if (name.startsWith('.') && DEFAULT_IGNORE.has(name)) return true;
  return ignoreSet.has(name);
}

export function shouldIgnoreFile(name) {
  return DEFAULT_IGNORE_FILES.has(name);
}
