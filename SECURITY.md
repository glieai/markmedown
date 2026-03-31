# Security

## Reporting Vulnerabilities

If you find a security vulnerability, please email **security@glie.ai** instead of opening a public issue.

We will respond within 48 hours and work with you on a fix before any public disclosure.

## Security Model

markmedown is a **local-only** tool:

- HTTP server binds to `127.0.0.1` only — no remote access
- All file paths are validated to be under `~/` and end in `.md`
- Path traversal attacks are prevented by resolving absolute paths
- No authentication needed (same trust model as VS Code live server)
- No data leaves your machine — no analytics, no telemetry, no external requests (except Milkdown CDN for the WYSIWYG editor)
