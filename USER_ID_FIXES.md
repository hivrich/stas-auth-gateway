# Исправление проблемы user_id=1 - Сентябрь 2025

## Проблема
GPT Actions передавал корректный user_id, но gateway использовал user_id=1 по умолчанию, что приводило к ошибкам:
- "User not found" - пользователь с id=1 отсутствовал в БД
- "unauthorized" - отсутствовали ICU ключи для user_id=1

## Исправления

### 1. Добавлен middleware валидации user_id
**Файл: `user_id_middleware.js`**
- Обязательная валидация user_id из query/body/OAuth токена
- Возврат 400 ошибки при отсутствии или некорректном user_id
- Предотвращение использования дефолтов

### 2. Обновлены API маршруты
**Файл: `server.js`**
- `/api/db/user_summary` использует `validateUserId` middleware
- `/icu/events` использует `validateUserId` middleware
- Убраны ручные проверки `parseInt(user_id, 10)`

### 3. Исправлен OAuth flow
- Заменен дефолт `user_id || ''` на `user_id || 'unknown'`
- Улучшена читаемость логов

### 4. Улучшен health check
- Агрегированный `/gw/healthz` с проверкой сервисов
- Тестирование STAS и ICU API
- Возможность указать `test_user_id` для проверки

## Тестирование исправлений

### ✅ Корректный user_id работает:
```bash
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/api/db/user_summary?user_id=95192039"
# Возвращает: 200 OK с данными пользователя
```

### ✅ Отсутствие user_id возвращает ошибку:
```bash
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/api/db/user_summary"
# Возвращает: 400 Bad Request "user_id is required"
```

### ✅ Некорректный user_id возвращает ошибку:
```bash
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/api/db/user_summary?user_id=abc"
# Возвращает: 400 Bad Request "Invalid user_id format"
```

## Доступные пользователи для тестирования:
- `user_id=95192039` ✅ (полные данные + ICU ключ)
- `user_id=301234` ✅ (тестовый ICU ключ)

## Следующие шаги:
1. **Обновить GPT Actions** - убедиться, что user_id передается корректно
2. **Протестировать полный flow** с реальными данными
3. **Мониторить логи** на отсутствие ошибок user_id

## Файлы изменений:
- `server.js` - обновлены маршруты и OAuth
- `user_id_middleware.js` - новый middleware валидации
- `API_FIXES.md` - предыдущие исправления

**Результат:** Устранена проблема "левого user_id=1", API теперь требует явного указания корректного user_id.
