# markmedown

Browse and edit **all** your markdown files in a single, beautiful browser UI.

One command. Zero config. Scans your entire home directory, finds every `.md` file, and presents them in a clean dark interface with WYSIWYG editing.

## Why

Markdown files are everywhere — project docs, notes, specs, agent instructions, knowledge bases. But there's no simple way to browse them all in one place. Existing tools are either proprietary (Obsidian), tied to a single folder, read-only, or abandoned.

markmedown fills the gap.

## Features

- **Filesystem-wide scan** — finds every `.md` file in `~/`, skipping noise (`node_modules`, `.git`, `.cache`)
- **WYSIWYG editor** — Notion-like rich text editing powered by [Milkdown](https://milkdown.dev)
- **Raw mode toggle** — switch to raw markdown with one click
- **Full-text search** — search file names, folder paths, and file content
- **Git awareness** — shows which files live in git repos
- **Auto-refresh** — files updated externally (e.g., by your editor or AI) reload automatically
- **Daemon mode** — runs in background, near-zero resource usage when idle
- **VS Code integration** — open any file directly in VS Code
- **Zero dependencies** — no React, no build step, no bundler. One optional dep (`ws` for WebSocket, or hand-rolled)

## Install

```bash
npm install -g markmedown
```

Or run directly:

```bash
npx markmedown
```

Or clone and link:

```bash
git clone https://github.com/glieai/markmedown.git
cd markmedown
npm link
```

Requires Node.js 18+.

## Usage

```bash
markmedown              # Start daemon + open browser
markmedown start        # Start daemon in background
markmedown stop         # Stop the daemon
markmedown status       # Show if running, port, file count
markmedown install      # Auto-start on boot (systemd/launchd)
markmedown uninstall    # Remove auto-start
markmedown --port 9999  # Custom port (default: 44444)
```

First run scans `~/` and builds a search index. Subsequent starts are instant (cached).

## Architecture

```
Node.js process (single, ~30MB idle)
├── Scanner — async generator, walks ~/ with smart ignore rules
├── Indexer — in-memory inverted index for full-text search
├── Watcher — fs.watch for live file change detection
├── Cache — ~/.markmedown/cache.json for instant restarts
└── HTTP Server — native node:http on localhost:44444
    ├── Static files (vanilla HTML/CSS/JS)
    ├── REST API (tree, file CRUD, search, VS Code)
    └── WebSocket (live tree updates, file change notifications)
```

**Frontend**: Vanilla HTML/CSS/JS. No framework, no build step. [Milkdown](https://milkdown.dev) loaded from CDN for WYSIWYG editing.

**Theme**: Linear-inspired dark palette.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Save current file |
| `Ctrl+B` / `Cmd+B` | Toggle bold |
| `Ctrl+I` / `Cmd+I` | Toggle italic |

## Configuration

markmedown works with zero config. Optional customization:

**Custom ignore patterns** — create `~/.markmedownignore`:

```
my-large-folder
another-folder-to-skip
```

**Custom port** — pass `--port <n>` or set `MARKMEDOWN_PORT` env var.

## Roadmap

- [ ] Dashboard with file stats and insights
- [ ] Full git integration (history, diff, blame per file)
- [ ] Claude CLI integration (select text → ask AI)
- [ ] Tags and backlinks (`#tags`, `[[wiki-links]]`)
- [ ] Favourites / pinned files

## License

MIT — see [LICENSE](LICENSE).
