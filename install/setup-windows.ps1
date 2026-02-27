# ===========================================================================
# Claude Code — Remote Server Setup Script for Windows
# ===========================================================================
# Usage (run PowerShell as Administrator):
#
#   Method 1 — Direct download and run:
#   irm https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-windows.ps1 | iex
#
#   Method 2 — If already downloaded:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\setup-windows.ps1
#
# Requirements: Windows 10/11 or Windows Server 2019+
#               Run PowerShell as Administrator
# ===========================================================================

#Requires -Version 5.0

$ErrorActionPreference = "Stop"

# ─── Colors & Helpers ────────────────────────────────────────────────────────
function Write-Step   { param($msg) Write-Host "`n▸ $msg" -ForegroundColor Cyan -NoNewline; Write-Host "" }
function Write-Info   { param($msg) Write-Host "[INFO] $msg" -ForegroundColor Blue }
function Write-OK     { param($msg) Write-Host "[✓] $msg" -ForegroundColor Green }
function Write-Warn   { param($msg) Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Fail   { param($msg) Write-Host "[✗] $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path","User")
}

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         Claude Code — Remote Server Setup             ║" -ForegroundColor Green
Write-Host "║                    Windows                            ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# ─── Admin check ─────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Fail "This script must be run as Administrator. Right-click PowerShell → 'Run as Administrator'"
}
Write-OK "Running as Administrator"

# ─── Windows version check ───────────────────────────────────────────────────
$winVer = [System.Environment]::OSVersion.Version
Write-Info "Windows $($winVer.Major).$($winVer.Minor) (Build $($winVer.Build)) detected"
if ($winVer.Major -lt 10) {
  Write-Warn "Windows 10+ recommended. Proceeding anyway..."
}

# ─── Execution Policy ────────────────────────────────────────────────────────
Write-Step "Setting PowerShell execution policy..."
Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy RemoteSigned -Force
Write-OK "Execution policy: RemoteSigned"

# ─── WinGet / Chocolatey check ───────────────────────────────────────────────
Write-Step "Checking package manager..."
$useWinget = $false
$useChoco  = $false

if (Get-Command winget -ErrorAction SilentlyContinue) {
  Write-OK "winget available"
  $useWinget = $true
} elseif (Get-Command choco -ErrorAction SilentlyContinue) {
  Write-OK "Chocolatey available"
  $useChoco = $true
} else {
  Write-Info "No package manager found. Installing Chocolatey..."
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  Refresh-Path
  if (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-OK "Chocolatey installed"
    $useChoco = $true
  } else {
    Write-Fail "Failed to install Chocolatey. Install manually: https://chocolatey.org/install"
  }
}

# ─── Node.js ─────────────────────────────────────────────────────────────────
Write-Step "Installing Node.js 20 LTS..."

$nodeInstalled = $false
try {
  $nodeVer = (node -v 2>$null) -replace 'v','' -split '\.' | Select-Object -First 1
  if ([int]$nodeVer -ge 18) {
    Write-OK "Node.js $(node -v) already installed"
    $nodeInstalled = $true
  } else {
    Write-Warn "Node.js $(node -v) is too old (need 18+). Upgrading..."
  }
} catch {}

if (-not $nodeInstalled) {
  if ($useWinget) {
    winget install --id OpenJS.NodeJS.LTS --version 20 --accept-package-agreements --accept-source-agreements --silent
  } elseif ($useChoco) {
    choco install nodejs-lts --version=20 -y
  } else {
    # Direct download
    Write-Info "Downloading Node.js 20 LTS installer..."
    $nodeUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    $nodeMsi = "$env:TEMP\nodejs.msi"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /quiet /norestart" -Wait
    Remove-Item $nodeMsi -Force
  }
  Refresh-Path
}

# Verify
try {
  $nodeVersion = node -v 2>$null
  $npmVersion  = npm -v 2>$null
  Write-OK "Node.js $nodeVersion ready"
  Write-OK "npm $npmVersion ready"
} catch {
  Write-Fail "Node.js installation failed. Install manually: https://nodejs.org/en/download"
}

# ─── Claude Code CLI ─────────────────────────────────────────────────────────
Write-Step "Installing Claude Code CLI..."

try {
  $existingClaude = claude --version 2>$null
  Write-OK "Claude Code already installed: $existingClaude"
  $reinstall = Read-Host "  Reinstall/upgrade? [y/N]"
  if ($reinstall -match '^[Yy]') {
    npm install -g @anthropic-ai/claude-code
  }
} catch {
  npm install -g @anthropic-ai/claude-code
}

Refresh-Path

try {
  $claudeBin = (Get-Command claude -ErrorAction Stop).Source
  Write-OK "claude: $claudeBin"
} catch {
  # Try npm bin path
  $npmBin = npm bin -g 2>$null
  $claudeBin = "$npmBin\claude.cmd"
  if (Test-Path $claudeBin) {
    Write-OK "claude: $claudeBin"
    # Add npm global bin to PATH permanently
    $currentPath = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    if ($currentPath -notlike "*$npmBin*") {
      [System.Environment]::SetEnvironmentVariable("Path", "$currentPath;$npmBin", "Machine")
      Refresh-Path
    }
  } else {
    Write-Fail "claude not found after installation. Check: npm bin -g"
  }
}

# ─── Authentication ───────────────────────────────────────────────────────────
Write-Step "Authentication setup"
Write-Host ""
Write-Host "  Choose authentication method:" -ForegroundColor White
Write-Host "  1) ANTHROPIC_API_KEY — pay-per-use API (sk-ant-...)" -ForegroundColor White
Write-Host "  2) Claude Max subscription — claude.ai/code subscribers" -ForegroundColor White
Write-Host ""
$authChoice = Read-Host "  Enter choice [1/2] (default: 1)"
if (-not $authChoice) { $authChoice = "1" }

