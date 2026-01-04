# STAS — документация по серверной части (Auth Gateway v2 + DB Bridge) и инциденту 2026‑01‑04

Дата актуализации: 2026‑01‑04  
Хост (по логам/командам): `109.172.46.200` (hostname: `kfroudwslq`)  
Критичный пользователь для проверок: `user_id=95192039`

> Примечание по источникам: факты ниже собраны из CLI‑выводов в текущем чате (systemd/journalctl/curl/grep/git remote).
> Где информации недостаточно — отмечено явно как «требует проверки».

---

## 1) Цель документа

1. Зафиксировать «как должно быть» устроено взаимодействие **Auth Gateway v2 ↔ DB Bridge ↔ PostgreSQL ↔ Intervals.icu (ICU)**.
2. Зафиксировать **контракт API** DB‑слоя (trainings / activities_full) и минимальные smoke‑тесты.
3. Зафиксировать **инцидент 2026‑01‑04** (что сломалось, почему, как починили) и меры профилактики.
4. Дать **точный чек‑лист перед любыми изменениями** (чтобы больше не повторялось).

---

## 2) Текущая архитектура (3 слоя)

### 2.1 Auth / Access слой — Auth Gateway v2
Назначение:
- принимает внешние запросы (в т.ч. от GPT Actions / клиентов);
- проверяет авторизацию/скоупы;
- проксирует:
  - к DB Bridge (данные тренировок/сводки),
  - к ICU‑слою (Intervals.icu API).

Расположение (по `grep` и путям): `/opt/stas-auth-gateway-v2/current/`  
Ключевой маршрут (по найденным строкам):
- `GET /gw/api/db/trainings` → прокси к DB Bridge `http://127.0.0.1:3336/api/db/trainings`
- режим `full=1` в `routes/trainings.js` пытается ходить в `http://127.0.0.1:3336/api/db/activities_full`

Порты: точный внешний порт Gateway требует проверки на сервере (в коде и systemd). В логах/комментах встречается `3338` для GW‑роутов.

### 2.2 DB слой — STAS DB Bridge
Назначение:
- читает данные из PostgreSQL и отдаёт API для Gateway.

Текущее состояние на 2026‑01‑04:
- systemd unit: `/etc/systemd/system/stas-db-bridge.service`
- ExecStart: `/usr/bin/node /opt/stas-db-bridge/db_bridge.js`
- Listener: `127.0.0.1:3336` (подтверждено `ss -ltnp`)
- Healthcheck: `GET http://127.0.0.1:3336/healthz` → 200 + JSON `{ok:true, service:"stas-db-bridge", time:"..."}`
- Основной рабочий endpoint: `GET /api/db/trainings` (подтверждено curl)

**Важно:** каталог `/opt/stas-db-bridge` сейчас имеет git remote на `hivrich/stas-auth-gateway.git` и commit `a6237b3`. Это не совпадает с ожиданием «db‑bridge в отдельном репо» и является фактором риска (см. инцидент).

### 2.3 ICU слой — Intervals.icu интеграция
Назначение:
- читать/писать данные в Intervals.icu (events/workouts), при необходимости с дедупликацией и dry_run.

Факты из логов (старые, но наблюдались в systemd logs DB Bridge ранее):
- присутствуют строки вида:
  - `[icu][POST] exact /gw/icu/events with ICU write + dedupe enabled`
  - `Server running on port 3336`

На сервере также встречается сервис `mcp-bridge` (`/opt/mcp-bridge/app.js`), который ходит в Postgres и Intervals.icu.
Текущую роль `mcp-bridge` относительно Gateway/DB Bridge нужно перепроверить: это отдельный HTTP‑слой или исторический артефакт.

---

## 3) Контракт API DB Bridge (то, что должно оставаться стабильным)

### 3.1 Health
**GET** `/healthz`  
**200 OK**  
Пример ответа (факт):  
`{"ok":true,"service":"stas-db-bridge","time":"2026-01-04T08:53:58.885Z"}`

### 3.2 Trainings (основной endpoint)
**GET** `/api/db/trainings`

Параметры query:
- `user_id` (обязательный; integer)
- `limit` (опционально; integer, по умолчанию — разумное значение, рекомендуется 50)
- `oldest` (опционально; `YYYY-MM-DD`)
- `newest` (опционально; `YYYY-MM-DD`)

Ожидаемая семантика дат:
- окно `[oldest, newest]` должно быть **включающим** по дням (как минимум для `YYYY-MM-DD`), без «сюрпризов» по TZ.
- если `newest` отсутствует — отдаём до текущей даты/времени.
- если `oldest` отсутствует — отдаём последние N по `limit`.

