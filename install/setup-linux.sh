#!/usr/bin/env bash
# ===========================================================================
# Claude Code — Remote Server Setup Script for Linux (Ubuntu/Debian/RHEL/CentOS)
# ===========================================================================
# Usage (run as root):
#   curl -fsSL https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-linux.sh | bash
#   — OR —
#   wget -qO- https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-linux.sh | bash
#   — OR (if already downloaded) —
#   chmod +x setup-linux.sh && ./setup-linux.sh
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

# ─── Root check ─────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root. Use: sudo bash setup-linux.sh"
fi

echo -e "${BOLD}"
echo "╔═══════════════════════════════════════════════════════╗"
echo "║         Claude Code — Remote Server Setup             ║"
echo "║              Linux (Ubuntu / Debian / RHEL)           ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── Detect OS ───────────────────────────────────────────────────────────────
step "Detecting operating system..."
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
  OS_VERSION=$VERSION_ID
  info "Detected: $PRETTY_NAME"
else
  warn "Could not detect OS. Assuming Debian-compatible."
  OS="ubuntu"
fi

# Normalize OS family
case "$OS" in
  ubuntu|debian|linuxmint|pop)  PKG="apt" ;;
  centos|rhel|fedora|rocky|almalinux|ol) PKG="yum" ;;
  *)
    warn "Unknown OS '$OS'. Attempting apt-get..."
    PKG="apt"
    ;;
esac

# ─── Ask for SSH user ────────────────────────────────────────────────────────
step "SSH user configuration"
echo -e "  Claude Code will be configured for the SSH user that"
echo -e "  Claude Code Studio connects with."
echo ""
read -p "  Enter the SSH username (default: current user '$SUDO_USER'): " SSH_USER
SSH_USER="${SSH_USER:-${SUDO_USER:-$(logname 2>/dev/null || echo root)}}"
SSH_HOME=$(getent passwd "$SSH_USER" | cut -d: -f6 || echo "/root")
info "Configuring for user: $SSH_USER (home: $SSH_HOME)"

# ─── System packages ─────────────────────────────────────────────────────────
step "Installing system dependencies..."
if [[ "$PKG" == "apt" ]]; then
  apt-get update -qq
  apt-get install -y -qq curl wget git unzip build-essential 2>/dev/null || \
    apt-get install -y curl wget git unzip
elif [[ "$PKG" == "yum" ]]; then
  yum install -y curl wget git unzip gcc gcc-c++ make 2>/dev/null || true
fi
success "System dependencies installed"

# ─── Node.js ─────────────────────────────────────────────────────────────────
step "Installing Node.js 20 LTS..."
NODE_MAJOR=20

install_nodejs_apt() {
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - 2>/dev/null
  apt-get install -y nodejs
}

install_nodejs_yum() {
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - 2>/dev/null
  yum install -y nodejs
}

install_nodejs_nvm() {
  # Fallback: install via nvm for the SSH user
  su -l "$SSH_USER" -c "
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR=\"\$HOME/.nvm\"
    source \"\$NVM_DIR/nvm.sh\"
    nvm install ${NODE_MAJOR}
    nvm alias default ${NODE_MAJOR}
  "
}

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -ge 18 ]]; then
    success "Node.js $(node -v) already installed"
  else
    warn "Node.js $(node -v) is too old (need 18+). Upgrading..."
    [[ "$PKG" == "apt" ]] && install_nodejs_apt || install_nodejs_yum
  fi
else
  info "Node.js not found. Installing..."
  if [[ "$PKG" == "apt" ]]; then
    install_nodejs_apt || install_nodejs_nvm
  else
    install_nodejs_yum || install_nodejs_nvm
  fi
fi

# Verify
node -v &>/dev/null && success "Node.js $(node -v) ready" || error "Node.js installation failed"
npm -v &>/dev/null && success "npm $(npm -v) ready"

# ─── Claude Code CLI ─────────────────────────────────────────────────────────
step "Installing Claude Code CLI..."

# Try global install as root first
if npm install -g @anthropic-ai/claude-code 2>/dev/null; then
  success "Claude Code installed globally"
else
  warn "Global install failed. Installing for user $SSH_USER via npm prefix..."
  CLAUDE_PREFIX="$SSH_HOME/.local"
  mkdir -p "$CLAUDE_PREFIX"
  chown "$SSH_USER:$SSH_USER" "$CLAUDE_PREFIX"
  su -l "$SSH_USER" -c "npm install -g --prefix $CLAUDE_PREFIX @anthropic-ai/claude-code"
  # Add to PATH
  PROFILE_FILE="$SSH_HOME/.bashrc"
  grep -qxF "export PATH=\"\$HOME/.local/bin:\$PATH\"" "$PROFILE_FILE" 2>/dev/null || \
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$PROFILE_FILE"
fi

