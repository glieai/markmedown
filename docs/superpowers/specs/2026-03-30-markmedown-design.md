# markmedown — Design Spec

## Context

Markdown files are everywhere — project docs, personal notes, agent instructions, knowledge bases — but there's no single tool that lets you browse ALL of them across your filesystem in a clean browser UI. Existing tools are either proprietary (Obsidian), tied to a single folder, read-only, or abandoned. markmedown fills this gap: a zero-config CLI tool that scans your home directory for every `.md` file and presents them in an Obsidian-inspired dark browser UI with Notion-like WYSIWYG editing.

## What It Does

```bash
$ markmedown                    # smart: if daemon not running → start + open browser
                                #        if daemon running → just open browser

$ markmedown start              # start daemon in background (no browser)
$ markmedown stop               # stop the daemon
$ markmedown status             # show if running, port, indexed file count
$ markmedown --port 4000        # custom port
$ markmedown install            # auto-start on boot (systemd/launchd)
$ markmedown uninstall          # remove auto-start
```

Zero config. First run scans `~/` for all `.md` files (skipping noise like `node_modules`, `.git`, `.cache`), starts a daemon, opens the browser. From then on, it's always running — just type `markmedown` to open the browser.

### Daemon Lifecycle

1. `markmedown` (or `markmedown start`) → forks a background Node.js process
2. Parent exits immediately — terminal is free
3. Daemon stores PID in `~/.markmedown/pid`, port in `~/.markmedown/port`
4. Logs written to `~/.markmedown/markmedown.log`
5. `markmedown stop` → reads PID, sends `SIGTERM`, cleans up pid/port files
6. `markmedown` when already running → reads port file, opens browser, exits
7. `markmedown status` → reads pid/port, checks if process alive, prints stats

### Auto-start on Boot (optional)

`markmedown install` generates and installs:
- **Linux**: a `~/.config/systemd/user/markmedown.service` unit (user-level, no root needed)
- **macOS**: a `~/Library/LaunchAgents/com.markmedown.plist`

`markmedown uninstall` removes the service file. The generated file is human-readable and editable.

### Resource Usage (daemon idle)

- **CPU**: ~0%. Node.js event loop sleeps. Only wakes on `fs.watch` events or HTTP requests.
- **RAM**: ~30-50MB (Node.js base + in-memory Map). ~1MB per 10,000 indexed files.
- **Disk**: `~/.markmedown/cache.json` (small) + log file.
- **Network**: `127.0.0.1` only, no external connections.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Node.js Process (single)                    │
│                                              │
│  Scanner ──→ In-memory Map ──→ HTTP Server   │
│  (async        of .md files     :44444        │
│   generator)                                 │
│                                              │
│  Watcher ──→ diffs pushed via WebSocket      │
│  (fs.watch)                                  │
└──────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────┐
│  Browser (dark, Obsidian-inspired)           │
│  ┌───────────┐ ┌───────────────────────────┐ │
│  │ File Tree  │ │ Milkdown WYSIWYG Editor   │ │
│  │ + Search   │ │ + Raw MD toggle           │ │
│  │ (sidebar)  │ │ + Toolbar + Auto-save     │ │
│  └───────────┘ └───────────────────────────┘ │
└──────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 18+ (native) | Already on every dev machine |
| Server | `node:http` | Zero framework dependencies |
| WebSocket | `ws` package OR hand-rolled | Only runtime dependency (47KB, zero deps) |
| Frontend | Vanilla HTML/CSS/JS | No React, no build step, no bundler |
| WYSIWYG | Milkdown v7 (ESM) | Markdown-first, ProseMirror + remark, CDN-loadable |
| Raw editor | Plain `<textarea>` | Zero-dep fallback, monospace font |
| Install | `npm install -g markmedown` | Single command |

**Total runtime dependencies: 1** (the `ws` package, or 0 if hand-rolled).

## Components

### 1. CLI Entry (`bin/markmedown.js`)

Parses `process.argv` for subcommands and flags (no arg-parsing library).

**Commands:**
- `markmedown` (no args) → if daemon running (check `~/.markmedown/pid`), open browser and exit. Otherwise, start daemon + open browser.
- `markmedown start` → fork daemon process, write PID/port to `~/.markmedown/`, exit parent.
- `markmedown stop` → read PID from `~/.markmedown/pid`, send `SIGTERM`, clean up.
- `markmedown status` → check if PID is alive, read port, print stats (files indexed, uptime).
- `markmedown install` → generate and install systemd service (Linux) or launchd plist (macOS).
- `markmedown uninstall` → remove the service file.

**Flags:** `--port <n>` (custom port, default 44444).

**Daemon fork:**
- Uses `child_process.fork` with `detached: true` and `stdio: 'ignore'`
- Parent `unref()`s the child and exits
- Child writes its PID and port to `~/.markmedown/pid` and `~/.markmedown/port`
- Child redirects stdout/stderr to `~/.markmedown/markmedown.log`
- Child handles SIGTERM for clean shutdown (close server, stop watcher)