Формат ответа (факт по curl):
```json
{
  "trainings": [
    {
      "id": "114050681",
      "date": "2025-12-27T10:48:19.000Z",
      "workout_type": "Run",
      "distance": "20.25",
      "user_report": "...",
      "ai_comment": "",
      "training_load": 105,
      "fitness": 36,
      "fatigue": 43,
      "elevation_gain": 132,
      "intensity": "75",
      "icu_hr_zones": "[142,151,159,168,173,178,186]",
      "avg_heartrate": 144,
      "max_heartrate": 173,
      "lactate_threshold_hr": 169,
      "moving_time": "1:50:34",
      "form": "-7",
      "user_id": 95192039,
      "pace": "5:34",
      "activity_name": "Лонг групповой (Heavy #3)",
      "session_type": "Easy"
    }
  ],
  "count": 1
}
```

Примечания:
- В `user_report` встречается HTML‑экранирование (например `&#44;`). Это либо хранение в БД, либо экранирование на выдаче. Если это мешает клиенту — нужно зафиксировать правило: либо всегда отдаём «как хранится», либо всегда отдаём декодированным.
- Некоторые поля строковые (`distance`, `intensity`, `icu_hr_zones`, `moving_time`, `pace`). Это допустимо, но контракт нужно закрепить (и не менять «молча»).

### 3.3 Activities Full (детальный endpoint)
**GET** `/api/db/activities_full`

Требование контракта:
- endpoint должен существовать **стабильно**, потому что Gateway v2 в режиме `full=1` пытается его использовать.
- если «полного» формата пока нет — допустим временный режим:
  - alias на `/api/db/trainings`,
  - или выдача тех же данных, но без падения и без 404.

Текущая реализация требует проверки (есть ли маршрут в `db_bridge.js`).

---

## 4) Конфигурация окружения (env)

DB Bridge использует `EnvironmentFile=/opt/stas-db-bridge/.env` (факт из systemd unit).

Минимально ожидаемые переменные для Postgres (по историческому коду и общему паттерну):
- `DB_HOST`
- `DB_PORT` (обычно 5432)
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_SSL` (`true|false`)

Плюс сервисные:
- `PORT` (если используется; сейчас фактически слушает 3336)
- возможно, флаги ICU‑слоя (если DB Bridge также проксирует ICU).

**Требование:** DB Bridge должен стартовать без `dotenv`‑пакета (не держать runtime‑зависимость от него), потому что systemd уже подгружает env из EnvironmentFile.

---

## 5) Деплой и эксплуатация (systemd)

### 5.1 Unit file (факт)
`/etc/systemd/system/stas-db-bridge.service`
- WorkingDirectory: `/opt/stas-db-bridge`
- EnvironmentFile: `/opt/stas-db-bridge/.env`
- ExecStart: `/usr/bin/node /opt/stas-db-bridge/db_bridge.js`
- Restart: always

### 5.2 Обязательный smoke‑чек после любого изменения
На сервере:
1) сервис поднят:
- `systemctl status stas-db-bridge.service --no-pager`
2) слушает loopback:
- `ss -ltnp | grep ':3336'`
3) health:
- `curl -sS http://127.0.0.1:3336/healthz`
4) trainings basic:
- `curl -sS "http://127.0.0.1:3336/api/db/trainings?user_id=95192039&limit=1"`
5) trainings window:
- `curl -sS "http://127.0.0.1:3336/api/db/trainings?user_id=95192039&oldest=2025-12-14&newest=2025-12-16&limit=50"`
6) activities_full:
- `curl -sS "http://127.0.0.1:3336/api/db/activities_full?user_id=95192039&limit=1"`

**Критерий:** ни один из вызовов не должен возвращать 404/500.

---

## 6) Инцидент 2026‑01‑04: «пропал DB‑слой / появились странные routes»

### 6.1 Симптомы
- Gateway/GW отдавал урезанные данные или 404 на ожидаемые endpoint’ы.
- Появилось ощущение «непонятно откуда взялся Activities Full», хотя на «рабочем» сервисе ранее «были просто Trainings».

### 6.2 Верифицированные факты, которые указывают на причину
1) Каталог `/opt/stas-db-bridge` оказался git‑репозиторием **stas-auth-gateway**:
- `git remote -v` → `hivrich/stas-auth-gateway.git`
- HEAD → `a6237b3`
2) systemd unit stas-db-bridge исторически запускал `/opt/stas-db-bridge/server.js`
3) По дереву `/opt` обнаружены «следы» разного поколения кода (много `*.bak`, `releases/...`, `clean`, `rollback`, `panic`).

