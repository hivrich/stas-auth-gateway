#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run on the canonical host only after the separately approved source sync and
# app migration. No unguarded compose-up recipe is a supported release path.
if [[ "$#" -ne 1 || "$1" != --apply ]]; then
  echo 'Usage: bash scripts/deploy-prod-gateway.sh --apply (requires explicit deploy approval)' >&2
  exit 2
fi
app_dir="${STAS_APP_DIR:-/opt/stas}"
lock_file="${STAS_DEPLOY_LOCK_FILE:-/tmp/stas-prod-deploy.lock}"
cd "$app_dir"
exec 9>"$lock_file"
flock -n 9 || { echo '[gateway-deploy] deploy_lock_busy' >&2; exit 1; }
compose=(docker compose --project-directory "$app_dir" --project-name stas --env-file "$app_dir/.env" --file "$app_dir/docker-compose.yml")
"${compose[@]}" config --quiet
config_hash="$("${compose[@]}" config --hash bridge-api)"
"${compose[@]}" build bridge-api
# Compose's --images bridge-api also includes dependency images. Resolve only
# this service; never print the effective config (it contains credentials).
candidate_ref="$("${compose[@]}" config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); print(c["services"]["bridge-api"].get("image") or c["name"]+"-bridge-api")')"
[[ "$candidate_ref" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$ ]] || { echo '[gateway-deploy] candidate_image_unresolved' >&2; exit 1; }
candidate_id="$(docker image inspect --format '{{.Id}}' "$candidate_ref")"
[[ "$candidate_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo '[gateway-deploy] candidate_digest_invalid' >&2; exit 1; }

release_dir="$(mktemp -d /tmp/stas-gateway-release.XXXXXXXX)"
override_file="$release_dir/candidate.yml"
trap 'rm -f "$override_file"; rmdir "$release_dir"' EXIT
printf 'services:\n  bridge-api:\n    image: "%s"\n' "$candidate_id" > "$override_file"
candidate_compose=("${compose[@]}" --file "$override_file")
echo '[gateway-deploy] checking_candidate_database_readiness'
"${candidate_compose[@]}" run --rm --no-deps --entrypoint node bridge-api /app/scripts/check-oauth-replay-readiness.js
[[ "$("${compose[@]}" config --hash bridge-api)" == "$config_hash" ]] || { echo '[gateway-deploy] runtime_config_changed' >&2; exit 1; }

echo '[gateway-deploy] replacing_gateway_with_verified_candidate'
"${candidate_compose[@]}" up -d --no-deps --no-build --force-recreate bridge-api
container_id="$("${candidate_compose[@]}" ps -q bridge-api)"
[[ "$(docker inspect --format '{{.Image}}' "$container_id")" == "$candidate_id" ]] || { echo '[gateway-deploy] running_image_mismatch' >&2; exit 1; }
curl --fail --silent --show-error --max-time 10 --retry 15 --retry-delay 2 --retry-connrefused https://intervals.stas.run/gw/healthz >/dev/null
echo '[gateway-deploy] health_passed_checking_public_discovery'
"${candidate_compose[@]}" run --rm --no-deps --entrypoint node bridge-api /app/scripts/check-private-key-jwt-discovery.js --wait-seconds 360
echo '[gateway-deploy] release_verified'
