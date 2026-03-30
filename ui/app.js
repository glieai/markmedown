// ================================================
// markmedown — Frontend Application
// ================================================

// --- State ---

const state = {
  currentFile: null,       // { path, content, mtime }
  isRawMode: false,
  isDirty: false,
  editorReady: false,
  milkdownInstance: null,
  vscodeAvailable: false,
  ws: null,
};

// --- DOM References ---

const $ = (sel) => document.querySelector(sel);
const fileTree = $('#file-tree');
const searchInput = $('#search-input');
const emptyState = $('#empty-state');
const fileHeader = $('#file-header');
const toolbar = $('#toolbar');
const editorContainer = $('#editor-container');
const milkdownEl = $('#milkdown-editor');
const rawEditor = $('#raw-editor');
const filePath = $('#file-path');
const fileSize = $('#file-size');
const gitBadge = $('#git-badge');
const gitRepoName = $('#git-repo-name');
const saveIndicator = $('#save-indicator');
const rawToggle = $('#raw-toggle');
const vscodeBtn = $('#vscode-btn');
const newFileBtn = $('#new-file-btn');
const newFileDialog = $('#new-file-dialog');
const newFilePath = $('#new-file-path');
const newFileCancel = $('#new-file-cancel');
const newFileCreate = $('#new-file-create');
const fileCount = $('#file-count');
const scanStatus = $('#scan-status');
const largeFileWarning = $('#large-file-warning');
const largeFileSize = $('#large-file-size');

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
  // Render files first in root, folders first otherwise
  if (depth > 0) {
    // Render subdirectories
    for (const child of node.children) {
      const details = document.createElement('details');
      details.className = 'tree-folder';
      if (depth < 2) details.open = true; // auto-expand first 2 levels

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
  } else {
    // Root level: render children
    for (const child of node.children) {
      const details = document.createElement('details');
      details.className = 'tree-folder';
      details.open = true;

      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="tree-folder-icon">📁</span><span class="tree-folder-name">${escapeHtml(child.name)}</span>`;
      details.appendChild(summary);

      const content = document.createElement('div');
      content.className = 'tree-content';
      details.appendChild(content);

      renderNode(child, content, depth + 1);
      parent.appendChild(details);
    }

    // Root files
    for (const file of node.files) {
      const btn = createFileButton(file);
      parent.appendChild(btn);
    }
  }
}

function createFileButton(file) {
  const btn = document.createElement('button');
  btn.className = 'tree-file';
  btn.dataset.path = file.path;
  btn.title = file.relativePath;

  let html = `<span class="tree-file-icon">📄</span><span class="tree-file-name">${escapeHtml(file.name)}</span>`;
  if (file.gitRoot) {
    html += `<span class="tree-file-git" title="Git: ${escapeHtml(file.gitRoot)}">⬡</span>`;
  }
  btn.innerHTML = html;

  btn.addEventListener('click', () => openFile(file.path, file));
  return btn;
}

function updateActiveFile(filePath) {
  fileTree.querySelectorAll('.tree-file').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.path === filePath);
  });
}

// --- Search / Filter ---

searchInput.addEventListener('input', () => {
  const query = searchInput.value.toLowerCase().trim();
  filterTree(fileTree, query);
});

function filterTree(container, query) {
  if (!query) {
    container.querySelectorAll('.tree-hidden').forEach((el) => el.classList.remove('tree-hidden'));
    return;
  }

  // Process files
  container.querySelectorAll('.tree-file').forEach((btn) => {
    const name = btn.querySelector('.tree-file-name').textContent.toLowerCase();
    const path = (btn.dataset.path || '').toLowerCase();
    const matches = name.includes(query) || path.includes(query);
    btn.classList.toggle('tree-hidden', !matches);
  });

  // Process folders — hide if no visible children
  container.querySelectorAll('.tree-folder').forEach((details) => {
    const content = details.querySelector('.tree-content');
    const hasVisibleChild = content.querySelector('.tree-file:not(.tree-hidden), .tree-folder:not(.tree-hidden)');
    details.classList.toggle('tree-hidden', !hasVisibleChild);
    if (hasVisibleChild && query) details.open = true;
  });
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

    state.currentFile = { path, content: data.content, mtime: data.mtime };
    state.isDirty = false;

    // Update UI
    emptyState.hidden = true;
    fileHeader.hidden = false;
    toolbar.hidden = false;
    editorContainer.hidden = false;
    saveIndicator.hidden = true;

    filePath.textContent = path.replace(/^\/home\/[^/]+\//, '~/');
    fileSize.textContent = formatSize(data.size);

    // Git badge
    if (fileInfo?.gitRoot) {
      gitBadge.hidden = false;
      gitRepoName.textContent = fileInfo.gitRoot.split('/').pop();
    } else {
      gitBadge.hidden = true;
    }

    // Large file handling
    const isLarge = data.size > 512000; // 500KB
    const isVeryLarge = data.size > 2097152; // 2MB
    largeFileWarning.hidden = !isLarge;
    if (isLarge) {
      largeFileSize.textContent = formatSize(data.size);
    }

    if (isVeryLarge) {
      // Force raw mode for very large files
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
// This is the single source of truth for "what does the WYSIWYG editor contain?"
let latestMarkdown = '';

async function loadMilkdownModules() {
  if (milkdownModules) return milkdownModules;

  const [core, commonmarkMod, gfmMod, listenerMod] = await Promise.all([
    import('https://esm.sh/@milkdown/core@7.5.0'),
    import('https://esm.sh/@milkdown/preset-commonmark@7.5.0'),
    import('https://esm.sh/@milkdown/preset-gfm@7.5.0'),
    import('https://esm.sh/@milkdown/plugin-listener@7.5.0'),
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
    try { milkdownEditor.destroy(); } catch {}
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
    await buildEditor('');
    milkdownLoaded = true;
    state.editorReady = true;
    console.log('[markmedown] editor ready');
  } catch (err) {
    console.error('[markmedown] failed to load Milkdown:', err);
    setRawMode(true);
    rawToggle.disabled = true;
    rawToggle.title = 'WYSIWYG editor failed to load';
  }
}

function setEditorContent(markdown) {
  // Always update raw editor as backup
  rawEditor.value = markdown;
  latestMarkdown = markdown;

  if (state.isRawMode || !milkdownLoaded) return;

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
  // latestMarkdown is kept in sync by the listener callback
  return latestMarkdown || rawEditor.value;
}

// --- Raw Mode Toggle ---

function setRawMode(raw) {
  state.isRawMode = raw;
  document.body.classList.toggle('raw-mode', raw);

  if (raw) {
    // Sync latest WYSIWYG content to raw editor
    rawEditor.value = latestMarkdown || state.currentFile?.content || '';
    milkdownEl.hidden = true;
    rawEditor.hidden = false;
    rawEditor.focus();
  } else {
    milkdownEl.hidden = false;
    rawEditor.hidden = true;
    // Rebuild WYSIWYG with current raw content
    if (milkdownLoaded) {
      buildEditor(rawEditor.value).catch(() => {
        // If rebuild fails, stay in raw mode
        setRawMode(true);
      });
    }
  }
}

rawToggle.addEventListener('click', () => setRawMode(!state.isRawMode));

// Raw editor change tracking
rawEditor.addEventListener('input', scheduleAutoSave);

// --- Keyboard Shortcuts ---

document.addEventListener('keydown', (e) => {
  // Ctrl+S / Cmd+S → save
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

  // Ensure .md extension
  if (!path.endsWith('.md')) path += '.md';

  // Ensure absolute path
  if (!path.startsWith('/')) {
    const home = await getHome();
    path = `${home}/${path}`;
  }

  try {
    const data = await api('POST', '/api/file', { path });
    if (data.ok) {
      newFileDialog.close();
      // Refresh tree and open new file
      refreshTree();
      setTimeout(() => openFile(data.path, null), 500);
    } else {
      alert(data.error || 'Failed to create file');
    }
  } catch (err) {
    alert('Failed to create file: ' + err.message);
  }
});

// Cache home dir
let _home = null;
async function getHome() {
  if (!_home) {
    // Derive from current file paths
    const data = await api('GET', '/api/tree');
    const firstFile = findFirstFile(data.tree);
    if (firstFile) {
      // Extract home from absolute path
      const parts = firstFile.path.split('/');
      _home = '/' + parts[1] + '/' + parts[2]; // /home/username
    } else {
      _home = '/home/' + 'user';
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
        if (msg.totalFiles !== undefined) {
          fileCount.textContent = `${msg.totalFiles} files`;
        }
        if (msg.scanComplete) {
          scanStatus.textContent = 'ready';
          scanStatus.className = 'scan-complete';
        }
        // Re-highlight active file
        if (state.currentFile) {
          updateActiveFile(state.currentFile.path);
        }
      }
    } catch (err) {
      console.error('[markmedown] ws message error:', err);
    }
  });

  ws.addEventListener('close', () => {
    console.log('[markmedown] ws disconnected, reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener('error', () => {
    // Will trigger close event
  });

  state.ws = ws;
}

// --- Tree Refresh ---

async function refreshTree() {
  try {
    const data = await api('GET', '/api/tree');
    renderTree(data.tree);
    fileCount.textContent = `${data.totalFiles} files`;
    if (data.scanComplete) {
      scanStatus.textContent = 'ready';
      scanStatus.className = 'scan-complete';
    }
  } catch (err) {
    console.error('[markmedown] failed to refresh tree:', err);
  }
}

// --- Toolbar Commands ---

toolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-command]');
  if (!btn) return;

  const command = btn.dataset.command;

  if (state.isRawMode) {
    executeRawCommand(command);
  } else {
    executeMilkdownCommand(command);
  }
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
    case 'heading1':
      replacement = `# ${selected || 'Heading 1'}`;
      break;
    case 'heading2':
      replacement = `## ${selected || 'Heading 2'}`;
      break;
    case 'heading3':
      replacement = `### ${selected || 'Heading 3'}`;
      break;
    case 'bulletList':
      replacement = `- ${selected || 'Item'}`;
      break;
    case 'orderedList':
      replacement = `1. ${selected || 'Item'}`;
      break;
    case 'taskList':
      replacement = `- [ ] ${selected || 'Task'}`;
      break;
    case 'blockquote':
      replacement = `> ${selected || 'Quote'}`;
      break;
    case 'codeBlock':
      replacement = `\`\`\`\n${selected || 'code'}\n\`\`\``;
      break;
    case 'hr':
      replacement = '\n---\n';
      break;
    case 'insertTable':
      replacement = '\n| Header | Header |\n|--------|--------|\n| Cell   | Cell   |\n';
      break;
    case 'insertLink':
      replacement = `[${selected || 'text'}](url)`;
      break;
    case 'insertImage':
      replacement = `![${selected || 'alt'}](url)`;
      break;
    default:
      return;
  }

  rawEditor.value = text.substring(0, start) + replacement + text.substring(end);
  rawEditor.selectionStart = rawEditor.selectionEnd = start + replacement.length + cursorOffset;
  rawEditor.focus();
  scheduleAutoSave();
}

function executeMilkdownCommand(command) {
  // Milkdown commands would go through the editor's command system
  // For now, this is a placeholder — proper implementation needs
  // access to Milkdown's callCommand API
  console.log('[markmedown] toolbar command:', command);
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
  // Fetch initial tree
  await refreshTree();

  // Check VS Code availability
  checkVscode();

  // Connect WebSocket for live updates
  connectWebSocket();

  // Initialize Milkdown editor
  await initMilkdown();
}

init();