if ($authChoice -eq "1") {
  Write-Host ""
  $apiKey = Read-Host "  Enter ANTHROPIC_API_KEY (sk-ant-...)" -AsSecureString
  $apiKeyPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($apiKey)
  )
  if ($apiKeyPlain) {
    # Set system-wide environment variable
    [System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $apiKeyPlain, "Machine")
    $env:ANTHROPIC_API_KEY = $apiKeyPlain
    Write-OK "ANTHROPIC_API_KEY set as system environment variable"
    Write-Info "Restart any open terminals/services to pick up the new variable"
  } else {
    Write-Warn "No API key entered. Set manually:"
    Write-Warn '  [System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY","sk-ant-...","Machine")'
  }
} else {
  Write-Info "Starting claude login (will open browser or print auth URL)..."
  Write-Host ""
  try {
    claude login
  } catch {
    Write-Warn "claude login failed. Run manually: claude login"
  }
}

# ─── Workspace directory ──────────────────────────────────────────────────────
Write-Step "Workspace directory..."
$defaultWorkspace = "C:\claude-workspace"
$workspace = Read-Host "  Workspace path (default: $defaultWorkspace)"
if (-not $workspace) { $workspace = $defaultWorkspace }

if (-not (Test-Path $workspace)) {
  New-Item -ItemType Directory -Path $workspace -Force | Out-Null
}
Write-OK "Workspace: $workspace"

# ─── OpenSSH Server (for remote access) ──────────────────────────────────────
Write-Step "Configuring OpenSSH Server..."
Write-Host ""
Write-Host "  To use this Windows machine as a remote Claude Code server," -ForegroundColor White
Write-Host "  OpenSSH Server must be installed and running." -ForegroundColor White
Write-Host ""
$installSSH = Read-Host "  Install/enable OpenSSH Server? [Y/n]"
if (-not $installSSH -or $installSSH -match '^[Yy]') {
  # Install OpenSSH Server
  $sshCapability = Get-WindowsCapability -Online -Name "OpenSSH.Server*" -ErrorAction SilentlyContinue
  if ($sshCapability.State -eq "Installed") {
    Write-OK "OpenSSH Server already installed"
  } else {
    Write-Info "Installing OpenSSH Server..."
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
    Write-OK "OpenSSH Server installed"
  }

  # Start and enable SSH service
  Start-Service sshd -ErrorAction SilentlyContinue
  Set-Service sshd -StartupType Automatic
  Write-OK "OpenSSH Server service: running (auto-start)"

  # Firewall rule
  $fwRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
  if (-not $fwRule) {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    Write-OK "Firewall rule added for port 22"
  } else {
    Write-OK "Firewall rule already exists"
  }

  # Set PowerShell as default shell for SSH (so claude runs in correct environment)
  $psPath = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
  if (-not $psPath) { $psPath = (Get-Command powershell).Source }
  New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value $psPath `
    -PropertyType String -Force | Out-Null
  Write-OK "SSH default shell: $psPath"

  # Display SSH authorized_keys location
  Write-Info "Add your SSH public key to: $env:ProgramData\ssh\administrators_authorized_keys"
  Write-Info "Or for specific user: $env:USERPROFILE\.ssh\authorized_keys"
} else {
  Write-Warn "Skipping OpenSSH Server setup. Configure manually if needed."
}

# ─── Add claude to SSH environment ───────────────────────────────────────────
# SSH sessions on Windows often don't inherit PATH from the logged-in user.
# We need to ensure claude is in the system PATH, which we did above.
Write-Info "Ensuring claude is in system PATH for SSH sessions..."
$systemPath = [System.Environment]::GetEnvironmentVariable("Path","Machine")
$npmGlobalBin = npm bin -g 2>$null
if ($systemPath -notlike "*$npmGlobalBin*") {
  [System.Environment]::SetEnvironmentVariable("Path", "$systemPath;$npmGlobalBin", "Machine")
  Write-OK "npm global bin added to system PATH: $npmGlobalBin"
}

# ─── Verify ───────────────────────────────────────────────────────────────────
Write-Step "Verifying installation..."
try {
  $claudeVersion = claude --version 2>$null
  Write-OK "claude: $claudeVersion"
} catch {
  Write-Warn "claude not found in current PATH. May work after restart."
}

# ─── Get local IP ────────────────────────────────────────────────────────────
$localIP = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Ethernet*","Wi-Fi*" -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "169.*" } | Select-Object -First 1).IPAddress
if (-not $localIP) { $localIP = "unknown (check ipconfig)" }

# ─── Summary ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                  ✓ Setup Complete!                    ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  User:          $env:USERNAME" -ForegroundColor White
Write-Host "  Node.js:       $(node -v)" -ForegroundColor White
Write-Host "  Workspace:     $workspace" -ForegroundColor White
Write-Host "  SSH port:      22" -ForegroundColor White
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "  1. Add your SSH public key to authorized_keys" -ForegroundColor Gray
Write-Host "     File: $env:ProgramData\ssh\administrators_authorized_keys" -ForegroundColor Cyan
Write-Host "  2. In Claude Code Studio → SSH Хости → + Додати SSH хост" -ForegroundColor Gray
Write-Host "     Host: $localIP  User: $env:USERNAME  Port: 22" -ForegroundColor Cyan
Write-Host "  3. Create a Remote Project → path: $workspace" -ForegroundColor Gray
Write-Host ""
Write-Host "  IMPORTANT: Restart this machine (or all terminals) so PATH changes take effect." -ForegroundColor Yellow
Write-Host ""
