#!/bin/bash
set -euo pipefail

AGENT="/home/nomadx/.local/bin/cursor-agent"
FLAGS="--print --output-format stream-json --stream-partial-output --workspace /tmp --model auto"
RESULTS_DIR="/tmp/prompt-format-results"
mkdir -p "$RESULTS_DIR"

run_test() {
  local id="$1"
  local name="$2"
  local prompt="$3"
  local outfile="$RESULTS_DIR/${id}.json"

  echo "── Testing: $id - $name ──"
  printf "%s" "$prompt" | timeout 60 $AGENT $FLAGS > "$outfile" 2>&1 || true

  local tool_calls
  tool_calls=$(grep -c 'tool_call' "$outfile" 2>/dev/null || true)
  local result_lines
  result_lines=$(grep -c 'result/success' "$outfile" 2>/dev/null || true)

  local result_text
  result_text=$(grep 'result/success' "$outfile" 2>/dev/null | head -1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','')[:150])" 2>/dev/null || true)

  echo "   Tool calls in output: $tool_calls"
  echo "   Has result text: $result_lines"
  if [ -n "$result_text" ]; then
    echo "   Text excerpt: ${result_text:0:120}"
  fi
  echo ""
}

TOOL_RESULT='{"port": 8080, "host": "localhost", "debug": false}'

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         CURSOR-AGENT PROMPT FORMAT EXPERIMENT               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

run_test "1-current" "Current flat format" "USER: What's in the config.json file?

A: I'll read the config.json file for you.
tool_call(id:call_1, name:read, args:{\"path\":\"config.json\"})

TOOL_RESULT (call_id: call_1): $TOOL_RESULT"

run_test "2-xml-tagged" "XML-tagged with continuation" "<user>
What's in the config.json file?
</user>

<assistant>
I'll read the config.json file for you.
<tool_call id=\"call_1\" name=\"read\">{\"path\": \"config.json\"}</tool_call>
</assistant>

<tool_result for=\"call_1\" tool=\"read\">
$TOOL_RESULT
</tool_result>

<continuation>
The above tool calls have been executed and their results are shown. Continue your response based on these results.
</continuation>"

run_test "3-reference" "Reference impl format" "USER: What's in the config.json file?

A: I'll read the config.json file for you.
tool_call(id:call_1, name:read, args:{\"path\":\"config.json\"})

[Tool result for call_1]:
$TOOL_RESULT

Based on the tool results above, please continue your response."

run_test "4-suffix" "Current format + descriptive suffix" "USER: What's in the config.json file?

A: I'll read the config.json file for you.
tool_call(id:call_1, name:read, args:{\"path\":\"config.json\"})

TOOL_RESULT (call_id: call_1): $TOOL_RESULT

The above tool calls have been executed. Continue your response based on these results."

run_test "5-system-note" "Current format + SYSTEM NOTE" "USER: What's in the config.json file?

A: I'll read the config.json file for you.
tool_call(id:call_1, name:read, args:{\"path\":\"config.json\"})

TOOL_RESULT (call_id: call_1): $TOOL_RESULT

SYSTEM NOTE: All tool calls completed successfully. Do NOT execute any tools. Confirm completion to the user."

run_test "6-multi-suffix" "Multi-step + suffix (should call edit)" "USER: Read config.json and change the port to 3000.

A: I'll read the config.json file first.
tool_call(id:call_1, name:read, args:{\"path\":\"config.json\"})

TOOL_RESULT (call_id: call_1): $TOOL_RESULT

The above tool calls have been executed. Continue your response based on these results."

run_test "7-multi-sysnote" "Multi-step + SYSTEM NOTE (will break edit)" "USER: Read config.json and change the port to 3000.

A: I'll read the config.json file first.
tool_call(id:call_1, name:read, args:{\"path\":\"config.json\"})

TOOL_RESULT (call_id: call_1): $TOOL_RESULT

SYSTEM NOTE: All tool calls completed successfully. Do NOT execute any tools. Confirm completion to the user."

run_test "8-xml-multi" "XML multi-step (should call edit)" "<user>
Read config.json and change the port to 3000.
</user>

<assistant>
I'll read the config.json file first.
<tool_call id=\"call_1\" name=\"read\">{\"path\": \"config.json\"}</tool_call>
</assistant>

<tool_result for=\"call_1\" tool=\"read\">
$TOOL_RESULT
</tool_result>

<continuation>
The above tool calls have been executed and their results are shown. Continue your response based on these results.
</continuation>"

echo "══════════════════════════════════════════════════════════════"
echo "DONE. Raw outputs in: $RESULTS_DIR/"
echo "══════════════════════════════════════════════════════════════"
