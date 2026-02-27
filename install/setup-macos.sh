#!/usr/bin/env bash
# ===========================================================================
# Claude Code — Remote Server Setup Script for macOS
# ===========================================================================
# Usage (run in Terminal, sudo not required for most steps):
#   curl -fsSL https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-macos.sh | bash
#   — OR (if already downloaded) —
#   chmod +x setup-macos.sh && ./setup-macos.sh
#
# NOTE: Run as your regular user (not root). Script will use sudo when needed.
# ===========================================================================

set -euo pipefail

# ─── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}▸ $*${NC}"; }

CURRENT_USER=$(whoami)
HOME_DIR="$HOME"

echo -e "${BOLD}"
echo "╔═══════════════════════════════════════════════════════╗"
echo "║         Claude Code — Remote Server Setup             ║"
echo "║                      macOS                            ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# macOS version
SW_VERS=$(sw_vers -productVersion 2>/dev/null || echo "unknown")
info "macOS $SW_VERS detected"

# ─── Xcode Command Line Tools ────────────────────────────────────────────────
step "Checking Xcode Command Line Tools..."
if xcode-select -p &>/dev/null; then
  success "Xcode CLT already installed"
else
  info "Installing Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  echo "  Please complete the installation dialog that appeared."
  read -p "  Press Enter when Xcode CLT installation is done..."
fi

# ─── Homebrew ─────────────────────────────────────────────────────────────────
step "Checking Homebrew..."
if command -v brew &>/dev/null; then
  success "Homebrew $(brew --version | head -1 | awk '{print $2}') already installed"
  brew update --quiet 2>/dev/null || true
else
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Add brew to PATH for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME_DIR/.zprofile"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME_DIR/.bash_profile"
  fi
  success "Homebrew installed"
fi

# ─── Node.js ─────────────────────────────────────────────────────────────────
step "Installing Node.js 20 LTS..."

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -ge 18 ]]; then
    success "Node.js $(node -v) already installed"
  else
    warn "Node.js $(node -v) is too old. Upgrading via Homebrew..."
    brew install node@20 || brew upgrade node
    brew link --overwrite --force node@20 2>/dev/null || true
  fi
else
  brew install node@20
  brew link --overwrite --force node@20 2>/dev/null || true
fi

node -v &>/dev/null && success "Node.js $(node -v) ready" || error "Node.js not available in PATH"
npm -v  &>/dev/null && success "npm $(npm -v) ready"

# ─── Claude Code CLI ─────────────────────────────────────────────────────────
step "Installing Claude Code CLI..."

if command -v claude &>/dev/null; then
  CURRENT_CLAUDE=$(claude --version 2>/dev/null | head -1 || echo "unknown")
  success "Claude Code already installed: $CURRENT_CLAUDE"
  read -p "  Reinstall/upgrade? [y/N]: " REINSTALL
  if [[ "${REINSTALL:-N}" =~ ^[Yy] ]]; then
    npm install -g @anthropic-ai/claude-code
  fi
else
  npm install -g @anthropic-ai/claude-code
fi

CLAUDE_BIN=$(command -v claude 2>/dev/null || echo "not found")
[[ "$CLAUDE_BIN" != "not found" ]] && success "claude: $CLAUDE_BIN" || \
  error "claude not found in PATH after installation. Check: npm bin -g"

# ─── Authentication ───────────────────────────────────────────────────────────
step "Authentication setup"
echo ""
echo -e "  Choose authentication method:"
echo -e "  ${BOLD}1)${NC} ANTHROPIC_API_KEY — pay-per-use via API (claude.ai developers)"
echo -e "  ${BOLD}2)${NC} Claude Max subscription — claude.ai/code subscribers"
echo ""
read -p "  Enter choice [1/2] (default: 2 for Mac users): " AUTH_CHOICE
AUTH_CHOICE="${AUTH_CHOICE:-2}"

# Determine shell profile
if [[ "$SHELL" == *zsh* ]]; then
  PROFILE="$HOME_DIR/.zshrc"
elif [[ -f "$HOME_DIR/.bash_profile" ]]; then
  PROFILE="$HOME_DIR/.bash_profile"
else
  PROFILE="$HOME_DIR/.bashrc"
fi

if [[ "$AUTH_CHOICE" == "1" ]]; then
  echo ""
  read -p "  Enter ANTHROPIC_API_KEY (sk-ant-...): " -s API_KEY
  echo ""
  if [[ -z "$API_KEY" ]]; then
    warn "No API key entered. Set manually: export ANTHROPIC_API_KEY=sk-ant-... in $PROFILE"
  else
    sed -i '' '/ANTHROPIC_API_KEY/d' "$PROFILE" 2>/dev/null || true
    echo "export ANTHROPIC_API_KEY=\"$API_KEY\"" >> "$PROFILE"
    export ANTHROPIC_API_KEY="$API_KEY"
    success "API key saved to $PROFILE"
  fi
else
  info "Starting claude login (will open browser or print auth URL)..."
  echo ""
  claude login || warn "claude login failed — run it manually"
fi

# ─── Workspace directory ──────────────────────────────────────────────────────
step "Workspace directory..."
read -p "  Workspace path (default: $HOME_DIR/workspace): " WORKSPACE
WORKSPACE="${WORKSPACE:-$HOME_DIR/workspace}"
mkdir -p "$WORKSPACE"
success "Workspace: $WORKSPACE"

# ─── Verify ───────────────────────────────────────────────────────────────────
step "Verifying installation..."
CLAUDE_VERSION=$(claude --version 2>/dev/null | head -1 || echo "unknown")
success "claude version: $CLAUDE_VERSION"

# ─── Remote access info ───────────────────────────────────────────────────────
step "Remote SSH access info"
echo ""
info "To use this Mac as a remote Claude Code server, ensure:"
echo "  1. System Settings → Sharing → Remote Login is ON"
echo "  2. Your SSH public key is in: $HOME_DIR/.ssh/authorized_keys"
echo "  3. Your Mac's IP or hostname is reachable from the hub server"
echo ""
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")
echo -e "  Local IP: ${CYAN}$LOCAL_IP${NC}"
echo -e "  SSH user: ${CYAN}$CURRENT_USER${NC}"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║                  ✓ Setup Complete!                    ║${NC}"
echo -e "${BOLD}${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}User:${NC}          $CURRENT_USER"
echo -e "  ${BOLD}claude:${NC}        $CLAUDE_BIN"
echo -e "  ${BOLD}Node.js:${NC}       $(node -v)"
echo -e "  ${BOLD}Workspace:${NC}     $WORKSPACE"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "  1. In Claude Code Studio → SSH Хости → ＋ Додати SSH хост"
echo -e "     Host: ${CYAN}$LOCAL_IP${NC}  User: ${CYAN}$CURRENT_USER${NC}"
echo -e "  2. Create a Remote Project → path: ${CYAN}$WORKSPACE${NC}"
echo ""
