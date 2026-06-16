#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${GW_BASE_URL:-https://intervals.stas.run}"
CALLBACK="${GW_CHATGPT_CALLBACK:-https://chat.openai.com/aip/g-0e683685e67e111ebd51aa7d6b2be34f380bb37f/oauth/callback}"
SCOPE="${GW_INTERVALS_SCOPE:-ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,CHATS:WRITE,LIBRARY:WRITE,SETTINGS:WRITE}"

authorize_url="${BASE_URL}/gw/oauth/authorize?response_type=code&client_id=&redirect_uri=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$CALLBACK")&state=smoke&scope=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$SCOPE")"

headers="$(mktemp)"
body="$(mktemp)"
cleanup() {
  rm -f "$headers" "$body"
}
trap cleanup EXIT

status="$(
  curl -sS -D "$headers" -o "$body" -w '%{http_code}' "$authorize_url"
)"

location="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {sub(/\r$/, ""); print substr($0, index($0, ":") + 2)}' "$headers" | tail -1)"

if [[ "$status" != "302" ]]; then
  echo "Expected 302 from GPT OAuth authorize, got ${status}" >&2
  echo "Response body:" >&2
  sed -n '1,40p' "$body" >&2
  exit 1
fi

if [[ "$location" != https://intervals.icu/oauth/authorize* ]]; then
  echo "Expected redirect to intervals.icu OAuth, got: ${location}" >&2
  exit 1
fi

redirect_uri="$(node -e "const u=new URL(process.argv[1]); process.stdout.write(u.searchParams.get('redirect_uri') || '')" "$location")"

if [[ "$redirect_uri" != "${BASE_URL}/gw/oauth/callback" ]]; then
  echo "Expected Intervals redirect_uri to be gateway callback, got: ${redirect_uri}" >&2
  exit 1
fi

if [[ "$location" == *"chat.openai.com%2Faip"* || "$location" == *"chatgpt.com%2Faip"* ]]; then
  echo "Intervals authorize URL must not contain ChatGPT callback directly: ${location}" >&2
  exit 1
fi

if [[ "$location" == *"client_id=&"* || "$location" == *"client_id=" ]]; then
  echo "Expected non-empty Intervals client_id in redirect, got: ${location}" >&2
  exit 1
fi

echo "GPT OAuth smoke passed: ${location}"