### 2. Scanner (`src/scanner.js`)

Async generator that walks `~/` recursively using `fs.opendir`.

**Ignore rules** (hardcoded defaults, extendable via `~/.markmedownignore`):
```
node_modules, .git, .svn, .hg, .cache, .npm, .nvm, .local,
.Trash, Library, vendor, dist, build, __pycache__, .venv,
.env, .DS_Store, thumbs.db, .docker, .kube, snap
```

**Behavior:**
- Skips ignored directories at `opendir` level (never descends)
- Yields `{ absolutePath, relativePath, mtime, size, gitRoot }` for each `.md` file
- `gitRoot`: detected by walking up from the file looking for a `.git/` directory (cached per parent dir to avoid repeated lookups)
- Stores results in an in-memory `Map<absolutePath, FileEntry>`
- Builds a nested tree structure from the flat map for the sidebar

**Performance:**
- Async generator = server starts before scan completes
- Typical ~/ scan with ignore rules: 1-3 seconds
- Cache at `~/.markmedown/cache.json` for instant second launch (<100ms)

### 3. Watcher (`src/watcher.js`)

- `fs.watch(homedir, { recursive: true })` on macOS/Linux (Node 19+)
- Filters events: only `.md` file create/modify/delete
- Updates in-memory Map and pushes diffs via WebSocket
- Ignores self-triggered events from saves (tracked via "recently written" set)
- **Linux fallback**: if inotify watch limit is near capacity, falls back to periodic re-scan (every 30s)

### 4. Cache (`src/cache.js`)

- On first scan: writes `~/.markmedown/cache.json` with `{ path, mtime, size }` per file
- On subsequent starts: loads cache, serves immediately, runs background re-scan
- Compares mtimes to detect changes between cached and actual state

### 5. HTTP Server (`src/server.js`)

Binds to `127.0.0.1` only. Routes via simple string matching (no router library).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Serve `index.html` |
| `GET` | `/assets/*` | Serve static CSS/JS files |
| `GET` | `/api/tree` | File tree as JSON |
| `GET` | `/api/file?path=...` | Raw markdown content of a file |
| `PUT` | `/api/file` | Save markdown content (atomic: write `.tmp` → `rename`) |
| `POST` | `/api/file` | Create new `.md` file |
| `POST` | `/api/vscode` | Open file in VS Code (`child_process.exec('code <path>')`) |
| `WS` | `/ws` | WebSocket for live tree updates |

**Security:**
- All file paths validated: must resolve under `~/` and end in `.md`
- Path traversal prevented by resolving absolute path and checking prefix
- `127.0.0.1` binding only — no remote access
- No auth needed (same trust model as VS Code live server, Jupyter)

### 6. Frontend (`ui/`)

Three files, no build step:

#### `index.html`
- Single page shell with sidebar + editor containers
- ESM imports for Milkdown from CDN (`esm.sh`)
- Meta viewport for potential mobile/tablet use

#### `style.css`
Dark theme via CSS custom properties:
```css
:root {
  --bg-primary: #1e1e2e;      /* main background */
  --bg-secondary: #181825;     /* sidebar */
  --bg-hover: #313244;         /* hover states */
  --text-primary: #cdd6f4;     /* main text */
  --text-secondary: #a6adc8;   /* muted text */
  --accent: #89b4fa;           /* links, active states */
  --border: #45475a;           /* borders */
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}
```
- Obsidian-inspired layout: fixed sidebar, scrollable content area
- Responsive: sidebar collapses on narrow viewports
- Smooth transitions for expand/collapse

#### `app.js`
All frontend logic (~500-700 lines):

**File tree:**
- Fetches `/api/tree` on load
- Renders as nested `<details>/<summary>` (native HTML collapsible)
- Each `.md` file is a clickable `<button>`
- Search input filters tree via CSS `display:none`
- WebSocket listener updates tree on filesystem changes
- Shows file count and scan progress

**Editor:**
- Milkdown WYSIWYG initialized in right pane
- **Raw mode toggle**: small button in toolbar switches between WYSIWYG and `<textarea>` with monospace font showing raw markdown
- On file click: `GET /api/file`, set editor content
- Auto-save: debounced 500ms `PUT` on content change
- Manual save: Ctrl+S / Cmd+S intercepted
- "Open in VS Code" button in toolbar (hidden if `code` CLI not detected)
- Unsaved changes indicator (dot on tab/title)

**Editor toolbar:**
- Bold, Italic, Strikethrough
- H1, H2, H3
- Bullet list, Numbered list, Checkbox list
- Code inline, Code block
- Link, Image
- Blockquote, Horizontal rule
- Table
- Raw/WYSIWYG toggle
- Open in VS Code

### 7. File Operations

