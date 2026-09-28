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
- **Auto-bump:** the `bump-cask` job in
  [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml) updates the
  tap's cask `version` + `sha256` (arm64 dmg) on every release, using the repo secret
  `HOMEBREW_TAP_TOKEN`. If that secret is removed, the job skips cleanly (the release never fails)
  and you bump the cask manually in the tap repo.

Versions before the signed release update by running `brew upgrade --cask claude-code-studio`; later ones update themselves.

> The cask is published only in the tap repo above; this folder no longer keeps a copy to avoid
> drift. Recreate one with `brew cat Lexus2016/claude-code-studio/claude-code-studio` if needed.
