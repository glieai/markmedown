// ================================================
// markmedown — Frontend Application
// ================================================

// --- State ---

const state = {
  currentFile: null,       // { path, content, mtime, fileInfo }
  isRawMode: false,
  isDirty: false,
  editorReady: false,
  vscodeAvailable: false,
  ws: null,
};

// --- DOM References ---

const $ = (sel) => document.querySelector(sel);
const fileTree = $('#file-tree');
const searchInput = $('#search-input');
const searchResults = $('#search-results');
const searchResultsList = $('#search-results-list');
const searchResultsCount = $('#search-results-count');
const searchClear = $('#search-clear');
const emptyState = $('#empty-state');
const fileHeader = $('#file-header');
const toolbar = $('#toolbar');
const editorContainer = $('#editor-container');
const milkdownEl = $('#milkdown-editor');
const rawEditor = $('#raw-editor');
const filePathEl = $('#file-path');
const fileSizeEl = $('#file-size');
const gitBadge = $('#git-badge');
const gitRepoName = $('#git-repo-name');
const saveIndicator = $('#save-indicator');
const rawToggle = $('#raw-toggle');
const vscodeBtn = $('#vscode-btn');
const newFileBtn = $('#new-file-btn');
const newFileDialog = $('#new-file-dialog');
const newFilePath = $('#new-file-path');
const newFileCancel = $('#new-file-cancel');
const fileCountEl = $('#file-count');
const scanStatus = $('#scan-status');
const largeFileWarning = $('#large-file-warning');
const largeFileSizeEl = $('#large-file-size');
const collapseAllBtn = $('#collapse-all');
const expandAllBtn = $('#expand-all');

// --- API ---

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json();
}

// --- File Tree ---

function renderTree(tree) {
  if (!tree) return;
  fileTree.innerHTML = '';
  renderNode(tree, fileTree, 0);
}

