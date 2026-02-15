#!/bin/bash
set -e

# OpenCode-Cursor one-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Nomadcxx/opencode-cursor/main/install.sh | bash
# Prefer npm if available (easiest upgrades). Otherwise:
# - With Go: runs TUI installer from source.
# - Without Go: runs shell-only install from source (bun + cursor-agent required).

echo "OpenCode-Cursor Installer"
echo "========================="
echo ""

INSTALL_DIR="${HOME}/.local/share/opencode-cursor"
if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    CONFIG_HOME=$(eval echo "~${SUDO_USER}")/.config
else
    CONFIG_HOME="${HOME}/.config"
fi
PLUGIN_DIR="${CONFIG_HOME}/opencode/plugin"
CONFIG_PATH="${CONFIG_HOME}/opencode/opencode.json"

NPM_PKG="@rama_nigg/open-cursor"

# If npm is available, install/upgrade the published package and run its installer.
# This produces a plugin symlink pointing at the globally-installed package, so
# upgrading later is just: npm update -g @rama_nigg/open-cursor
if command -v npm &>/dev/null; then
    echo "npm detected; installing via npm package (${NPM_PKG})..."
    echo ""

    if ! npm install -g "${NPM_PKG}"; then
        echo "Error: npm install failed for ${NPM_PKG}"
        echo "Check your network connection and npm permissions."
        echo "Try: sudo npm install -g ${NPM_PKG}"
        exit 1
    fi

    OPEN_CURSOR_BIN="$(command -v open-cursor || true)"
    if [ -z "$OPEN_CURSOR_BIN" ]; then
        PREFIX="$(npm prefix -g 2>/dev/null || true)"
        if [ -n "$PREFIX" ] && [ -x "${PREFIX}/bin/open-cursor" ]; then
            OPEN_CURSOR_BIN="${PREFIX}/bin/open-cursor"
        fi
    fi

    if [ -z "$OPEN_CURSOR_BIN" ]; then
        echo "Error: open-cursor binary not found after npm install."
        echo "Try starting a new shell session, or run: npm bin -g"
        exit 1
    fi

    "${OPEN_CURSOR_BIN}" install --config "${CONFIG_PATH}" --plugin-dir "${PLUGIN_DIR}" "$@"
    EXIT_CODE=$?

    echo ""
    if [ $EXIT_CODE -eq 0 ]; then
        echo "Installation complete via npm."
        echo "To upgrade later:"
        echo "  npm update -g ${NPM_PKG}"
        echo "  open-cursor sync-models"
    else
        echo "Installation failed (exit code $EXIT_CODE)."
    fi

    exit $EXIT_CODE
fi

if command -v go &>/dev/null; then
    echo "Installing to: ${INSTALL_DIR}"
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    echo "Downloading opencode-cursor..."
    if [ -d ".git" ]; then
        if ! git pull origin main; then
            echo "Error: git pull failed. Check your network connection."
            exit 1
        fi
    else
        if ! git clone --depth 1 https://github.com/Nomadcxx/opencode-cursor.git .; then
            echo "Error: git clone failed. Check your network connection and GitHub access."
            exit 1
        fi
    fi

    echo "Building installer..."
    if ! go build -o ./installer ./cmd/installer; then
        echo "Error: Go build failed. Check Go compiler and dependencies."
        exit 1
    fi

    echo ""
    echo "Running installer..."
    echo ""

    ./installer "$@"
    EXIT_CODE=$?
