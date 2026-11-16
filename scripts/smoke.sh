#!/usr/bin/env bash
# Quick end-to-end check of the API against a running server: ./scripts/smoke.sh [base_url]
set -euo pipefail
B=${1:-http://localhost:3000}/api
j() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }
post() { local who=$1 path=$2 data=${3:-}; curl -s -XPOST -H "x-contributor-id: $who" -H 'content-type: application/json' ${data:+-d "$data"} "$B$path"; }

C=$(post 1 /claims); echo "claim:        $C"; T=$(echo "$C" | j token)
echo "resume:       $(post 1 /claims | j status) (same token: $([ "$(post 1 /claims | j token)" = "$T" ] && echo yes || echo NO))"
echo "heartbeat:    $(post 1 /claims/$T/heartbeat)"
echo "submit early: $(post 1 /recordings "{\"token\":\"$T\"}")"
U=$(post 1 /claims/$T/upload-url | j url)
TMP=$(mktemp); head -c 4096 /dev/urandom > "$TMP"
echo "upload PUT:   $(curl -s -o /dev/null -w '%{http_code}' -XPUT -H 'content-type: audio/wav' --data-binary @"$TMP" "$U")"; rm -f "$TMP"
echo "submit:       $(post 1 /recordings "{\"token\":\"$T\"}")"
echo "submit again: $(post 1 /recordings "{\"token\":\"$T\"}")"
echo "old token hb: $(post 1 /claims/$T/heartbeat)"
T2=$(post 2 /claims | j token)
echo "release:      $(curl -s -XPOST "$B/claims/$T2/release?contributor=2")"
echo "other user:   $(post 3 /claims/$T2/heartbeat)"