function renderNode(node, parent, depth) {
  // Render subdirectories
  for (const child of node.children) {
    const details = document.createElement('details');
    details.className = 'tree-folder';
    // Only expand first level by default
    if (depth === 0) details.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="tree-folder-icon">📁</span><span class="tree-folder-name">${escapeHtml(child.name)}</span>`;
    details.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'tree-content';
    details.appendChild(content);

    renderNode(child, content, depth + 1);
    parent.appendChild(details);
  }

  // Render files
  for (const file of node.files) {
    const btn = createFileButton(file);
    parent.appendChild(btn);
  }
}

function createFileButton(file) {
  const btn = document.createElement('button');
  btn.className = 'tree-file';
  btn.dataset.path = file.path;
  btn.title = file.relativePath;

  let html = `<span class="tree-file-icon">📄</span><span class="tree-file-name">${escapeHtml(file.name)}</span>`;
  if (file.gitRoot) {
    html += `<span class="tree-file-git" title="Git: ${escapeHtml(file.gitRoot)}">git</span>`;
  }
  btn.innerHTML = html;

  btn.addEventListener('click', () => openFile(file.path, file));
  return btn;
}

function updateActiveFile(path) {
  fileTree.querySelectorAll('.tree-file').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.path === path);
  });
}

// --- Tree Controls ---

collapseAllBtn.addEventListener('click', () => {
  fileTree.querySelectorAll('.tree-folder').forEach((d) => d.open = false);
});

expandAllBtn.addEventListener('click', () => {
  fileTree.querySelectorAll('.tree-folder').forEach((d) => d.open = true);
});

// --- Search ---

let searchDebounce = null;

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim();

  clearTimeout(searchDebounce);

  if (!query) {
    hideSearchResults();
    return;
  }

  // Short queries: filter tree locally (file/folder names)
  if (query.length < 3) {
    hideSearchResults();
    filterTreeLocal(query.toLowerCase());
    return;
  }

  // 3+ chars: debounce and call the server search API (full-text)
  searchDebounce = setTimeout(() => runSearch(query), 200);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  hideSearchResults();
  // Unhide all tree items
  fileTree.querySelectorAll('.tree-hidden').forEach((el) => el.classList.remove('tree-hidden'));
});

function hideSearchResults() {
  searchResults.hidden = true;
  fileTree.hidden = false;
}

function filterTreeLocal(query) {
  if (!query) {
    fileTree.querySelectorAll('.tree-hidden').forEach((el) => el.classList.remove('tree-hidden'));
    return;
  }

  // Process files
  fileTree.querySelectorAll('.tree-file').forEach((btn) => {
    const name = btn.querySelector('.tree-file-name').textContent.toLowerCase();
    const path = (btn.dataset.path || '').toLowerCase();
    const matches = name.includes(query) || path.includes(query);
    btn.classList.toggle('tree-hidden', !matches);
  });

  // Process folders — hide if no visible children, also match folder name
  const folders = [...fileTree.querySelectorAll('.tree-folder')].reverse();
  for (const details of folders) {
    const folderName = details.querySelector('.tree-folder-name')?.textContent.toLowerCase() || '';
    const content = details.querySelector('.tree-content');
    const hasVisibleChild = content?.querySelector('.tree-file:not(.tree-hidden), .tree-folder:not(.tree-hidden)');
    const folderMatches = folderName.includes(query);

    if (folderMatches) {
      // Show folder and all its contents
      details.classList.remove('tree-hidden');
      details.open = true;
      details.querySelectorAll('.tree-hidden').forEach((el) => el.classList.remove('tree-hidden'));
    } else if (hasVisibleChild) {
      details.classList.remove('tree-hidden');
      details.open = true;
    } else {
      details.classList.add('tree-hidden');
    }
  }
}

async function runSearch(query) {
  try {
    const data = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
    showSearchResults(data.results, query, data.indexReady);
  } catch (err) {
    console.error('[markmedown] search error:', err);
  }
}

function showSearchResults(results, query, indexReady) {
  fileTree.hidden = true;
  searchResults.hidden = false;

  const indexLabel = indexReady ? '' : ' (indexing...)';
  searchResultsCount.textContent = `${results.length} results${indexLabel}`;

  searchResultsList.innerHTML = '';

  if (results.length === 0) {
    searchResultsList.innerHTML = '<div class="search-no-results">No results found</div>';
    return;
  }

  for (const result of results) {
    const item = document.createElement('button');
    item.className = 'search-result-item';
    item.dataset.path = result.path;

    const snippet = highlightSnippet(result.snippet, query);
    const pathDisplay = result.relativePath.replace(/^/, '~/');

    item.innerHTML = `
      <div class="search-result-name">
        <span class="tree-file-icon">📄</span>
        ${escapeHtml(result.name)}
        ${result.gitRoot ? `<span class="tree-file-git">git</span>` : ''}
      </div>
      <div class="search-result-path">${escapeHtml(pathDisplay)}</div>
      ${snippet ? `<div class="search-result-snippet">${snippet}</div>` : ''}
    `;

    item.addEventListener('click', () => {
      openFile(result.path, result);
      // Clear search after opening
      searchInput.value = '';
      hideSearchResults();
      fileTree.querySelectorAll('.tree-hidden').forEach((el) => el.classList.remove('tree-hidden'));
    });

    searchResultsList.appendChild(item);
  }
}

function highlightSnippet(text, query) {
  if (!text) return '';
  const truncated = text.length > 150 ? text.slice(0, 150) + '...' : text;
  const escaped = escapeHtml(truncated);
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  return escaped.replace(regex, '<mark>$1</mark>');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- File Operations ---

async function openFile(path, fileInfo) {
  // Check for unsaved changes
  if (state.isDirty && state.currentFile) {
    await saveCurrentFile();
  }

  try {
    const data = await api('GET', `/api/file?path=${encodeURIComponent(path)}`);
    if (data.error) {
      console.error('Failed to open file:', data.error);
      return;
    }

    state.currentFile = { path, content: data.content, mtime: data.mtime, fileInfo };
    state.isDirty = false;

    // Update UI — show editor area
    emptyState.hidden = true;
    fileHeader.hidden = false;
    toolbar.hidden = false;
    editorContainer.hidden = false;
    saveIndicator.hidden = true;
    largeFileWarning.hidden = true;

    filePathEl.textContent = path.replace(/^\/home\/[^/]+\//, '~/');
    fileSizeEl.textContent = formatSize(data.size);

    // Git badge
    if (fileInfo?.gitRoot) {
      gitBadge.hidden = false;
      gitRepoName.textContent = fileInfo.gitRoot.split('/').pop();
    } else {
      gitBadge.hidden = true;
    }

    // Large file handling
    const isLarge = data.size > 512000;
    const isVeryLarge = data.size > 2097152;
    if (isLarge) {
      largeFileWarning.hidden = false;
      largeFileSizeEl.textContent = formatSize(data.size);
    }
    if (isVeryLarge) {
      setRawMode(true);
    }

    // Set content in editor
    setEditorContent(data.content);
    updateActiveFile(path);
  } catch (err) {
    console.error('Failed to open file:', err);
  }
}

async function saveCurrentFile() {
  if (!state.currentFile || !state.isDirty) return;

  const content = getEditorContent();
  try {
    const data = await api('PUT', '/api/file', {
      path: state.currentFile.path,
      content,
    });
    if (data.ok) {
      state.currentFile.mtime = data.mtime;
      state.currentFile.content = content;
      state.isDirty = false;
      saveIndicator.hidden = true;
    }
  } catch (err) {
    console.error('Failed to save:', err);
  }
}

// Debounced auto-save
let saveTimer = null;
function scheduleAutoSave() {
  if (!state.currentFile) return; // Don't mark dirty without a file
  state.isDirty = true;
  saveIndicator.hidden = false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentFile, 500);
}

// --- Editor ---

// Milkdown modules — loaded once from CDN, reused across rebuilds
let milkdownModules = null;
let milkdownEditor = null;
let milkdownLoaded = false;

// The listener callback stores the latest markdown here on every change.
let latestMarkdown = '';
let suppressNextChange = false; // Prevent false "unsaved" on file open

const MILKDOWN_VERSION = '7.20.0';

async function loadMilkdownModules() {
  if (milkdownModules) return milkdownModules;

  const [core, commonmarkMod, gfmMod, listenerMod] = await Promise.all([
    import(`https://esm.sh/@milkdown/core@${MILKDOWN_VERSION}`),
    import(`https://esm.sh/@milkdown/preset-commonmark@${MILKDOWN_VERSION}`),
    import(`https://esm.sh/@milkdown/preset-gfm@${MILKDOWN_VERSION}`),
    import(`https://esm.sh/@milkdown/plugin-listener@${MILKDOWN_VERSION}`),
  ]);

  milkdownModules = { core, commonmarkMod, gfmMod, listenerMod };
  return milkdownModules;
}

