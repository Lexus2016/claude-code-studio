# Electron Desktop — Design Spec

> Date: 2026-06-17
> Status: Decided (framework + update strategy locked)
> Scope: Add a desktop build (macOS, Linux, Windows) of Claude Code Studio **without
> removing or breaking the existing web-server deployment**. One codebase, two run modes.

---

## 1. Goal & Core Principle

Ship Claude Code Studio as a native desktop app on **macOS, Linux, Windows**, while the
current web-server mode (`npm start` / Docker) keeps working **byte-for-byte unchanged**.

**Core principle — one codebase, two launchers.** `server.js` stays the single source of
truth and a fully self-contained web server. Electron is a thin shell that boots the same
server on localhost and renders it in a native window. No code fork, no logic duplication.

| Mode | Entry | Audience |
|------|-------|----------|
| Web (existing) | `node server.js` / Docker | server / self-host / remote |
| Desktop (new) | Electron app | local single user, 3 OSes |

---

## 2. Framework Decision: Electron (not Tauri) — and why

A sister project (`llm-security-proxy` / LocalGuard) ships as **Tauri** with seamless unsigned
macOS auto-update. We deliberately do **not** mirror its *framework*, because the backends
differ in kind:

| | LocalGuard | claude-code-studio |
|---|---|---|
| Backend sidecar | one compiled Rust binary → `externalBin` is trivial | Node runtime + ~15 JS files + node_modules; **spawns child `node` helpers** (9× MCP) and **node-based hooks**; optional native modules; explicit **no-build-step** rule |

A Tauri sidecar would force: (1) bundling everything into a single binary (Node SEA / `pkg` /
bun) — a **build step that violates project philosophy**; (2) **redesigning MCP-helper and hook
spawning** into single-binary dispatch (a packaged binary has no `node` to spawn); (3) compat
risk for `node:sqlite` / `ssh2` / child-spawning under SEA. **Electron removes all three**
because Node *is* the runtime.

**We still adopt LocalGuard's distribution recipe — its Homebrew Cask — just not its
framework or its in-app updater (§6).**

---

## 3. Why Electron Fits This Codebase (evidence)

1. **`APP_DIR` override** — `server.js:75`: `const APP_DIR = process.env.APP_DIR || __dirname`.
   All writable state is built from `APP_DIR`; `APP_DIR = app.getPath('userData')` relocates it
   with zero code changes.
2. **Relative-URL frontend** — `new WebSocket(\`${proto}//${location.host}\`)`, `fetch('/api/...')`.
   The window loads `http://127.0.0.1:<port>` unmodified.
3. **`node:sqlite` instead of a native module** — `db-adapter.js` uses built-in `node:sqlite`
   at Node ≥ 22.13. Electron 37 ships Node 22.18 → no `better-sqlite3` recompilation.

---

## 4. Architecture (thin launcher + `utilityProcess.fork`)

```
[Electron main process]                         [forked child = the same Node server]
  ├─ APP_DIR = app.getPath('userData')            ├─ Express + WebSocket  (unchanged)
  ├─ pick a free ephemeral port                   ├─ node:sqlite          (Electron 37/Node 22.18)
  ├─ utilityProcess.fork(server.js, { env }) ───► ├─ spawns `claude`
  ├─ wait for GET /api/health                     └─ spawns internal MCP/hook helpers
  ├─ BrowserWindow → http://127.0.0.1:<port>
  ├─ contextIsolation:true, nodeIntegration:false
  ├─ update orchestration (§6)
  └─ kill child on window-all-closed
```

Rejected: in-process `require('./server.js')` (top-level side effects; a server crash kills the
window); a separate Electron fork of the app (duplicates ~17k LOC).

---

## 5. New & Modified Files

### New (do not affect web mode)
- `electron/main.js` — main process: APP_DIR, free-port pick, fork server, health-wait,
  window, lifecycle, PATH hardening, update orchestration.
- `electron/preload.js` — `contextIsolation: true`; exposes the `window.electronAPI` update
  bridge (`checkUpdate / startUpdate / onUpdateLog / getVersion`) consumed by the SPA's update banner.
- `electron/update-macos.js` — **non-security-critical** helper: locate `brew`, spawn a detached
  `brew upgrade --cask` + relaunch (§6). No crypto, no bundle-swapping of our own.
- `electron-builder.yml` — targets: macOS dmg + zip (x64 + arm64), Windows nsis, Linux
  AppImage + deb; `asarUnpack` for spawned helpers; `publish: github`.
- `homebrew-tap/Casks/claude-code-studio.rb` — Cask (§7), with `xattr -cr` postflight.
- `package.json` additions — `devDependencies`: `electron`, `electron-builder`,
  `electron-updater`; scripts `electron:dev`, `dist:mac`, `dist:win`, `dist:linux`.
  **devDependencies only** — web/Docker installs never pull them.

