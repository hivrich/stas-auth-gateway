# Обновление GPT Actions - Использование правильного user_id

## Шаг 1: Найти GPT Actions в интерфейсе OpenAI

1. Перейдите на https://platform.openai.com/
2. Войдите в свой аккаунт
3. Выберите **"Assistants"** в левом меню
4. Найдите вашего Assistant'а с intervals.stas.run
5. Нажмите **"Edit"** или откройте настройки Assistant'а

## Шаг 2: Найти и изменить API Schema

1. В настройках Assistant'а найдите раздел **"Functions"** или **"Tools"**
2. Найдите функцию/endpoint, которая вызывает intervals.stas.run API
3. Откройте **JSON Schema** или **API Specification** для этой функции

## Шаг 3: Найти и заменить user_id=1

В JSON схеме найдите параметр `user_id` и замените:

### Было:
```json
{
  "name": "getUserSummary",
  "parameters": {
    "type": "object",
    "properties": {
      "user_id": {
        "type": "integer",
        "description": "User ID",
        "default": 1
      }
    }
  }
}
```

### Стало:
```json
{
  "name": "getUserSummary", 
  "parameters": {
    "type": "object",
    "properties": {
      "user_id": {
        "type": "integer",
        "description": "User ID from the system",
        "enum": [95192039, 301234],
        "default": 95192039
      }
    },
    "required": ["user_id"]
  }
}
```

## Шаг 4: Аналогично для всех ICU функций

Замените во всех функциях:

### getPlannedWorkouts:
```json
{
  "user_id": {
    "type": "integer", 
    "description": "User ID from the system",
    "enum": [95192039, 301234],
    "default": 95192039
  }
}
```

### getUserTrainings:
```json
{
  "user_id": {
    "type": "integer",
    "description": "User ID from the system", 
    "enum": [95192039, 301234],
    "default": 95192039
  }
}
```

## Шаг 5: Сделать user_id обязательным

Убедитесь, что `user_id` находится в массиве `required`:

```json
{
  "required": ["user_id"]
}
```

## Шаг 6: Проверить изменения

1. Сохраните изменения в GPT Actions
2. Перейдите в **Playground** или **Chat** интерфейс
3. Протестируйте запросы типа:

```
Get my training summary
Show my planned workouts  
Get my recent trainings
```

4. Проверьте, что API получает правильный user_id (95192039 или 301234)

## Шаг 7: Альтернативный способ (через код)

Если вы используете Actions через API, обновите код:

```javascript
// Было:
const response = await openai.chat.completions.create({
  messages: [{
    role: "user", 
    content: "Get training summary"
  }],
  functions: [{
    name: "getUserSummary",
    parameters: {
      user_id: 1  // ❌ УБРАТЬ!
    }
  }]
});

// Стало:
const response = await openai.chat.completions.create({
  messages: [{
    role: "user",
    content: "Get training summary" 
  }],
  functions: [{
    name: "getUserSummary",
    parameters: {
      user_id: 95192039  // ✅ ПРАВИЛЬНЫЙ user_id
    }
  }]
});
```

## Шаг 8: Тестирование через Playground

1. В Playground введите: *"What's my training summary?"*
2. GPT должен автоматически вызвать функцию с user_id=95192039
3. Проверьте логи сервера - запрос должен дойти и вернуть данные

## Возможные проблемы и решения

### Проблема 1: GPT всё еще использует user_id=1
**Решение:** Убедитесь, что удалили все дефолты из JSON схемы

### Проблема 2: "User not found" 
**Решение:** Используйте только user_id из списка: 95192039, 301234

### Проблема 3: Изменения не применяются
**Решение:** 
- Сохраните Assistant
- Перезагрузите Playground
- Создайте нового Assistant'а если проблема persists

## Проверка работы

После обновления GPT Actions должен:

✅ Передавать user_id=95192039 (или 301234) вместо 1  
✅ Получать успешные ответы от API  
✅ Не выдавать ошибки "User not found"  
✅ Корректно работать со всеми endpoints

## Тестирование API напрямую

Пока обновляете GPT Actions, можете протестировать API:

```bash
# User summary
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/api/db/user_summary?user_id=95192039"

# Planned workouts  
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/icu/events?user_id=95192039"

# Recent trainings
curl -H "Authorization: Bearer <token>" \
  "https://intervals.stas.run/api/db/activities?user_id=95192039&days=30"
```

Все запросы должны возвращать корректные данные без ошибок!