async function buildEditor(markdown) {
  const { core, commonmarkMod, gfmMod, listenerMod } = await loadMilkdownModules();
  const { Editor, rootCtx, defaultValueCtx } = core;
  const { commonmark } = commonmarkMod;
  const { gfm } = gfmMod;
  const { listener, listenerCtx } = listenerMod;

  // Destroy existing editor
  if (milkdownEditor) {
    try { await milkdownEditor.destroy(); } catch {}
    milkdownEditor = null;
  }
  milkdownEl.innerHTML = '';

  latestMarkdown = markdown;

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, milkdownEl);
      ctx.set(defaultValueCtx, markdown);
      ctx.get(listenerCtx).markdownUpdated((_ctx, md, prevMd) => {
        latestMarkdown = md;
        if (prevMd !== null && md !== prevMd) {
          if (suppressNextChange) {
            suppressNextChange = false;
            return;
          }
          scheduleAutoSave();
        }
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .create();

  milkdownEditor = editor;
  return editor;
}

async function initMilkdown() {
  try {
    await loadMilkdownModules();
    milkdownLoaded = true;
    state.editorReady = true;
    console.log('[markmedown] editor modules loaded');
  } catch (err) {
    console.error('[markmedown] failed to load Milkdown:', err);
    state.isRawMode = true;
    rawToggle.disabled = true;
    rawToggle.title = 'WYSIWYG editor failed to load';
  }
}

function setEditorContent(markdown) {
  // Always update raw editor as backup
  rawEditor.value = markdown;
  latestMarkdown = markdown;

  if (state.isRawMode || !milkdownLoaded) {
    // In raw mode, just show textarea
    milkdownEl.hidden = true;
    rawEditor.hidden = false;
    return;
  }

  milkdownEl.hidden = false;
  rawEditor.hidden = true;

  // Suppress the first markdownUpdated from buildEditor (it's not a user edit)
  suppressNextChange = true;

  // Rebuild WYSIWYG with new content
  buildEditor(markdown).catch((err) => {
    console.error('[markmedown] failed to set editor content:', err);
    setRawMode(true);
  });
}

function getEditorContent() {
  if (state.isRawMode) {
    return rawEditor.value;
  }
  return latestMarkdown || rawEditor.value;
}

// --- Raw Mode Toggle ---

function setRawMode(raw) {
  state.isRawMode = raw;
  document.body.classList.toggle('raw-mode', raw);

  if (raw) {
    rawEditor.value = latestMarkdown || state.currentFile?.content || '';
    milkdownEl.hidden = true;
    rawEditor.hidden = false;
    if (state.currentFile) rawEditor.focus();
  } else {
    milkdownEl.hidden = false;
    rawEditor.hidden = true;
    if (milkdownLoaded && state.currentFile) {
      buildEditor(rawEditor.value).catch(() => setRawMode(true));
    }
  }
}

rawToggle.addEventListener('click', () => {
  if (!state.currentFile) return;
  setRawMode(!state.isRawMode);
});

// Raw editor change tracking
rawEditor.addEventListener('input', scheduleAutoSave);

// --- Keyboard Shortcuts ---

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentFile();
  }
});

