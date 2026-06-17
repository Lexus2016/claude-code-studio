cask "claude-code-studio" do
  version "5.58.0"
  sha256 "a9bbc17fb812556838e021c35b4b9e32106c7ea4f9964e08449f08781cb52ba4"

  url "https://github.com/Lexus2016/claude-code-studio/releases/download/v#{version}/claude-code-studio-#{version}-arm64.dmg"
  name "Claude Code Studio"
  desc "Desktop app for Claude Code — chat, multi-agent, MCP, skills"
  homepage "https://github.com/Lexus2016/claude-code-studio"

  # arm64 build only for now; an x64 dmg is also produced by CI (extend with
  # on_intel/on_arm blocks once an x64 sha is wired into the cask-bump job).
  depends_on macos: ">= :catalina"
  depends_on arch: :arm64

  app "Claude Code Studio.app"

  # The app updates itself in-app via `brew upgrade --cask` (no Sparkle/Squirrel),
  # so brew should manage the version normally — do not mark auto_updates.
  auto_updates false

  # Strip the quarantine attribute so the unsigned app opens without Gatekeeper
  # blocking it on first launch (mirrors the LocalGuard tap pattern).
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{appdir}/Claude Code Studio.app"],
                   sudo: false
  end

  uninstall quit: "studio.claudecode.app"

  zap trash: [
    "~/Library/Application Support/claude-code-studio",
  ]
end
