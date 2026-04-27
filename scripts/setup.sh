#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Forge — Automated Setup Script
# ============================================================
# Checks dependencies, installs graph engine, builds hooks,
# and installs Forge into Claude Code configuration.
#
# Usage:
#   ./scripts/setup.sh              # interactive
#   ./scripts/setup.sh --global     # global install (skip prompt)
#   ./scripts/setup.sh --local      # local install (skip prompt)
#   curl -sSL <url>/setup.sh | bash # clone + install
# ============================================================

CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

FORGE_SRC_DIR="$HOME/.forge-src"
REPO_URL="${FORGE_REPO_URL:-TBD}"  # Set when repo is available

step_num=0
total_steps=7

step() {
  step_num=$((step_num + 1))
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${CYAN} Step ${step_num}/${total_steps}: ${BOLD}$1${RESET}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }

# ============================================================
# Parse arguments
# ============================================================
INSTALL_MODE=""
for arg in "$@"; do
  case "$arg" in
    --global|-g) INSTALL_MODE="global" ;;
    --local|-l)  INSTALL_MODE="local" ;;
    --help|-h)
      echo "Usage: ./scripts/setup.sh [--global|--local]"
      echo ""
      echo "  --global, -g   Install to ~/.claude/ (all projects)"
      echo "  --local, -l    Install to ./.claude/ (current project only)"
      echo "  --help, -h     Show this help"
      echo ""
      echo "Without flags: interactive prompt for install location."
      exit 0
      ;;
  esac
done

# ============================================================
# Banner
# ============================================================
echo ""
echo -e "${CYAN}  ███████╗ ██████╗ ██████╗  ██████╗ ███████╗${RESET}"
echo -e "${CYAN}  ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝${RESET}"
echo -e "${CYAN}  █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ${RESET}"
echo -e "${CYAN}  ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ${RESET}"
echo -e "${CYAN}  ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗${RESET}"
echo -e "${CYAN}  ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝${RESET}"
echo ""
echo -e "  ${DIM}AI-powered spec-driven development for Claude Code${RESET}"
echo ""

# ============================================================
# Step 1: Check system requirements
# ============================================================
step "Checking system requirements"

MISSING=0

# Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node.js $NODE_VERSION"
  else
    fail "Node.js $NODE_VERSION (need 20+)"
    MISSING=1
  fi
else
  fail "Node.js not found"
  echo -e "    Install: ${DIM}brew install node${RESET} (macOS) or ${DIM}nvm install 20${RESET}"
  MISSING=1
fi

# Git
if command -v git &>/dev/null; then
  GIT_VERSION=$(git --version | awk '{print $3}')
  ok "Git $GIT_VERSION"
else
  fail "Git not found"
  echo -e "    Install: ${DIM}brew install git${RESET} (macOS) or ${DIM}apt install git${RESET} (Linux)"
  MISSING=1
fi

# npm
if command -v npm &>/dev/null; then
  NPM_VERSION=$(npm --version)
  ok "npm $NPM_VERSION"
else
  fail "npm not found (comes with Node.js)"
  MISSING=1
fi

# Claude Code CLI
if command -v claude &>/dev/null; then
  CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
  ok "Claude Code CLI $CLAUDE_VERSION"
else
  warn "Claude Code CLI not found"
  echo -e "    Install: ${DIM}npm install -g @anthropic-ai/claude-code${RESET}"
  echo -e "    ${DIM}Forge will install but /forge-* commands require Claude Code${RESET}"
fi

# Docker (optional)
if command -v docker &>/dev/null; then
  DOCKER_VERSION=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')
  ok "Docker $DOCKER_VERSION (optional — enables container isolation)"
else
  warn "Docker not found (optional — Forge uses git worktrees as fallback)"
fi

# Build tools (needed for better-sqlite3)
if [[ "$OSTYPE" == "darwin"* ]]; then
  if xcode-select -p &>/dev/null; then
    ok "Xcode Command Line Tools"
  else
    warn "Xcode CLT not found — may need for better-sqlite3"
    echo -e "    Install: ${DIM}xcode-select --install${RESET}"
  fi
elif command -v gcc &>/dev/null; then
  ok "Build tools (gcc)"
else
  warn "Build tools not found — may need for better-sqlite3"
  echo -e "    Install: ${DIM}apt install build-essential${RESET}"
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  fail "Missing required dependencies. Install them and re-run this script."
  exit 1
fi

# ============================================================
# Step 2: Ensure Forge source is available
# ============================================================
step "Ensuring Forge source code"

# Detect if we're running from inside the repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_ROOT/package.json" ] && grep -q '"atos-forge"' "$REPO_ROOT/package.json" 2>/dev/null; then
  ok "Running from Forge repository: $REPO_ROOT"
  SRC_DIR="$REPO_ROOT"
