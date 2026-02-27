# Claude Code Remote Setup Scripts

Run these scripts on **remote servers** to install and configure Claude Code CLI for use with Claude Code Studio's Remote SSH Projects feature.

## Quick Start

### Ubuntu / Debian / RHEL / CentOS

```bash
# Run as root:
curl -fsSL https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-linux.sh | bash
```

Or if you downloaded the file:
```bash
chmod +x setup-linux.sh && sudo bash setup-linux.sh
```

---

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-macos.sh | bash
```

Or:
```bash
chmod +x setup-macos.sh && ./setup-macos.sh
```

---

### Windows (PowerShell as Administrator)

```powershell
irm https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-windows.ps1 | iex
```

Or:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup-windows.ps1
```

---

## What the scripts do

| Step | Linux | macOS | Windows |
|------|-------|-------|---------|
| Install Node.js 20 LTS | ✅ NodeSource | ✅ Homebrew | ✅ winget/choco |
| Install claude CLI | ✅ npm -g | ✅ npm -g | ✅ npm -g |
| Configure ANTHROPIC_API_KEY | ✅ /etc/environment | ✅ ~/.zshrc | ✅ System env var |
| Claude Max login | ✅ claude login | ✅ claude login | ✅ claude login |
| Create workspace dir | ✅ /workspace | ✅ ~/workspace | ✅ C:\claude-workspace |
| Configure SSH server | ✅ (pre-existing) | ✅ (System Prefs) | ✅ OpenSSH install |
| Add to system PATH | ✅ | ✅ | ✅ |

## After running the script

1. Open **Claude Code Studio** in your browser
2. Sidebar → **SSH Хости** → **＋ Додати SSH хост**
3. Enter: Host IP, SSH user, key path
4. Click **🔌 Тест з'єднання** to verify
5. **＋ Новий проект** → **🌐 Віддалений SSH** → select host + path
6. Start chatting — Claude Code runs on the remote server!
