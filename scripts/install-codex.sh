#!/usr/bin/env bash
set -euo pipefail

# Install codex-feishu skill for Codex.
# Usage: bash scripts/install-codex.sh [--link]
#   --link  Create a symlink instead of copying (for development)

SKILL_NAME="codex-feishu"
CODEX_SKILLS_DIR="$HOME/.codex/skills"
TARGET_DIR="$CODEX_SKILLS_DIR/$SKILL_NAME"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Installing $SKILL_NAME skill for Codex..."

# Check source
if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

# Create skills directory
mkdir -p "$CODEX_SKILLS_DIR"

# Check if already installed
if [ -e "$TARGET_DIR" ]; then
  if [ -L "$TARGET_DIR" ]; then
    EXISTING=$(readlink "$TARGET_DIR")
    echo "Already installed as symlink → $EXISTING"
    echo "To reinstall, remove it first: rm $TARGET_DIR"
    exit 0
  else
    echo "Already installed at $TARGET_DIR"
    echo "To reinstall, remove it first: rm -rf $TARGET_DIR"
    exit 0
  fi
fi

if [ "${1:-}" = "--link" ]; then
  ln -s "$SOURCE_DIR" "$TARGET_DIR"
  echo "Symlinked: $TARGET_DIR → $SOURCE_DIR"
else
  cp -R "$SOURCE_DIR" "$TARGET_DIR"
  echo "Copied to: $TARGET_DIR"
fi

# Ensure dependencies (need devDependencies for build step)
if [ ! -d "$TARGET_DIR/node_modules" ] || [ ! -d "$TARGET_DIR/node_modules/@larksuiteoapi/node-sdk" ]; then
  echo "Installing dependencies..."
  (cd "$TARGET_DIR" && npm install)
fi

# Ensure build
if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$TARGET_DIR" && npm run build)
fi

# Prune devDependencies after build
echo "Pruning dev dependencies..."
(cd "$TARGET_DIR" && npm prune --production)

echo ""
echo "Done! Start a new Codex session and use:"
echo "  codex-feishu setup    — configure Feishu bridge credentials"
echo "  codex-feishu start    — start the bridge daemon"
echo "  codex-feishu doctor   — diagnose issues"
echo ""
echo "Feishu first-run checklist:"
echo "  1. Edit ~/.codex-feishu/config.env"
echo "  2. In Feishu backend: add scopes + enable Bot"
echo "  3. Publish once"
echo "  4. Start the bridge"
echo "  5. In Feishu backend: Long Connection + im.message.receive_v1 + card.action.trigger"
echo "  6. Publish again"
echo ""
echo "Detailed guide:"
echo "  $TARGET_DIR/references/setup-guides.md"
