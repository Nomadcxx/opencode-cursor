#!/bin/bash
set -e

# OpenCode-Cursor one-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Nomadcxx/opencode-cursor/main/install.sh | bash
# With Go: runs TUI installer. Without Go: runs shell-only install (bun + cursor-agent required).

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

if command -v go &>/dev/null; then
    echo "Installing to: ${INSTALL_DIR}"
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    echo "Downloading opencode-cursor..."
    if [ -d ".git" ]; then
        git pull origin main
    else
        git clone --depth 1 https://github.com/Nomadcxx/opencode-cursor.git .
    fi

    echo "Building installer..."
    go build -o ./installer ./cmd/installer

    echo ""
    echo "Running installer..."
    echo ""

    ./installer "$@"
    EXIT_CODE=$?
else
    echo "Go not found; using shell-only install (Bun and cursor-agent required)."
    echo ""

    if ! command -v bun &>/dev/null; then
        echo "Error: bun is not installed. Install with: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    if ! command -v cursor-agent &>/dev/null; then
        echo "Error: cursor-agent is not installed. Install with: curl -fsSL https://cursor.com/install | bash"
        exit 1
    fi

    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    echo "Downloading opencode-cursor..."
    if [ -d ".git" ]; then
        git pull origin main
    else
        git clone --depth 1 https://github.com/Nomadcxx/opencode-cursor.git .
    fi

    echo "Building plugin..."
    bun install
    if ! bun run build; then
        echo "Initial build failed. Retrying with forced dependency reinstall..."
        bun install --force --no-cache
        bun run build
    fi

    if [ ! -s "dist/plugin-entry.js" ]; then
        echo "Error: dist/plugin-entry.js not found or empty after build"
        exit 1
    fi

    echo "Installing AI SDK in OpenCode..."
    mkdir -p "${CONFIG_HOME}/opencode"
    (cd "${CONFIG_HOME}/opencode" && bun install "@ai-sdk/openai-compatible")

    echo "Creating plugin symlink..."
    mkdir -p "$PLUGIN_DIR"
    rm -f "${PLUGIN_DIR}/cursor-acp.js"
    ln -sf "$(pwd)/dist/plugin-entry.js" "${PLUGIN_DIR}/cursor-acp.js"

    echo "Updating config..."
    if [ -f "$CONFIG_PATH" ]; then
        CONFIG_BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
        cp "$CONFIG_PATH" "$CONFIG_BACKUP"
        echo "Config backup written to $CONFIG_BACKUP"
    fi
    MODELS_JSON="{}"
    if command -v jq &>/dev/null; then
        RAW=$(cursor-agent models 2>&1 || true)
        CLEAN=$(echo "$RAW" | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g')
        while IFS= read -r line; do
            line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            if [ -z "$line" ] || echo "$line" | grep -qE '^(Available|Tip:)'; then continue; fi
            if echo "$line" | grep -qE '^[a-zA-Z0-9._-]+[[:space:]]+[-–—:][[:space:]]+'; then
                id=$(echo "$line" | sed -E 's/^([a-zA-Z0-9._-]+)[[:space:]]+[-–—:][[:space:]]+.*/\1/')
                name=$(echo "$line" | sed -E 's/^[a-zA-Z0-9._-]+[[:space:]]+[-–—:][[:space:]]+(.+?)([[:space:]]+\((current|default)\))?[[:space:]]*$/\1/' | sed 's/[[:space:]]*$//')
                if [ -n "$id" ] && [ -n "$name" ]; then
                    MODELS_JSON=$(echo "$MODELS_JSON" | jq --arg id "$id" --arg name "$name" '. + {($id): {name: $name}}')
                fi
            fi
        done <<< "$CLEAN"
    fi

    if [ ! -f "$CONFIG_PATH" ]; then
        mkdir -p "$(dirname "$CONFIG_PATH")"
        echo '{"plugin":[],"provider":{}}' > "$CONFIG_PATH"
    fi

    if command -v jq &>/dev/null; then
        UPDATED=$(jq --argjson models "$MODELS_JSON" '
            .provider["cursor-acp"] = ((.provider["cursor-acp"] // {}) | . + {
                name: "Cursor",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: "http://127.0.0.1:32124/v1" },
                models: $models
            }) | .plugin = ((.plugin // []) | if index("cursor-acp") then . else . + ["cursor-acp"] end)
        ' "$CONFIG_PATH")
        echo "$UPDATED" > "$CONFIG_PATH"
    else
        bun -e "
        const fs=require('fs');
        const p=process.argv[1];
        let c={};
        try{c=JSON.parse(fs.readFileSync(p,'utf8'));}catch(_){}
        c.plugin=c.plugin||[];
        if(!c.plugin.includes('cursor-acp'))c.plugin.push('cursor-acp');
        c.provider=c.provider||{};
        c.provider['cursor-acp']={...(c.provider['cursor-acp']||{}),name:'Cursor',npm:'@ai-sdk/openai-compatible',options:{baseURL:'http://127.0.0.1:32124/v1'},models:{}};
        fs.writeFileSync(p,JSON.stringify(c,null,2));
        " "$CONFIG_PATH"
        echo "Note: jq not found; models not synced. Run ./scripts/sync-models.sh after installing jq."
    fi

    echo ""
    echo "Installation complete!"
    echo "Plugin: ${PLUGIN_DIR}/cursor-acp.js"
    echo "Repository: ${INSTALL_DIR} (uninstall: remove symlink and cursor-acp from opencode.json)"
    EXIT_CODE=0
fi

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "Repository kept at: ${INSTALL_DIR}"
    if command -v go &>/dev/null; then
        echo "Uninstall: cd ${INSTALL_DIR} && ./installer --uninstall"
    fi
else
    echo "Installation failed (exit code $EXIT_CODE). Repository kept at: ${INSTALL_DIR}"
fi

exit $EXIT_CODE
