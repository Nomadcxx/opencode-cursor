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

# Create plugin directory
PLUGIN_DIR="${HOME}/.config/opencode/plugins"
mkdir -p "$PLUGIN_DIR"
echo "Created plugin directory: $PLUGIN_DIR"

# Write plugin wrapper
PLUGIN_FILE="$PLUGIN_DIR/cursor-acp.ts"
echo ""
echo "Writing plugin wrapper to: $PLUGIN_FILE"
cat > "$PLUGIN_FILE" << EOF
export { default } from "$REPO_ROOT/src/plugin-entry.ts"
EOF

# Clean up old versions
OLD_PLUGIN_JS="${HOME}/.config/opencode/plugin/cursor-acp.js"
if [ -f "$OLD_PLUGIN_JS" ]; then
  echo "Removing old plugin version: $OLD_PLUGIN_JS"
  rm -f "$OLD_PLUGIN_JS"
fi

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
    echo ""
    echo "WARNING: Your opencode.json contains 'cursor-acp' in the 'plugin' array."
    echo "This causes OpenCode to try to install a third-party npm package instead of using this plugin."
    echo ""
    echo "Please manually edit $OPENCODE_CONFIG and:"
    echo "  1. Remove 'cursor-acp' from the 'plugin' array"
    echo "  2. Keep the 'provider' section with 'cursor-acp' intact"
    echo ""
    echo "Example fix:"
    echo '  Remove the entry (or the whole "plugin" key if it becomes empty):'
    echo '  "provider": {'
    echo '    "cursor-acp": { ... }  // Keep this'
    echo '  }'
  fi
fi

# Final reminders
echo ""
echo "Installation complete!"
echo ""
echo "IMPORTANT: Set the CURSOR_API_KEY environment variable:"
echo "  export CURSOR_API_KEY=<your-api-key>"
echo ""
echo "Get your API key from: https://cursor.com/settings"
echo ""
echo "Then verify with:"
echo "  opencode models | grep cursor-acp"
echo ""
