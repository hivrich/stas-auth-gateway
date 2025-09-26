#!/usr/bin/env bash
set -euo pipefail
REL="/opt/releases/stas-auth-gateway-v2"
CUR="/opt/stas-auth-gateway-v2/current"
TS="$(date -u +%Y%m%d-%H%M%S)"
NEW="$REL/$TS"
sudo mkdir -p "$NEW"
# sync рабочие файлы
sudo rsync -a --delete --exclude node_modules --exclude var --exclude .git ./ "$NEW/"
# atomically switch
sudo ln -sfn "$NEW" "$CUR"
# dependencies (если нужны)
# sudo npm --prefix "$CUR" ci
# restart
systemctl --user restart stas-auth-gateway-v2.service
systemctl --user status  stas-auth-gateway-v2.service --no-pager -l
