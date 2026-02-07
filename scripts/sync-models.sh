#!/usr/bin/env bash

set -euo pipefail

CONFIG_FILE="${1:-${HOME}/.config/opencode/opencode.json}"
BASE_URL="${CURSOR_ACP_BASE_URL:-http://127.0.0.1:32124/v1}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: $CONFIG_FILE not found"
  exit 1
fi

if ! command -v cursor-agent >/dev/null 2>&1; then
  echo "Error: cursor-agent not found in PATH"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required"
  exit 1
fi

echo "Fetching models from cursor-agent..."
RAW_OUTPUT="$(cursor-agent models 2>&1)"

MODELS_JSON="$(python3 - "$RAW_OUTPUT" <<'PY'
import json
import re
import sys

clean = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", sys.argv[1])
pattern = re.compile(r"^([a-zA-Z0-9._-]+)\s+-\s+(.+?)\s*(?:\((?:current|default)\)\s*)*$")
models = {}

for line in clean.splitlines():
    match = pattern.match(line.strip())
    if not match:
        continue

    model_id = match.group(1)
    model_name = match.group(2).rstrip()
    models[model_id] = {"name": model_name}

print(json.dumps(models, ensure_ascii=False))
PY
)"

MODEL_COUNT="$(python3 - "$MODELS_JSON" <<'PY'
import json
import sys
print(len(json.loads(sys.argv[1])))
PY
)"

if [[ "$MODEL_COUNT" -eq 0 ]]; then
  echo "Error: Failed to parse models from cursor-agent"
  exit 1
fi

echo "Found $MODEL_COUNT models"

TMP_FILE="$(mktemp "${CONFIG_FILE}.tmp.XXXXXX")"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

python3 - "$CONFIG_FILE" "$TMP_FILE" "$MODELS_JSON" "$BASE_URL" <<'PY'
import json
import re
import sys
from pathlib import Path


def find_matching_brace(text: str, start_index: int) -> int:
    depth = 0
    in_string = False
    escaped = False

    for idx in range(start_index, len(text)):
        ch = text[idx]

        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return idx

    raise ValueError("Unmatched JSON braces")


config_path = Path(sys.argv[1])
tmp_path = Path(sys.argv[2])
models = json.loads(sys.argv[3])
base_url = sys.argv[4]
base_url_json = json.dumps(base_url, ensure_ascii=False)

original_text = config_path.read_text(encoding="utf-8")

cursor_key = re.search(r'"cursor-acp"\s*:\s*\{', original_text)
if not cursor_key:
    print("Error: provider.cursor-acp not found. Add cursor-acp provider before syncing.", file=sys.stderr)
    sys.exit(3)

cursor_obj_start = original_text.find("{", cursor_key.start())
cursor_obj_end = find_matching_brace(original_text, cursor_obj_start)
cursor_block = original_text[cursor_obj_start:cursor_obj_end + 1]

models_key = re.search(r'"models"\s*:\s*\{', cursor_block)
if not models_key:
    print("Error: provider.cursor-acp.models not found.", file=sys.stderr)
    sys.exit(4)

models_obj_start = cursor_block.find("{", models_key.start())
models_obj_end = find_matching_brace(cursor_block, models_obj_start)

line_start = cursor_block.rfind("\n", 0, models_key.start()) + 1
models_indent = re.match(r"[ \t]*", cursor_block[line_start:]).group(0)

old_models_object = cursor_block[models_obj_start:models_obj_end + 1]
entry_indent_match = re.search(r'\n([ \t]+)"[^"]+"\s*:', old_models_object)
if entry_indent_match:
    entry_indent = entry_indent_match.group(1)
else:
    entry_indent = f"{models_indent}  "

model_entries = list(models.items())
generated_lines = ["{"]
for index, (model_id, meta) in enumerate(model_entries):
    comma = "," if index < len(model_entries) - 1 else ""
    model_name = json.dumps(meta["name"], ensure_ascii=False)
    generated_lines.append(f'{entry_indent}"{model_id}": {{ "name": {model_name} }}{comma}')
generated_lines.append(f"{models_indent}}}")
new_models_object = "\n".join(generated_lines)

cursor_block = (
    cursor_block[:models_obj_start]
    + new_models_object
    + cursor_block[models_obj_end + 1:]
)

options_key = re.search(r'"options"\s*:\s*\{', cursor_block)
if options_key:
    options_obj_start = cursor_block.find("{", options_key.start())
    options_obj_end = find_matching_brace(cursor_block, options_obj_start)
    options_obj = cursor_block[options_obj_start:options_obj_end + 1]

    base_url_key = re.search(r'"baseURL"\s*:\s*"[^"]*"', options_obj)
    if base_url_key:
        options_obj = (
            options_obj[:base_url_key.start()]
            + f'"baseURL": {base_url_json}'
            + options_obj[base_url_key.end():]
        )
    else:
        if "\n" in options_obj:
            options_entry_indent_match = re.search(r'\n([ \t]+)"[^"]+"\s*:', options_obj)
            if options_entry_indent_match:
                options_entry_indent = options_entry_indent_match.group(1)
            else:
                options_entry_indent = f"{models_indent}  "
            inner = options_obj[1:-1].strip()
            options_prefix = options_obj[:-1].rstrip()
            comma = ""
            if inner and not options_prefix.endswith(","):
                comma = ","
            options_obj = options_prefix + f'{comma}\n{options_entry_indent}"baseURL": {base_url_json}\n{models_indent}}}'
        else:
            inner = options_obj[1:-1].strip()
            if inner:
                options_obj = '{ "baseURL": ' + base_url_json + ', ' + inner + " }"
            else:
                options_obj = '{ "baseURL": ' + base_url_json + ' }'

    cursor_block = (
        cursor_block[:options_obj_start]
        + options_obj
        + cursor_block[options_obj_end + 1:]
    )
else:
    models_key_after_replace = re.search(r'\n([ \t]*)"models"\s*:', cursor_block)
    if not models_key_after_replace:
        print("Error: Unable to locate models key for options insertion.", file=sys.stderr)
        sys.exit(5)

    property_indent = models_key_after_replace.group(1)
    insert_text = f'\n{property_indent}"options": {{ "baseURL": {base_url_json} }},'
    insert_pos = models_key_after_replace.start()
    cursor_block = cursor_block[:insert_pos] + insert_text + cursor_block[insert_pos:]

updated_text = (
    original_text[:cursor_obj_start]
    + cursor_block
    + original_text[cursor_obj_end + 1:]
)

try:
    json.loads(updated_text)
except json.JSONDecodeError as exc:
    print(f"Error: produced invalid JSON: {exc}", file=sys.stderr)
    sys.exit(6)

tmp_path.write_text(updated_text, encoding="utf-8")
PY

if cmp -s "$CONFIG_FILE" "$TMP_FILE"; then
  echo "No config changes needed"
  exit 0
fi

BACKUP_PATH="${CONFIG_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$CONFIG_FILE" "$BACKUP_PATH"
mv "$TMP_FILE" "$CONFIG_FILE"

echo "Updated $CONFIG_FILE with $MODEL_COUNT models"
echo "Backup written to $BACKUP_PATH"
echo ""
echo "Models synced:"
python3 - "$MODELS_JSON" <<'PY'
import json
import sys

models = json.loads(sys.argv[1])
keys = list(models.keys())
for model_id in keys[:10]:
    print(f"  - {model_id}")
if len(keys) > 10:
    print(f"  ... and {len(keys) - 10} more")
PY
