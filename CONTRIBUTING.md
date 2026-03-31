> **Tipo:** Guide · **Status:** 🟢 Active · **Actualizado:** 2026-03-31
> How to contribute to markmedown — setup, development workflow, and pull request guidelines.

---

# Contributing to markmedown

Thanks for your interest in contributing! markmedown is a simple project and we'd like to keep it that way.

## Setup

```bash
git clone https://github.com/glieai/markmedown.git
cd markmedown
node bin/markmedown.js --help
```

No `npm install` needed — markmedown has zero dependencies.

## Development

```bash
# Run in foreground (not as daemon) for development
node src/daemon.js 44444

# Open http://localhost:44444
```

Edit files in `ui/` — the server serves them directly, no build step. Refresh the browser to see changes.

### Project Structure

```
bin/markmedown.js    CLI entry point, daemon lifecycle
src/
  daemon.js          Main process — scan, index, serve, watch
  scanner.js         Async generator filesystem walker
  indexer.js         In-memory inverted index for full-text search
  server.js          Native node:http server + WebSocket
  watcher.js         fs.watch wrapper with fallback
  cache.js           Scan result caching (~/.markmedown/cache.json)
  ignore.js          Default ignore patterns
ui/
  index.html         Single page shell
  style.css          Linear-inspired dark theme
  app.js             All frontend logic
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Keep changes focused — one feature or fix per PR
3. Test manually: start the daemon, open the browser, verify your change works
4. Write a clear PR description explaining **what** and **why**

## Code Style

- Vanilla JS, no TypeScript, no frameworks
- No build step — files ship as-is
- Prefer native Node.js APIs over npm packages
- Keep `ui/app.js` as a single file (it's the entire frontend)
- CSS custom properties for all colors and spacing

## Reporting Issues

Open an issue at [github.com/glieai/markmedown/issues](https://github.com/glieai/markmedown/issues). Include:

- Node.js version (`node --version`)
- OS (Linux/macOS)
- Steps to reproduce
- Expected vs actual behaviour