### Modified shared code (the only change to shared runtime behavior: interpreter resolver)
`command: 'node'` is hardcoded in **9 places** (`server.js` lines 1053, 5448, 5457, 5466, 5475,
6526, 6536, 6545, 6555) plus a hook string `node "…/check-interrupt.js"` (`server.js:2391`).
In a packaged app there is no guaranteed external `node`, and the script paths sit inside asar.

```js
function nodeInterpreter() {
  return process.versions.electron
    ? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } } // desktop: Electron-as-Node
    : { command: 'node',          env: {} };                             // web: unchanged
}
```

Replace the 9 sites + the hook. **Web-mode output is identical to today.** Spawned helpers
(`mcp-*.js`, `hooks/check-interrupt.js`) go in `asarUnpack`.

**Additive, desktop-gated UI in `public/index.html`:** an "Update available" banner + [Update]
button + report/log view (§6), all rendered **only when `window.electronAPI` exists**. In web
mode the preload bridge is absent, so the SPA renders exactly as today — zero behavior change.
This is additive UI, not a change to existing web behavior.

---

## 6. Update Experience — in-app, GUI-driven (unsigned, tiered, zero custom crypto)

Updating is a **first-class GUI feature**: the desktop user always sees their version and whether
a newer one exists, and updates without leaving the app. No Apple signing, no custom crypto.

**6.1 Version awareness (all OSes).** The app shows the current version and polls GitHub releases
(the SPA already does — `index.html:8222`). When a newer release exists, the UI shows a
non-intrusive **"Update available → vX.Y.Z"** banner with an **[Update]** button.

**6.2 One-click update + live report.** Pressing **[Update]**:
- **Windows / Linux:** `electron-updater` downloads + installs (native progress), then relaunch.
- **macOS (brew-managed):** Electron main locates `brew` (GUI PATH lacks it — probe
  `/opt/homebrew/bin/brew` arm64, `/usr/local/bin/brew` Intel; same approach as `claude-cli.js:26`),
  spawns a **detached** helper `HOMEBREW_NO_AUTO_UPDATE=1 brew upgrade --cask claude-code-studio`,
  streams its output to an in-app **report/log view**, then relaunches (`open -a`). The cask's own
  `quit:` terminates the running app during the swap; the detached helper relaunches it.

