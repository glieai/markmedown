import fs from 'node:fs/promises';
import path from 'node:path';
import { loadIgnorePatterns, shouldIgnoreDir } from './ignore.js';

const ignoreSet = loadIgnorePatterns();

// Cache git root lookups per directory to avoid repeated walks
const gitRootCache = new Map();

async function findGitRoot(filePath) {
  let dir = path.dirname(filePath);

  while (dir !== path.dirname(dir)) { // stop at filesystem root
    if (gitRootCache.has(dir)) {
      return gitRootCache.get(dir);
    }

    try {
      await fs.access(path.join(dir, '.git'));
      // Found .git — this is the root. Cache it and all intermediate dirs.
      const root = dir;
      let cacheDir = path.dirname(filePath);
      while (cacheDir !== path.dirname(root)) {
        gitRootCache.set(cacheDir, root);
        if (cacheDir === root) break;
        cacheDir = path.dirname(cacheDir);
      }
      return root;
    } catch {
      dir = path.dirname(dir);
    }
  }

  // No git root found
  gitRootCache.set(path.dirname(filePath), null);
  return null;
}

export async function* scan(rootDir) {
  yield* walkDir(rootDir, rootDir);
}

async function* walkDir(dir, rootDir) {
  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch {
    // Permission denied or other error — skip silently
    return;
  }

  const subdirs = [];

  for await (const entry of handle) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (shouldIgnoreDir(entry.name, ignoreSet)) continue;
      subdirs.push(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const stat = await fs.stat(fullPath);
        const gitRoot = await findGitRoot(fullPath);

        yield {
          absolutePath: fullPath,
          relativePath: path.relative(rootDir, fullPath),
          mtime: stat.mtimeMs,
          size: stat.size,
          gitRoot,
        };
      } catch {
        // File may have been deleted between opendir and stat — skip
      }
    }
  }

  // Recurse into subdirectories
  for (const subdir of subdirs) {
    yield* walkDir(subdir, rootDir);
  }
}

export function buildTree(filesMap) {
  // Determine rootDir from any entry
  let rootDir = '';
  for (const [absPath, entry] of filesMap) {
    rootDir = absPath.slice(0, absPath.length - entry.relativePath.length - 1);
    break;
  }

  const root = { name: '~', path: '', absolutePath: rootDir, children: {}, files: [] };

  for (const [absPath, entry] of filesMap) {
    const parts = entry.relativePath.split(path.sep);
    let node = root;

    // Navigate/create directory nodes
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.children[part]) {
        const relPath = parts.slice(0, i + 1).join('/');
        node.children[part] = {
          name: part,
          path: relPath,
          absolutePath: rootDir + '/' + relPath,
          children: {},
          files: [],
        };
      }
      node = node.children[part];
    }

    // Add file to leaf directory
    node.files.push({
      name: parts[parts.length - 1],
      path: absPath,
      relativePath: entry.relativePath,
      mtime: entry.mtime,
      size: entry.size,
      gitRoot: entry.gitRoot,
    });
  }

  return sortTree(root);
}

function sortTree(node) {
  // Sort files alphabetically
  node.files.sort((a, b) => a.name.localeCompare(b.name));

  // Convert children object to sorted array
  const childArray = Object.values(node.children)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(sortTree);

  return {
    name: node.name,
    path: node.path,
    absolutePath: node.absolutePath,
    children: childArray,
    files: node.files,
  };
}
