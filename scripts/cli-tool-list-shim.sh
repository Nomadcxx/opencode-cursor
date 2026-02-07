#!/usr/bin/env bash
# Minimal shim to emit OpenCode tools as JSON using opencode debug skill (non-JSON), for environments without tool.list
# Usage: CURSOR_ACP_TOOL_EXECUTOR=cli OPENCODE_TOOL_LIST_SHIM=/path/to/this ./opencode ...
set -euo pipefail
TOOLS=$(opencode debug skill 2>/dev/null)
# naive extraction: this produces a JSON array of names only
# Warning: best-effort; not a full schema.
if [[ -z "$TOOLS" ]]; then
  echo '{"data":{"tools":[]}}'
  exit 0
fi
# Grab lines that look like "  {" to detect JSON already
if echo "$TOOLS" | grep -q '"name"'; then
  echo "$TOOLS"
  exit 0
fi
# Otherwise convert to array of objects with id=name
NAMES=$(echo "$TOOLS" | sed -n 's/^  *"name": *"\(.*\)".*/\1/p')
if [[ -z "$NAMES" ]]; then
  # fall back to simple list (lines between [ and ])
  NAMES=$(echo "$TOOLS" | sed -n 's/^ *"\(.*\)".*/\1/p')
fi
printf '{"data":{"tools":['
first=1
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if [[ $first -eq 0 ]]; then printf ','; fi
  printf '{"id":"%s","description":"(shimmed skill)","parameters":{"type":"object","properties":{}}}' "${name//"/\"}"
  first=0
done <<< "$NAMES"
printf ']}}'