**6.3 Instructional fallback (when one-click can't run).** If `brew` isn't found, the app isn't
brew-managed (`brew list --cask claude-code-studio` fails), or the brew run exits non-zero, the
app shows the **exact command** with a **[Copy]** button and an **[Open Terminal]** button
(launches Terminal.app; user pastes):
- not installed via brew → `brew install --cask claude-code-studio`
- installed, manual upgrade → `brew upgrade --cask claude-code-studio`

We never leave the user guessing — either we run it for them, or we tell them precisely what to run.

**6.4 Optional auto-update (opt-in).** A setting "Update automatically": Win/Linux use
`electron-updater` autoDownload + install-on-quit; macOS runs the brew upgrade on launch when a
newer version is detected. **Default = OFF (notify + one-click)** — silently quitting/relaunching
mid-session is disruptive for a tool with live Claude sessions, so auto is the user's explicit choice.

**6.5 Architecture.** Update orchestration lives in the **Electron main process** (only it can
relaunch and drive `electron-updater`), exposed to the SPA via a **preload `contextBridge`**
(`window.electronAPI.checkUpdate() / startUpdate() / onUpdateLog() / getVersion()`). In **web mode
the bridge is absent**, so the SPA shows no update UI and the web build is completely unaffected.
brew / electron-updater never run inside the forked server — only in Electron main.

**Why no signing / no custom crypto:** `electron-updater` (Win/Linux) and Homebrew (macOS) each
own download + integrity verification + install. We add no Ed25519, no minisign, no
bundle-swapping. Homebrew's `xattr -cr` postflight handles Gatekeeper on macOS.

**Door left open:** an Apple Developer cert would let macOS switch to `electron-updater` by config.

---

## 7. Locked Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Code organization | One `server.js`; thin `electron/` shell |
| 2 | Server launch in Electron | `utilityProcess.fork` |
| 3 | Desktop data location | `APP_DIR = app.getPath('userData')` |
| 4 | Desktop port | ephemeral free port (web keeps 3000) |
| 5 | Desktop auth | local single-user auto-session (web keeps bcrypt) |
| 6 | Disabled on desktop | telegram bot, tunnel-manager, remote SSH — off by default |
| 7 | `claude` CLI | **Require + friendly auto-prompt**: detect at startup; if missing, show a friendly window with install instructions/link. No bundling. |
| 8 | **Framework** | **Electron** (not Tauri — §2; our backend is a multi-process Node app, not a single binary). |
| 9 | **Code signing** | **None.** Unsigned on all 3 OSes. Door open to Apple cert later. |
| 10 | **Auto-update** | **Tiered, unsigned, no custom crypto: Win/Linux = `electron-updater`; macOS = app-triggered `brew upgrade --cask` (detached) + relaunch** (§6). Not brew-managed → "install via Homebrew" guidance (no direct-dmg update path). |
| 11 | macOS distribution channels | **Homebrew Cask — the only supported macOS channel.** dmg/zip is built solely as the cask's source artifact, not a promoted direct install. Cask mirrors `homebrew-tap/Casks/localguard.rb`: `xattr -cr` postflight, **`auto_updates false`** (brew *is* the macOS updater). |
| 12 | Update UX | **In-app GUI: version banner + [Update] button + live report; [Copy] + [Open Terminal] command fallback; opt-in auto-update (default OFF).** Driven by preload `window.electronAPI`; absent (and invisible) in web mode. |

---

## 8. Constraints / Limitations

| Area | Constraint | Severity |
|------|-----------|----------|
| Product | `claude` CLI is a hard prerequisite (mitigated by detect + prompt) | High |
| macOS update | Works only for brew-installed users; needs brew-path detection (GUI PATH) + detached relaunch dance; brew can be slow/fail → show log + handle errors | Medium |
| Runtime | GUI-launch PATH problem (macOS/Linux): `claude`/`tmux`/`brew`/`node` not on the Dock-launch PATH. Mitigation: explicit path probing in `electron/main.js` + existing fallbacks in `claude-cli.js:26` | Medium |
| Packaging | `asarUnpack` required for spawned helpers/hooks | Medium |
| macOS | Homebrew is the only supported macOS install/update channel; non-brew users get install guidance, not auto-update | Low |
| Features | tmux "Subscription" engine unavailable without tmux (already capability-gated) | Low |
| Native | `ssh2`/`cpu-features` optional; pure-JS fallback works; remote-SSH off on desktop | Low |
| Distribution | ~150–220 MB installed; per-OS CI | Low-Med |
| Verify | confirm `node:sqlite` needs no `--experimental-sqlite` flag in Electron 37 (Phase-0 spike) | Low |

---

## 9. macOS Distribution via Homebrew Tap (Cask) — the only supported macOS channel

Tap repo `homebrew-claude-code-studio`, file `Casks/claude-code-studio.rb`:
`brew tap <owner>/claude-code-studio && brew install --cask claude-code-studio`. Thin wrapper
over the release dmg/zip (URL + `sha256`). Copy the proven pattern from
`homebrew-tap/Casks/localguard.rb`:
- **`postflight` → `xattr -cr <app>`** — strips quarantine so the unsigned app opens cleanly.
- **`auto_updates false`** (default) — brew manages the version; `brew upgrade --cask` (whether
  run by the user or triggered in-app, §6) is the macOS update mechanism.
- **`uninstall quit:` + `zap`** for clean removal (model on localguard.rb).
- **Automate the bump:** a release-CI step computes new `version` + `sha256` and pushes the
  updated Cask to the tap repo on every GitHub release (so in-app `brew upgrade` finds it).

Windows/Linux package-manager analogs (winget/scoop; AppImage already ships) are out of scope.

---

## 10. Phasing

- **Phase 0 — Spikes (de-risk first):** (a) confirm `node:sqlite` works flag-free in a packaged
  Electron 37 build; (b) confirm the detached `brew upgrade --cask` + relaunch flow works from a
  GUI-launched app (brew-path detection, quit/replace/relaunch).
- **Phase 1 — MVP build:** `electron/main.js` + interpreter resolver + `asarUnpack` + base
  `electron-builder.yml`. Outcome: launches on all 3 OSes, chat works.
- **Phase 2 — Hardening:** GUI PATH fix, `claude` detect + friendly prompt, disable server-only
  features on desktop, ephemeral port, auto-session auth.
- **Phase 3 — Update & distribution:** `electron-updater` (Win/Linux), macOS brew-trigger
  updater, **in-app update UI (version banner + [Update] button + live report + [Copy]/[Open
  Terminal] fallback), opt-in auto-update**, Homebrew Cask tap (auto-bumped from CI), GitHub
  release publishing, 3-OS CI.

After all phases, the web version behaves exactly as today.

---

## 11. Out of Scope (YAGNI)

- Switching the desktop build to Tauri (§2 — wrong fit for a multi-process Node backend).
- A custom in-app macOS self-updater with own-key signing (replaced by brew-triggered upgrade).
- A supported direct-`.dmg` install/update channel on macOS (the dmg is a cask source artifact only).
- Apple code signing / notarization (revisit only if first-launch friction proves unacceptable).
- Rewriting any backend logic; splitting `public/index.html` (stays single-file).
- Bundling the `claude` CLI.
- Desktop variants of telegram/tunnel/SSH server features.
- Windows/Linux package-manager channels (winget/scoop).
