# Homebrew — Claude Code Studio (macOS)

The macOS desktop app is distributed via a Homebrew tap. **The tap is live:**

```bash
brew install --cask Lexus2016/claude-code-studio/claude-code-studio
```

Works on Apple Silicon and Intel. Prerequisite: the
[Claude Code CLI](https://docs.anthropic.com/en/claude-code) installed and logged in.

- **Tap repo (cask source of truth):** https://github.com/Lexus2016/homebrew-claude-code-studio
- **Auto-bump:** the `bump-cask` job in
  [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml) updates the
  tap's cask `version` + per-arch `sha256` on every release, using the repo secret
  `HOMEBREW_TAP_TOKEN`. If that secret is removed, the job skips cleanly (the release never fails)
  and you bump the cask manually in the tap repo.

Updates happen in-app — the desktop app runs `brew upgrade --cask claude-code-studio` for you.

> The cask is published only in the tap repo above; this folder no longer keeps a copy to avoid
> drift. Recreate one with `brew cat Lexus2016/claude-code-studio/claude-code-studio` if needed.
