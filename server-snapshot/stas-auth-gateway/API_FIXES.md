# Исправления API Gateway - Сентябрь 2025

## Проблемы, которые были исправлены:

### 1. Добавлены недостающие API маршруты
- `/api/db/user_summary` - получение данных пользователя из БД
- `/icu/events` - проксирование запросов к Intervals.icu API
- Добавлена JWT аутентификация для защиты API

### 2. Исправлены ошибки авторизации
- **"User not found"** - исправлено использованием существующих пользователей
- **"unauthorized"** - исправлено добавлением ICU API ключей для пользователей

### 3. Существующие пользователи для тестирования:
- `user_id=95192039` ✅ (полные данные + ICU ключ)
- `user_id=301234` ✅ (тестовый ICU ключ добавлен)

### 4. Рабочие API endpoints:

#### STAS API (с X-API-Key: 7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27)
```bash
curl "https://intervals.stas.run/api/db/user_summary?user_id=95192039"
curl "https://intervals.stas.run/api/db/activities?user_id=95192039&days=30"
```

#### ICU API (с X-API-Key: e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64)
```bash
curl "https://intervals.stas.run/icu/events?user_id=95192039"
curl "https://intervals.stas.run/icu/activities?user_id=95192039&days=14"
```

### 5. Gateway health check:
```bash
curl "https://intervals.stas.run/gw/healthz"
```

## Следующие шаги:

1. **Исправить GPT Actions конфигурацию:**
   - Заменить `user_id=1` на `user_id=95192039` в API вызовах
   - Проверить OAuth flow и redirect URLs

2. **Протестировать все endpoints** с реальными данными

3. **Мониторить логи** на отсутствие ошибок "User not found" и "unauthorized"
