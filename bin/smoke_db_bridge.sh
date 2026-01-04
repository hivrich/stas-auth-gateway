#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3336}"
USER_ID="${USER_ID:-95192039}"

echo "== healthz =="
curl -sS -i "$BASE/healthz" | sed -n '1,20p'
echo

echo "== trainings (limit=1) =="
curl -sS -i "$BASE/api/db/trainings?user_id=$USER_ID&limit=1" | sed -n '1,60p'
echo

echo "== trainings window example (2025-12-14..2025-12-16) =="
curl -sS -i "$BASE/api/db/trainings?user_id=$USER_ID&oldest=2025-12-14&newest=2025-12-16&limit=50" | sed -n '1,80p'
echo

echo "== activities_full (limit=1) [must not be 404] =="
curl -sS -i "$BASE/api/db/activities_full?user_id=$USER_ID&limit=1" | sed -n '1,60p'
echo

echo "OK: smoke finished"