elif [ -d "$FORGE_SRC_DIR" ] && [ -f "$FORGE_SRC_DIR/package.json" ]; then
  ok "Found existing Forge source at $FORGE_SRC_DIR"
  echo -e "  ${DIM}Updating...${RESET}"
  cd "$FORGE_SRC_DIR"
  git pull --quiet 2>/dev/null || warn "Could not pull latest (offline?)"
  SRC_DIR="$FORGE_SRC_DIR"
else
  if [ "$REPO_URL" = "TBD" ]; then
    fail "No Forge source found and repository URL not configured."
    echo -e "    Clone manually: ${DIM}git clone <repo-url> $FORGE_SRC_DIR${RESET}"
    echo -e "    Then re-run:    ${DIM}$FORGE_SRC_DIR/scripts/setup.sh${RESET}"
    exit 1
  fi
  echo -e "  ${DIM}Cloning from $REPO_URL...${RESET}"
  git clone --quiet "$REPO_URL" "$FORGE_SRC_DIR"
  ok "Cloned to $FORGE_SRC_DIR"
  SRC_DIR="$FORGE_SRC_DIR"
fi

cd "$SRC_DIR"
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
ok "Forge version: $VERSION"

# ============================================================
# Step 3: Install graph engine dependencies
# ============================================================
step "Installing graph engine dependencies"

echo -e "  ${DIM}Running npm install in forge-graph/...${RESET}"

cd "$SRC_DIR/forge-graph"

if npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -3; then
  ok "tree-sitter, better-sqlite3, chalk installed"
else
  fail "npm install failed in forge-graph/"
  echo -e "    ${DIM}Try manually: cd $SRC_DIR/forge-graph && npm install${RESET}"
  exit 1
fi

cd "$SRC_DIR"

# Also install forge-system deps if present
if [ -f "$SRC_DIR/forge-system/package.json" ]; then
  echo -e "  ${DIM}Installing forge-system dependencies...${RESET}"
  cd "$SRC_DIR/forge-system" && npm install --no-audit --no-fund --loglevel=error 2>/dev/null && cd "$SRC_DIR"
  ok "forge-system dependencies installed"
fi

# ============================================================
# Step 4: Build hooks
# ============================================================
step "Building hooks"

cd "$SRC_DIR"
node scripts/build-hooks.js 2>&1 | while IFS= read -r line; do echo "  $line"; done
ok "Hooks built to hooks/dist/"

# ============================================================
# Step 5: Run Forge installer
# ============================================================
step "Installing Forge into Claude Code"

cd "$SRC_DIR"

if [ "$INSTALL_MODE" = "global" ]; then
  node bin/install.js --claude --global
elif [ "$INSTALL_MODE" = "local" ]; then
  node bin/install.js --claude --local
else
  # Interactive — let install.js prompt
  node bin/install.js --claude
fi

# ============================================================
# Step 6: Run tests
# ============================================================
step "Running verification tests"

cd "$SRC_DIR"

echo -e "  ${DIM}Running 101 tests...${RESET}"
TEST_OUTPUT=$(npm test 2>&1 || true)
TEST_EXIT=$?

PASS_COUNT=$(echo "$TEST_OUTPUT" | grep -o "pass [0-9]*" | awk '{print $2}' || echo "0")
FAIL_COUNT=$(echo "$TEST_OUTPUT" | grep -o "fail [0-9]*" | awk '{print $2}' || echo "0")

if [ "$FAIL_COUNT" = "0" ] || [ -z "$FAIL_COUNT" ]; then
  ok "All tests passed ($PASS_COUNT pass, 0 fail)"
else
  warn "$PASS_COUNT pass, $FAIL_COUNT fail"
  echo -e "    ${DIM}Run 'npm test' in $SRC_DIR for details${RESET}"
fi

# ============================================================
# Step 7: Post-install summary
# ============================================================
step "Installation complete"

echo ""
echo -e "  ${GREEN}${BOLD}Forge is ready!${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "  1. Open your project in Claude Code:"
echo -e "     ${CYAN}cd /path/to/your/project${RESET}"
echo -e "     ${CYAN}claude${RESET}"
echo ""
echo -e "  2. Initialize Forge (builds code graph):"
echo -e "     ${CYAN}/forge-init${RESET}"
echo ""
echo -e "  3. Check everything works:"
echo -e "     ${CYAN}/forge-doctor${RESET}"
echo ""
echo -e "  4. Start building:"
echo -e "     ${CYAN}/forge-new-project${RESET}       ${DIM}# New project from scratch${RESET}"
echo -e "     ${CYAN}/forge-map-codebase${RESET}      ${DIM}# Analyze existing project first${RESET}"
echo -e "     ${CYAN}/forge-auto${RESET}              ${DIM}# Autonomous mode — walk away${RESET}"
echo ""
echo -e "  ${DIM}Full command reference: /forge-help${RESET}"
echo -e "  ${DIM}Documentation: $SRC_DIR/docs/USER-GUIDE.md${RESET}"
echo -e "  ${DIM}Architecture: $SRC_DIR/architecture.md${RESET}"
echo ""
