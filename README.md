# STAS Auth Gateway v2

Продовый шлюз к Intervals.icu.

## Что в этом коммите

- DELETE /gw/icu/events: оконный запрос (external_id_prefix + oldest + newest)
  перехватывается shim'ом и преобразуется в per-ID удаление.
  Для OAuth используется bulk-delete на стороне Intervals.
- POST/GET не менялись, проброс и точные ручки на месте.

## Env

- PORT — порт шлюза (прод: 3338)
- STAS_BASE — http://127.0.0.1:3336 (DB-bridge)
- STAS_KEY или STAS_KEY_FILE — API-key для DB-bridge
- INTERVALS_API_BASE_URL — https://intervals.icu/api/v1

## Запуск

    env STAS_BASE="http://127.0.0.1:3336" STAS_KEY="***" INTERVALS_API_BASE_URL="https://intervals.icu/api/v1" PORT=3338 \
      node server.js

## Systemd / Nginx

Смотрите примеры в contrib/systemd/*.service.example и contrib/nginx/*.example.
Секреты/сертификаты не входят в репозиторий.
