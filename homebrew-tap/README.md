# Homebrew — Claude Code Studio (macOS)

> **Transitional.** Since the signed release the app is distributed as a notarized `.dmg`
> and updates itself. This tap stays only so older installs, which update through
> `brew upgrade`, can reach that release; it is retired about a month later — see
> [`MAC-SIGNING.md`](../docs/electron-desktop/MAC-SIGNING.md).

The macOS desktop app was distributed via a Homebrew tap:

```bash
brew install --cask Lexus2016/claude-code-studio/claude-code-studio
```

Apple Silicon only (Intel dropped in September 2026). Signing and notarization:
[`MAC-SIGNING.md`](../docs/electron-desktop/MAC-SIGNING.md). Prerequisite: the
[Claude Code CLI](https://docs.anthropic.com/en/claude-code) installed and logged in.

- **Tap repo (cask source of truth):** https://github.com/Lexus2016/homebrew-claude-code-studio
- **Bump:** `npm run release:mac` (`scripts/release-mac.js`) rewrites the tap's cask
  `version` + `sha256` from the dmg it has just verified and uploaded. The macOS build is
  not made in CI, so neither is the bump.

Versions before the signed release update by running `brew upgrade --cask claude-code-studio`; later ones update themselves.

> The cask is published only in the tap repo above; this folder no longer keeps a copy to avoid
> drift. Recreate one with `brew cat Lexus2016/claude-code-studio/claude-code-studio` if needed.