else
    echo "Go not found; using shell-only install."
    echo ""

    if ! command -v cursor-agent &>/dev/null; then
        echo "Error: cursor-agent is not installed. Install with: curl -fsSL https://cursor.com/install | bash"
        exit 1
    fi

    echo "Installing AI SDK in OpenCode..."
    mkdir -p "${CONFIG_HOME}/opencode"
    if command -v bun &>/dev/null; then
        if ! (cd "${CONFIG_HOME}/opencode" && bun install "@ai-sdk/openai-compatible"); then
            echo "Error: bun install failed for @ai-sdk/openai-compatible."
            exit 1
        fi
    elif command -v npm &>/dev/null; then
        if ! (cd "${CONFIG_HOME}/opencode" && npm install "@ai-sdk/openai-compatible"); then
            echo "Error: npm install failed for @ai-sdk/openai-compatible."
            exit 1
        fi
    else
        echo "Error: Neither bun nor npm found. Cannot install @ai-sdk/openai-compatible."
        echo "Install bun from https://bun.sh or npm from https://nodejs.org"
        exit 1
    fi

    echo "Updating config..."
    NPM_PLUGIN="@rama_nigg/open-cursor@latest"
    if [ -f "$CONFIG_PATH" ]; then
        CONFIG_BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
        if ! cp "$CONFIG_PATH" "$CONFIG_BACKUP"; then
            echo "Warning: Failed to create config backup at $CONFIG_BACKUP"
            echo "Continuing without backup..."
        else
            echo "Config backup written to $CONFIG_BACKUP"
        fi
    fi

    if [ ! -f "$CONFIG_PATH" ]; then
        mkdir -p "$(dirname "$CONFIG_PATH")"
        echo '{"plugin":[],"provider":{}}' > "$CONFIG_PATH"
    fi

    if command -v jq &>/dev/null; then
        UPDATED=$(jq --arg npmPlugin "$NPM_PLUGIN" '
            .provider["cursor-acp"] = ((.provider["cursor-acp"] // {}) | . + {
                name: "Cursor",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: "http://127.0.0.1:32124/v1" }
            }) | .plugin = ((.plugin // []) |
                if index("cursor-acp") then
                    .
                elif map(select(startswith("@rama_nigg/open-cursor"))) | length > 0 then
                    .
                else
                    . + [$npmPlugin]
                end)
        ' "$CONFIG_PATH")
        if ! echo "$UPDATED" | jq empty 2>/dev/null; then
            echo "Error: jq produced invalid JSON. Config not modified."
            exit 1
        fi
        echo "$UPDATED" > "$CONFIG_PATH"
    else
        bun -e "
        const fs=require('fs');
        const p=process.argv[1];
        const npmPlugin=process.argv[2];
        let c={};
        try{c=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){
            console.error('Error: Failed to parse opencode.json:', e.message);
            console.error('Please fix or backup and remove the config file, then try again.');
            process.exit(1);
        }
        c.plugin=c.plugin||[];
        const hasCursorAcp=c.plugin.includes('cursor-acp');
        const hasNpmPlugin=c.plugin.some(x=>typeof x==='string'&&x.startsWith('@rama_nigg/open-cursor'));
        if(!hasCursorAcp&&!hasNpmPlugin)c.plugin.push(npmPlugin);
        c.provider=c.provider||{};
        c.provider['cursor-acp']={...(c.provider['cursor-acp']||{}),name:'Cursor',npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:32124/v1'}};
        fs.writeFileSync(p,JSON.stringify(c,null,2));
        " "$CONFIG_PATH" "$NPM_PLUGIN"
        echo "Note: jq not found; models not synced. Run ./scripts/sync-models.sh or cursor-agent models to populate."
    fi

    echo ""
    echo "Installation complete!"
    echo "Plugin: $NPM_PLUGIN added to opencode.json"
    echo "To sync models, run: cursor-agent models (then restart OpenCode)"
    EXIT_CODE=0
fi

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    if command -v go &>/dev/null; then
        echo "Repository kept at: ${INSTALL_DIR}"
        echo "Uninstall: cd ${INSTALL_DIR} && ./installer --uninstall"
    else
        echo "To uninstall, remove the plugin from your opencode.json plugins array."
    fi
else
    if command -v go &>/dev/null; then
        echo "Installation failed (exit code $EXIT_CODE). Repository kept at: ${INSTALL_DIR}"
    else
        echo "Installation failed (exit code $EXIT_CODE)."
    fi
fi

exit $EXIT_CODE