// --- VS Code Integration ---

async function checkVscode() {
  try {
    const data = await api('GET', '/api/vscode/check');
    state.vscodeAvailable = data.available;
    vscodeBtn.hidden = !data.available;
  } catch {
    vscodeBtn.hidden = true;
  }
}

vscodeBtn.addEventListener('click', async () => {
  if (!state.currentFile) return;
  await api('POST', '/api/vscode', { path: state.currentFile.path });
});

// --- New File ---

newFileBtn.addEventListener('click', () => {
  newFilePath.value = '';
  newFileDialog.showModal();
  newFilePath.focus();
});

newFileCancel.addEventListener('click', () => newFileDialog.close());

newFileDialog.addEventListener('submit', async (e) => {
  e.preventDefault();
  let path = newFilePath.value.trim();
  if (!path) return;

  if (!path.endsWith('.md')) path += '.md';

  if (!path.startsWith('/')) {
    const home = await getHome();
    path = `${home}/${path}`;
  }

  try {
    const data = await api('POST', '/api/file', { path });
    if (data.ok) {
      newFileDialog.close();
      refreshTree();
      setTimeout(() => openFile(data.path, null), 500);
    } else {
      alert(data.error || 'Failed to create file');
    }
  } catch (err) {
    alert('Failed to create file: ' + err.message);
  }
});

let _home = null;
async function getHome() {
  if (!_home) {
    const data = await api('GET', '/api/tree');
    const firstFile = findFirstFile(data.tree);
    if (firstFile) {
      const parts = firstFile.path.split('/');
      _home = '/' + parts[1] + '/' + parts[2];
    } else {
      _home = '/home/user';
    }
  }
  return _home;
}

function findFirstFile(node) {
  if (!node) return null;
  if (node.files?.length > 0) return node.files[0];
  for (const child of node.children || []) {
    const found = findFirstFile(child);
    if (found) return found;
  }
  return null;
}

