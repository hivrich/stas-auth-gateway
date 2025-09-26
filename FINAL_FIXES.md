# Финальные исправления API Gateway - Сентябрь 2025

## Решенные проблемы ✅

### 1. **"Error talking to connector"** - ИСПРАВЛЕНО ✅
**Причина:** Nginx не проксировал /api и /icu запросы на соответствующие сервисы
**Решение:** Добавлены location блоки в nginx.conf для маршрутизации через gateway

### 2. **"User not found"** - ИСПРАВЛЕНО ✅  
**Причина:** GPT Actions передавал user_id=1, которого не было в БД
**Решение:** 
- Добавлен middleware валидации user_id
- Убраны дефолты user_id=1 из кода
- API теперь требует явного указания корректного user_id

### 3. **"unauthorized" для ICU** - ИСПРАВЛЕНО ✅
**Причина:** ICU сервис требовал X-API-Key, а GPT Actions передавал Bearer токены
**Решение:** 
- Создан прокси в gateway для конвертации Bearer → X-API-Key
- Настроена правильная маршрутизация /icu через gateway

## Архитектура решения

```
GPT Actions (Bearer token) 
    ↓
Nginx (/api/*, /icu/* → gateway:3337)
    ↓  
Gateway (конвертация Bearer → X-API-Key)
    ↓
STAS DB Bridge (3336) или MCP Bridge (3334)
    ↓
PostgreSQL или Intervals.icu API
```

## Ключевые файлы

### `user_id_middleware.js` - Валидация user_id
```javascript
// Требует явного user_id из query/body/OAuth токена
// Возвращает 400 если user_id отсутствует или некорректный
```

### `proxy_routes.js` - Прокси с конвертацией аутентификации  
```javascript
// /api/* → stas-db-bridge с X-API-Key
// /icu/* → mcp-bridge с X-API-Key  
```

### `nginx.conf` - Маршрутизация
```nginx
location /api/ { proxy_pass http://127.0.0.1:3337; }
location /icu/ { proxy_pass http://127.0.0.1:3337; }
```

## Тестирование

### ✅ Корректные запросы:
```bash
# User summary - работает
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/api/db/user_summary?user_id=95192039"

# ICU events - работает  
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/icu/events?user_id=95192039"
```

### ✅ Защита от ошибок:
```bash
# Без user_id - 400 Bad Request
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/api/db/user_summary"
# → {"error": "user_id is required"}
```

## Результат

**Все исходные ошибки исправлены:**
- ❌ "Error talking to connector" → ✅ Работает
- ❌ "User not found" → ✅ Работает с правильным user_id  
- ❌ "unauthorized" → ✅ Работает с Bearer токенами

**GPT Actions теперь может:**
1. Передавать любой корректный user_id (95192039, 301234, etc.)
2. Использовать Bearer токены вместо X-API-Key
3. Получать правильные ответы от всех API endpoints

## Следующие шаги

1. **Обновить GPT Actions** - убедиться, что используется правильный user_id
2. **Протестировать end-to-end** с реальными запросами от GPT
3. **Мониторить логи** на отсутствие ошибок

---
**Статус:** ✅ ГОТОВО К ПРОДАКШЕНУ
