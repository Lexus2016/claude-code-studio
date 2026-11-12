# Contributing to Claude Code Studio

## Before opening a report

Search [existing issues](https://github.com/Lexus2016/claude-code-studio/issues). Include the Studio version, operating system, Node.js version, install method (desktop, web, or Docker), and a minimal reproduction. For terminal integrations, include whether tmux is installed. Remove credentials and private project content from logs and screenshots.

## Local development

```bash
git clone https://github.com/Lexus2016/claude-code-studio.git
cd claude-code-studio
npm ci
npm run dev
```

The package supports Node.js 18+, while CI tests Node.js 20 and 24. Node.js 22.13+ can use built-in SQLite; older versions may need native build tools for the optional `better-sqlite3` dependency. Claude Code CLI must be installed and authenticated to exercise chat execution. Installing dependencies also runs the repository's `scripts/install-hooks.js` postinstall script.

Studio runs commands and changes files through Claude Code. Use a disposable project for manual testing. Keep the server on localhost and do not use production credentials or private data in reproduction fixtures.

## Verification

```bash
npm test
```

Install tmux to exercise terminal-related coverage; some tests skip when it is unavailable. Match the [CI workflow](.github/workflows/ci.yml) when checking a change, and report skipped or failed checks rather than calling them passed. For UI changes, test navigation, cancellation, repeated actions, and browser Back/Forward as applicable.

## Pull requests

- Keep each change focused and describe the problem, behavior changed, and verification performed.
- Add regression coverage for behavior changes in the existing `test/` suites.
- Keep English, Ukrainian, and Russian README changes consistent. The Chinese and Japanese quickstarts are intentionally shorter guides.
- Do not commit `.env`, `config.json`, local databases, credentials, or user uploads.
- Open a draft pull request when implementation or validation is still incomplete.

No response-time commitment is implied by opening an issue or pull request.