// --- WebSocket ---

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'tree') {
        renderTree(msg.data);
        updateStatus(msg.totalFiles, msg.scanComplete);
        if (state.currentFile) {
          updateActiveFile(state.currentFile.path);
        }
      }
    } catch (err) {
      console.error('[markmedown] ws message error:', err);
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener('error', () => {});

  state.ws = ws;
}

function updateStatus(totalFiles, scanComplete) {
  if (totalFiles !== undefined) {
    fileCountEl.textContent = `${totalFiles} files`;
  }
  if (scanComplete) {
    scanStatus.textContent = 'ready';
    scanStatus.className = 'scan-complete';
  }
}

// --- Tree Refresh ---

async function refreshTree() {
  try {
    const data = await api('GET', '/api/tree');
    renderTree(data.tree);
    updateStatus(data.totalFiles, data.scanComplete);
    return data;
  } catch (err) {
    console.error('[markmedown] failed to refresh tree:', err);
    return null;
  }
}

// Poll for status until scan is complete (WebSocket may fail on large frames)
function startStatusPoll() {
  const poll = setInterval(async () => {
    try {
      const data = await api('GET', '/api/tree');
      updateStatus(data.totalFiles, data.scanComplete);
      if (data.scanComplete) {
        clearInterval(poll);
        renderTree(data.tree);
        if (state.currentFile) updateActiveFile(state.currentFile.path);
      }
    } catch {}
  }, 3000);
}

// --- Toolbar Commands ---

toolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-command]');
  if (!btn || !state.currentFile) return;

  const command = btn.dataset.command;

  if (state.isRawMode) {
    executeRawCommand(command);
  }
  // WYSIWYG toolbar commands handled natively by Milkdown
});

function executeRawCommand(command) {
  const start = rawEditor.selectionStart;
  const end = rawEditor.selectionEnd;
  const text = rawEditor.value;
  const selected = text.substring(start, end);
  let replacement = '';
  let cursorOffset = 0;

  switch (command) {
    case 'toggleBold':
      replacement = `**${selected || 'bold'}**`;
      cursorOffset = selected ? 0 : -2;
      break;
    case 'toggleItalic':
      replacement = `*${selected || 'italic'}*`;
      cursorOffset = selected ? 0 : -1;
      break;
    case 'toggleStrikethrough':
      replacement = `~~${selected || 'text'}~~`;
      cursorOffset = selected ? 0 : -2;
      break;
    case 'toggleInlineCode':
      replacement = `\`${selected || 'code'}\``;
      cursorOffset = selected ? 0 : -1;
      break;
    case 'heading1': replacement = `# ${selected || 'Heading 1'}`; break;
    case 'heading2': replacement = `## ${selected || 'Heading 2'}`; break;
    case 'heading3': replacement = `### ${selected || 'Heading 3'}`; break;
    case 'bulletList': replacement = `- ${selected || 'Item'}`; break;
    case 'orderedList': replacement = `1. ${selected || 'Item'}`; break;
    case 'taskList': replacement = `- [ ] ${selected || 'Task'}`; break;
    case 'blockquote': replacement = `> ${selected || 'Quote'}`; break;
    case 'codeBlock': replacement = `\`\`\`\n${selected || 'code'}\n\`\`\``; break;
    case 'hr': replacement = '\n---\n'; break;
    case 'insertTable': replacement = '\n| Header | Header |\n|--------|--------|\n| Cell   | Cell   |\n'; break;
    case 'insertLink': replacement = `[${selected || 'text'}](url)`; break;
    case 'insertImage': replacement = `![${selected || 'alt'}](url)`; break;
    default: return;
  }

  rawEditor.value = text.substring(0, start) + replacement + text.substring(end);
  rawEditor.selectionStart = rawEditor.selectionEnd = start + replacement.length + cursorOffset;
  rawEditor.focus();
  scheduleAutoSave();
}

// --- Utilities ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// --- Init ---

async function init() {
  const data = await refreshTree();
  checkVscode();
  connectWebSocket();
  await initMilkdown();

  // Poll until scan is complete (WebSocket may not deliver large frames)
  if (!data?.scanComplete) {
    startStatusPoll();
  }
}

init();
