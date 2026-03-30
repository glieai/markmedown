import fsp from 'node:fs/promises';

// In-memory inverted index: token → Set<absolutePath>
// Plus a snippet cache: absolutePath → first 200 chars of content

const index = new Map();
const snippets = new Map();
let indexReady = false;
let indexedCount = 0;

export function isIndexReady() { return indexReady; }
export function getIndexedCount() { return indexedCount; }

export async function buildIndex(filesMap) {
  const startTime = Date.now();
  indexedCount = 0;

  for (const [absPath, entry] of filesMap) {
    try {
      const content = await fsp.readFile(absPath, 'utf8');
      indexFile(absPath, content);
      indexedCount++;
    } catch {
      // Permission denied, file deleted, etc. — skip
    }
  }

  indexReady = true;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[markmedown] index built: ${indexedCount} files in ${elapsed}s`);
}

function indexFile(absPath, content) {
  // Store snippet (first 200 chars, stripped of markdown syntax)
  const clean = content
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`~\[\]()]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  snippets.set(absPath, clean.slice(0, 200));

  // Tokenize and index
  const tokens = tokenize(content);
  for (const token of tokens) {
    if (token.length < 2) continue; // skip single chars
    let set = index.get(token);
    if (!set) {
      set = new Set();
      index.set(token, set);
    }
    set.add(absPath);
  }
}

export function updateFileIndex(absPath, content) {
  // Remove old entries for this file
  removeFileFromIndex(absPath);
  // Re-index
  indexFile(absPath, content);
}

export function removeFileFromIndex(absPath) {
  snippets.delete(absPath);
  for (const [token, set] of index) {
    set.delete(absPath);
    if (set.size === 0) index.delete(token);
  }
}

function tokenize(text) {
  // Lowercase, split on non-alphanumeric (keeping accented chars)
  return text
    .toLowerCase()
    .split(/[^a-záàâãéèêíìóòôõúùûçñüöäëïÿ0-9_-]+/)
    .filter(t => t.length >= 2);
}

export function search(query, filesMap, maxResults = 50) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Score each file: count how many query tokens match
  const scores = new Map();

  for (const token of queryTokens) {
    // Prefix matching: find all index keys that start with this token
    for (const [indexedToken, filePaths] of index) {
      if (indexedToken.startsWith(token) || indexedToken.includes(token)) {
        const weight = indexedToken === token ? 2 : 1; // exact match scores higher
        for (const fp of filePaths) {
          scores.set(fp, (scores.get(fp) || 0) + weight);
        }
      }
    }
  }

  // Also match file names and folder paths (always, even before index is ready)
  const queryLower = query.toLowerCase();
  for (const [absPath, entry] of filesMap) {
    const pathLower = entry.relativePath.toLowerCase();
    const nameLower = pathLower.split('/').pop();

    if (nameLower.includes(queryLower)) {
      // File name match — highest priority
      scores.set(absPath, (scores.get(absPath) || 0) + 10);
    } else if (pathLower.includes(queryLower)) {
      // Folder path match — high priority
      scores.set(absPath, (scores.get(absPath) || 0) + 5);
    }
  }

  // Sort by score descending, return top N
  const results = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([absPath, score]) => {
      const entry = filesMap.get(absPath);
      return {
        path: absPath,
        relativePath: entry?.relativePath || absPath,
        name: (entry?.relativePath || absPath).split('/').pop(),
        score,
        snippet: snippets.get(absPath) || '',
        gitRoot: entry?.gitRoot || null,
      };
    });

  return results;
}