# Find claude binary
CLAUDE_BIN=$(command -v claude 2>/dev/null || \
  su -l "$SSH_USER" -c "which claude 2>/dev/null || echo $SSH_HOME/.local/bin/claude")

[[ -x "$CLAUDE_BIN" ]] && success "claude binary: $CLAUDE_BIN" || \
  error "claude binary not found after installation"

# ─── Authentication ───────────────────────────────────────────────────────────
step "Authentication setup"
echo ""
echo -e "  Choose authentication method:"
echo -e "  ${BOLD}1)${NC} ANTHROPIC_API_KEY — for Claude API / SDK users (pay-per-use)"
echo -e "  ${BOLD}2)${NC} Claude Max subscription — for claude.ai/code subscribers"
echo ""
read -p "  Enter choice [1/2] (default: 1): " AUTH_CHOICE
AUTH_CHOICE="${AUTH_CHOICE:-1}"

PROFILE_FILE="$SSH_HOME/.bashrc"
[[ -f "$SSH_HOME/.bash_profile" ]] && PROFILE_FILE="$SSH_HOME/.bash_profile"

if [[ "$AUTH_CHOICE" == "1" ]]; then
  echo ""
  read -p "  Enter ANTHROPIC_API_KEY (sk-ant-...): " -s API_KEY
  echo ""
  if [[ -z "$API_KEY" ]]; then
    warn "No API key entered. You will need to set ANTHROPIC_API_KEY manually."
    warn "Add to $PROFILE_FILE:  export ANTHROPIC_API_KEY=sk-ant-..."
  else
    # Remove old entry if exists
    sed -i '/ANTHROPIC_API_KEY/d' "$PROFILE_FILE" 2>/dev/null || true
    echo "export ANTHROPIC_API_KEY=\"$API_KEY\"" >> "$PROFILE_FILE"
    # Also write to /etc/environment for system-wide access
    sed -i '/ANTHROPIC_API_KEY/d' /etc/environment 2>/dev/null || true
    echo "ANTHROPIC_API_KEY=\"$API_KEY\"" >> /etc/environment
    chown "$SSH_USER:$SSH_USER" "$PROFILE_FILE"
    success "API key saved to $PROFILE_FILE and /etc/environment"
  fi
else
  echo ""
  info "You'll need to run 'claude login' as user '$SSH_USER'."
  info "This will print a URL — open it in your browser to authenticate."
  echo ""
  read -p "  Run 'claude login' now? [Y/n]: " DO_LOGIN
  if [[ "${DO_LOGIN:-Y}" =~ ^[Yy] ]]; then
    su -l "$SSH_USER" -c "claude login" || warn "Login failed — run 'claude login' manually as $SSH_USER"
  else
    warn "Remember to run: su -l $SSH_USER -c 'claude login'"
  fi
fi

# ─── Workspace directory ──────────────────────────────────────────────────────
step "Creating workspace directory..."
read -p "  Workspace path (default: /workspace): " WORKSPACE
WORKSPACE="${WORKSPACE:-/workspace}"

mkdir -p "$WORKSPACE"
chown "$SSH_USER:$SSH_USER" "$WORKSPACE"
chmod 755 "$WORKSPACE"
success "Workspace: $WORKSPACE"

# ─── Verify installation ──────────────────────────────────────────────────────
step "Verifying installation..."
CLAUDE_VERSION=$(su -l "$SSH_USER" -c "claude --version 2>/dev/null" || echo "unknown")
success "claude version: $CLAUDE_VERSION"

# Quick sanity check (no API call)
CLAUDE_HELP=$(su -l "$SSH_USER" -c "claude --help 2>/dev/null | head -1" || echo "")
[[ -n "$CLAUDE_HELP" ]] && success "claude --help works" || \
  warn "claude --help returned nothing — check PATH for user $SSH_USER"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║                  ✓ Setup Complete!                    ║${NC}"
echo -e "${BOLD}${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}SSH user:${NC}      $SSH_USER"
echo -e "  ${BOLD}claude bin:${NC}    $CLAUDE_BIN"
echo -e "  ${BOLD}Workspace:${NC}     $WORKSPACE"
echo -e "  ${BOLD}Node.js:${NC}       $(node -v)"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "  1. In Claude Code Studio → SSH Хости → ＋ Додати SSH хост"
echo -e "     Host: ${CYAN}$(hostname -I | awk '{print $1}')${NC}  User: ${CYAN}$SSH_USER${NC}"
echo -e "  2. Create a Remote Project pointing to: ${CYAN}$WORKSPACE${NC}"
echo -e "  3. Start chatting — Claude runs on THIS server!"
echo ""