**Save flow:**
1. Frontend calls `milkdown.getMarkdown()` (or reads `<textarea>` in raw mode)
2. `PUT /api/file` with `{ path, content }`
3. Backend validates path
4. Writes to `<path>.tmp`, then `fs.rename` to `<path>` (atomic)
5. Adds path to "recently written" set (watcher ignores self-triggered events)
6. Responds `{ ok: true, mtime }`

**Create flow:**
1. User clicks "New File" in sidebar, enters path
2. `POST /api/file` with `{ path, content: '' }`
3. Backend validates path is under `~/` and ends in `.md`
4. Creates parent directories if needed (`fs.mkdir recursive`)
5. Writes empty file
6. Scanner picks it up, tree updates via WebSocket

**Open in VS Code:**
1. `POST /api/vscode` with `{ path }`
2. Backend runs `child_process.exec('code "<path>"')`
3. Checks for `code` availability at startup, frontend hides button if absent

## Project Structure

```
markmedown/
  package.json              # name, version, bin field, minimal deps
  bin/
    markmedown.js           # CLI entry point (#!/usr/bin/env node)
  src/
    server.js               # HTTP server + WebSocket + route handler
    scanner.js              # Async generator filesystem walker
    watcher.js              # fs.watch wrapper with Linux fallback
    cache.js                # ~/.markmedown/cache.json management
    ignore.js               # Default ignore patterns + .markmedownignore
  ui/
    index.html              # Single page shell
    style.css               # Dark theme
    app.js                  # All frontend logic
```

## Edge Cases & Mitigations

| Case | Mitigation |
|------|-----------|
| Large files (>500KB) | Warning shown. Files >2MB default to raw editor mode |
| Milkdown parse failure | Fall back to raw editor with error notice |
| Symlink loops | Track visited inodes, skip duplicates |
| Permission denied | Skip file/dir silently, log to console |
| Port in use | Try next port (3378, 3379...) up to 10 attempts |
| No `code` CLI | Hide "Open in VS Code" button |
| Linux inotify limit | Detect at startup, fall back to polling if near limit |
| File deleted while open | WebSocket notifies frontend, show "file deleted" message |
| Concurrent external edit | Watcher detects change, prompt user to reload |

## v1 Foundation: Git Awareness

The scanner detects whether each `.md` file lives inside a git repository and stores that context.

**During scan:**
- For each `.md` file found, check if it's inside a git repo (walk up looking for `.git/` directory)
- Cache the git root path per file in the Map: `{ ...fileEntry, gitRoot: '/path/to/repo' | null }`
- Group this in the tree UI — files inside git repos get a subtle git icon indicator

**v1 scope (foundation only):**
- Detect and store `gitRoot` for each file during scan
- Show a git badge/icon next to files that are in a git repo
- Show the repo name (folder name of git root) in the file info area
- In the file tree, optionally group/indicate which files belong to the same repo

**Why this matters for v2:** The git root detection is the expensive part. Once we know a file's git root, all future git operations (log, blame, diff, status) are cheap `child_process.exec` calls scoped to that repo.

## v2 — Coming Soon (Design hooks, not implementation)

These features are NOT built in v1 but the architecture supports them:

- **Git integration (full)**: For files in git repos, show last commit info (author, date, message), file history (`git log --follow`), diff view for uncommitted changes, git status badge (modified/staged/untracked). API: `GET /api/git/info?path=...` runs `git log -1` scoped to the file's `gitRoot`. `GET /api/git/history?path=...` returns commit history. `GET /api/git/diff?path=...` shows uncommitted changes.
- **Dashboard**: `/api/stats` endpoint using cached mtime/size data. Total files, recently modified, largest files, folder distribution. Git stats: repos with most docs, recently committed docs.
- **Claude CLI integration**: Select text in editor → context menu "Ask Claude" → spawns `claude` child process with selected text → streams response back via WebSocket → inserts below selection.
- **Slash commands**: Milkdown plugin for `/claude` in-editor trigger.
- **Tags/backlinks**: Parse `#tags` and `[[wiki-links]]` from file content during scan.
- **Favorites/pinned files**: Stored in `~/.markmedown/favorites.json`.

## Verification Plan

1. **Install**: `npm install -g .` from project root → `markmedown` command available
2. **Scan**: Run `markmedown`, verify console shows scan progress and file count
3. **Browser**: Verify browser opens automatically to `http://localhost:44444`
4. **File tree**: Verify sidebar shows folders and `.md` files from `~/`
5. **Search**: Type in search box, verify tree filters correctly
6. **View**: Click a file, verify markdown renders in WYSIWYG mode
7. **Raw toggle**: Click raw toggle, verify raw markdown shown in textarea
8. **Edit + save**: Edit content, wait 500ms, verify file saved on disk (`cat` the file)
9. **Create**: Click "New File", create file, verify it appears in tree and on disk
10. **VS Code**: Click "Open in VS Code", verify file opens in VS Code
11. **External change**: Edit a file externally, verify tree/editor updates via WebSocket
12. **Large file**: Open a file >500KB, verify warning shown
13. **Ignore rules**: Verify `node_modules` and `.git` dirs are not scanned
