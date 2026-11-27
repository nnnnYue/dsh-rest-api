#!/usr/bin/env bash
# End-to-end demo of the dsh-rest-api plugin.
# Usage: BASE=http://127.0.0.1:3080/rest/v1 [TOKEN=...] ./examples/demo.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3080/rest/v1}"
if [[ -n "${TOKEN:-}" ]]; then AUTH=(-H "Authorization: Bearer $TOKEN"); else AUTH=(); fi
DEMO_DIR="$(mktemp -d /tmp/dsh-rest-demo.XXXXXX)"

jqv() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=eval('j'+process.argv[1]);console.log(typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('<unparsed>')}})" "$1"; }

echo "=== health ==="
curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/health"; echo

echo "=== 1. register project ($DEMO_DIR) ==="
PROJECT=$(curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/projects" -H 'content-type: application/json' \
  -d "{\"path\": \"$DEMO_DIR\", \"title\": \"REST Demo\"}")
echo "$PROJECT"
PID=$(echo "$PROJECT" | jqv ".project.id")

echo "=== 2. create session in project ==="
SESSION=$(curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/projects/$PID/sessions" \
  -H 'content-type: application/json' -d '{"title": "Demo session"}')
echo "$SESSION"
SID=$(echo "$SESSION" | jqv ".sessionId")

echo "=== 3. async prompt ==="
curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/sessions/$SID/messages" \
  -H 'content-type: application/json' -d '{"text": "用一句话介绍你自己"}'; echo

echo "=== 4. SSE stream sample (5s) ==="
curl -s -N -m 5 "${AUTH[@]+${AUTH[@]}}" "$BASE/sessions/$SID/stream" | head -20 || true

echo "=== 5. create a skill ==="
curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/skills" -H 'content-type: application/json' -d '{
  "name": "demo-greeting",
  "description": "Greets the caller with a random fact",
  "whenToUse": "When the user asks for a greeting demo",
  "body": "# Demo Greeting\n\nRespond with one fun fact and a greeting."
}'; echo

echo "=== 6. skills visible to the session ==="
curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/sessions/$SID/skills" | head -c 300; echo

echo "=== 7. models catalog ==="
curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/models" | head -c 300; echo

echo "=== 7b. session-scoped model selection ==="
DEFAULT=$(curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/models/default")
PROVIDER=$(echo "$DEFAULT" | jqv ".selection.provider")
MODEL=$(echo "$DEFAULT" | jqv ".selection.model")
echo "default route: $PROVIDER / $MODEL"
# create a second session pinned to that route and effort
S2=$(curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/projects/$PID/sessions" \
  -H 'content-type: application/json' \
  -d "{\"provider\": \"$PROVIDER\", \"model\": \"$MODEL\", \"reasoningEffort\": \"max\"}")
echo "$S2"
SID2=$(echo "$S2" | jqv ".sessionId")
# effort-only patch, then read back the effective selection
curl -s "${AUTH[@]+${AUTH[@]}}" -X PATCH "$BASE/sessions/$SID2" \
  -H 'content-type: application/json' -d '{"reasoningEffort": "low"}'; echo
curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/sessions/$SID2" | jqv ".model"; echo

echo "=== 8. cancel anything running ==="
curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/sessions/$SID/cancel"; echo

echo "=== 9. projected messages (incl. tool parts) ==="
curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/sessions/$SID/messages" | head -c 400; echo

echo "=== 10. session state (title) + rename ==="
curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/sessions/$SID" | head -c 300; echo
curl -s "${AUTH[@]+${AUTH[@]}}" -X PATCH "$BASE/sessions/$SID" \
  -H 'content-type: application/json' -d '{"title": "Renamed demo"}'; echo

echo "=== 11. global stream sample (3s) ==="
curl -s -N -m 3 "${AUTH[@]+${AUTH[@]}}" "$BASE/stream" | head -10 || true

echo "=== 12. approvals (expect empty list; unknown id -> 404) ==="
curl -s "${AUTH[@]+${AUTH[@]}}" "$BASE/approvals"; echo
curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/approvals/00000000-0000-0000-0000-000000000000/respond" \
  -H 'content-type: application/json' -d '{"outcome": "rejected"}'; echo

echo "=== 13. open the session in a WebUI panel (reason=no-client when none) ==="
# Open http://127.0.0.1:3080/?dshTarget=demo-panel first to see opened=true + ackedBy.
curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/sessions/$SID/open" \
  -H 'content-type: application/json' -d '{"target":"demo-panel","wait":true,"timeoutMs":1000}'; echo
curl -s "${AUTH[@]+${AUTH[@]}}" -X POST "$BASE/sessions/00000000-0000-0000-0000-000000000000/open" \
  -o /dev/null -w 'unknown session -> HTTP %{http_code}\n'

echo "=== cleanup: archive sessions + unregister project ==="
curl -s "${AUTH[@]+${AUTH[@]}}" -X DELETE "$BASE/sessions/$SID"; echo
curl -s "${AUTH[@]+${AUTH[@]}}" -X DELETE "$BASE/sessions/$SID2"; echo
curl -s "${AUTH[@]+${AUTH[@]}}" -X DELETE "$BASE/projects/$PID"; echo
rm -rf "$DEMO_DIR"

echo "demo complete."