Интерпретация (логическая гипотеза, самая вероятная):
- В какой-то момент в `/opt/stas-db-bridge` оказалась не та кодовая база (или была перезаписана), и сервис DB Bridge перестал содержать собственную реализацию чтения из Postgres, превратившись в «что-то другое» (прокси/заглушку).
- Из-за этого Gateway начинал ходить туда, но получал неполные ответы/404.

### 6.3 Что сделали, чтобы восстановить работоспособность
- В systemd unit stas-db-bridge переключили ExecStart на **новый entrypoint** `db_bridge.js`.
- `db_bridge.js` поднял HTTP‑сервер на `127.0.0.1:3336`, реализовал как минимум:
  - `/healthz`
  - `/api/db/trainings` (подтверждено фактическим ответом 200 и содержимым `trainings[]`)

Дополнительно:
- убрали обязательную зависимость от пакета `dotenv` (ошибка `Cannot find module 'dotenv'` ушла после правки и сервис стал `active (running)`).

### 6.4 Текущее состояние
По словам пользователя и по фактам curl:
- DB Bridge снова отвечает на `/api/db/trainings` и отдаёт данные из БД.
- фильтрация по датам работает (пример с `oldest=2025-12-14&newest=2025-12-16` дал корректную тренировку за 2025‑12‑14).

Требует проверки (чек‑лист выше):
- `/api/db/activities_full` (потому что Gateway v2 на него рассчитывает)
- остальные endpoint’ы DB‑слоя (если они есть: user_summary/plan и т.п.)

---

## 7) Профилактика (чтобы больше не «ломать работающий сервис»)

### 7.1 Жёсткое разделение репозиториев и каталогов
- `/opt/stas-db-bridge` должен быть либо отдельным репо `stas-db-bridge`, либо «release‑артефактом» (без git‑операций в прод‑каталоге).
- Нельзя, чтобы каталог DB Bridge имел remote на другой проект (`stas-auth-gateway`): это прямой путь к неконсистентным деплоям.

### 7.2 Только релизы, никакого «git pull в /opt/<service>»
Рекомендованный паттерн:
- `/opt/releases/<service>/<YYYYMMDD-HHMMSS>/` — immutable snapshot
- `/opt/<service>/current` — symlink на нужный релиз
- systemd ExecStart всегда указывает на `/opt/<service>/current/...`

### 7.3 Автоматический smoke‑скрипт перед рестартом
Добавить скрипт `bin/smoke_db_bridge.sh` и запускать:
- вручную перед рестартом,
- и/или в CI (если есть),
- и/или в `ExecStartPost=` (аккуратно, чтобы не зацикливать).

### 7.4 Логи и диагностика
- для DB Bridge включить явное логирование:
  - старт + слушаемый адрес/порт
  - факт подключения к БД (успешно/ошибка)
  - краткий лог на каждый запрос (method, path, user_id, статус, latency)

---

## 8) Что нужно закоммитить в git (минимальный набор)

1) `db_bridge.js` — текущий рабочий entrypoint DB Bridge.
2) `docs/STAS_SYSTEM.md` — этот документ (или аналог в вашем стиле).
3) `deploy/systemd/stas-db-bridge.service` — эталонный unit file (чтобы его не терять).
4) `bin/smoke_db_bridge.sh` — smoke‑тесты.

---

## 9) Команды для сохранения на GitHub (вариант «как есть на сервере»)

> Важно: **сейчас** `/opt/stas-db-bridge` пушит в `hivrich/stas-auth-gateway.git`.  
> Если это временно допустимо — ок. Если нет — нужно сначала исправить remote (это отдельная задача).

Последовательность:
1) создать отдельную ветку hotfix,
2) закоммитить файлы,
3) push ветки,
4) (опционально) открыть PR/merge по вашему процессу.

Команды (выполнять на сервере):
- `cd /opt/stas-db-bridge`
- `git status -sb`
- `git checkout -b hotfix/db-bridge-restore-2026-01-04`
- `git add db_bridge.js`
- (если добавляете docs/ и deploy/ — добавить их тоже)
- `git commit -m "hotfix(db-bridge): restore DB endpoints via db_bridge.js"`
- `git push -u origin hotfix/db-bridge-restore-2026-01-04`

---

## 10) Открытые вопросы (не закрываем без проверки)

1) Реально ли нужен `/api/db/activities_full` в DB Bridge (скорее да, из-за Gateway v2) и что он должен отдавать.
2) Где находится «правильный» исходник DB‑слоя (если он существовал как отдельный проект), и почему он исчез из `/opt/stas-db-bridge`.
3) Существуют ли ещё DB endpoint’ы (user_summary, plan, tokens, etc.) — их список нужно снять из Gateway openapi и сравнить с тем, что реально отдаёт DB Bridge.

---

Конец документа.
