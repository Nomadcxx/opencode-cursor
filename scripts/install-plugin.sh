#!/bin/bash
set -euo pipefail

# Detect repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Installing opencode-cursor plugin..."
echo "Repository root: $REPO_ROOT"

# Check Node.js availability
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is required but not found in PATH"
  echo "Please install Node.js >= 20 and ensure it's in your PATH"
  exit 1
fi

NODE_VERSION=$(node --version)
echo "Using Node.js: $NODE_VERSION"

# Install dependencies
echo ""
echo "Installing dependencies..."
if command -v bun &> /dev/null; then
  bun install
else
  npm install
fi

echo ""
echo "Building plugin..."
if command -v bun &> /dev/null; then
  bun run build
else
  npm run build
fi

# Create plugin directory
PLUGIN_DIR="${HOME}/.config/opencode/plugin"
mkdir -p "$PLUGIN_DIR"
echo "Created plugin directory: $PLUGIN_DIR"

# Write plugin symlink after build succeeds
PLUGIN_FILE="$PLUGIN_DIR/cursor-acp.js"
echo ""
echo "Linking plugin entrypoint to: $PLUGIN_FILE"
ln -sfn "$REPO_ROOT/dist/plugin-entry.js" "$PLUGIN_FILE"

# Validate opencode.json
OPENCODE_CONFIG="${HOME}/.config/opencode/opencode.json"
if [ -f "$OPENCODE_CONFIG" ]; then
  echo ""
  echo "Checking opencode.json..."

  # Check if "cursor-acp" is in the plugin array (JSON-aware, handles multiline arrays)
  IN_PLUGIN_ARRAY=$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const hit = Array.isArray(cfg.plugin) && cfg.plugin.some(e => typeof e === "string" && e.includes("cursor-acp"));
      process.stdout.write(hit ? "yes" : "no");
    } catch { process.stdout.write("no"); }
  ' "$OPENCODE_CONFIG")
  if [ "$IN_PLUGIN_ARRAY" = "yes" ]; then
    echo "Found 'cursor-acp' in the plugin array."
  else
    echo "Reminder: add 'cursor-acp' to the plugin array if this is a new source install."
  fi
fi

# Final reminders
echo ""
echo "Installation complete!"
echo ""
echo "Existing cursor-agent users can continue with:"
echo "  cursor-agent login"
echo ""
echo "For SDK mode or SDK fallback, set a real Cursor API key:"
echo "  export CURSOR_API_KEY=<your-api-key>"
echo ""
echo "Get your API key from: https://cursor.com/settings"
echo ""
echo "Then verify with:"
echo "  opencode models | grep cursor-acp"
echo ""
