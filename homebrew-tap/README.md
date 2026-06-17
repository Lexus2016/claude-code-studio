# Homebrew Tap — Claude Code Studio (macOS desktop)

`Casks/claude-code-studio.rb` here is the **source** of the macOS Cask. Homebrew taps must
live in a repo named `homebrew-<name>`, so to make `brew install` work you publish this cask
to a dedicated tap repository. This is a **one-time** setup.

## One-time setup (maintainer)

1. **Create a public repo** `https://github.com/Lexus2016/homebrew-claude-code-studio`.
2. **Seed it** with the cask from this folder:
   ```bash
   git clone https://github.com/Lexus2016/homebrew-claude-code-studio.git
   cd homebrew-claude-code-studio
   mkdir -p Casks
   cp /path/to/claude-code-studio/homebrew-tap/Casks/claude-code-studio.rb Casks/
   git add Casks && git commit -m "init: claude-code-studio cask" && git push
   ```
3. **Enable auto-bump (recommended):** create a fine-grained Personal Access Token with
   **Contents: write** on `homebrew-claude-code-studio`, and add it to the **main** repo as a
   secret named `HOMEBREW_TAP_TOKEN`. The `release-desktop.yml` → `bump-cask` job then updates
   the tap's cask `version` + `sha256` automatically on every release. Without the secret, the
   job skips cleanly (the release still succeeds) and you bump the cask manually.

## Users install with

```bash
brew install --cask Lexus2016/claude-code-studio/claude-code-studio
```

Updates happen **in-app** (the app runs `brew upgrade --cask claude-code-studio` for you), or
run that command manually.

> **Until the tap repo exists,** install the desktop app by downloading the `.dmg` from the
> [latest release](https://github.com/Lexus2016/claude-code-studio/releases/latest) — that path
> needs no Homebrew setup. (Currently the cask is arm64-only; an x64 dmg is also published.)
