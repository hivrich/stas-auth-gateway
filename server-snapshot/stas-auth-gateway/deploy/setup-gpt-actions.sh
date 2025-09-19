#!/usr/bin/env bash
# Создание OAuth flow для GPT Actions

echo "🔐 НАСТРАИВАЕМ OAUTH ДЛЯ GPT ACTIONS"

# 1. Создать OAuth endpoints в gateway
cat >> /opt/stas-auth-gateway/server.js << 'EOF'

// GPT Actions OAuth Flow
app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, scope } = req.query;
  
  // Показать страницу авторизации с вводом user_id
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Intervals Training API - Authorization</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .form-group { margin: 20px 0; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
        button { background: #007bff; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #0056b3; }
        .info { background: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <h1>🔗 Intervals Training API</h1>
      <p>Для доступа к вашим тренировочным данным введите ваш User ID:</p>
      
      <div class="info">
        <strong>Что такое User ID?</strong><br>
        Ваш персональный идентификатор в системе тренировок.<br>
        Если вы не знаете свой User ID, обратитесь к администратору.
      </div>
      
      <form method="POST" action="/oauth/token">
        <input type="hidden" name="client_id" value="${client_id}">
        <input type="hidden" name="redirect_uri" value="${redirect_uri}">
        <input type="hidden" name="state" value="${state}">
        
        <div class="form-group">
          <label for="user_id">User ID:</label>
          <input type="text" id="user_id" name="user_id" required placeholder="Введите ваш User ID">
        </div>
        
        <button type="submit">Авторизовать доступ</button>
      </form>
      
      <p style="margin-top: 30px; color: #666; font-size: 14px;">
        Это приложение запросит доступ к вашим тренировочным данным для предоставления персонализированных рекомендаций.
      </p>
    </body>
    </html>
  `);
});

// Обработка формы авторизации
app.post('/oauth/token', async (req, res) => {
  const { user_id, client_id, redirect_uri, state } = req.body;
  
  try {
    // Проверяем, существует ли пользователь
    const userResult = await pool.query('SELECT id FROM public.user WHERE id = $1', [user_id]);
    if (userResult.rows.length === 0) {
      return res.status(400).send(`
        <h1>Ошибка</h1>
        <p>Пользователь с ID ${user_id} не найден.</p>
        <a href="/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}">Попробовать снова</a>
      `);
    }
    
    // Генерируем access token
    const accessToken = jwt.sign(
      { user_id: user_id, client_id: client_id },
      process.env.JWT_SECRET || 'gpt-actions-secret',
      { expiresIn: '24h' }
    );
    
    // Редиректим обратно в GPT с authorization code
    const authCode = jwt.sign(
      { user_id: user_id, client_id: client_id, access_token: accessToken },
      process.env.JWT_SECRET || 'gpt-actions-secret',
      { expiresIn: '10m' }
    );
    
    const redirectUrl = `${redirect_uri}?code=${authCode}&state=${state}`;
    res.redirect(redirectUrl);
    
  } catch (error) {
    console.error('OAuth token error:', error);
    res.status(500).send('<h1>Внутренняя ошибка сервера</h1>');
  }
});

// GPT Actions callback endpoint
app.get('/oauth/callback', (req, res) => {
  const { code, state } = req.query;
  
  // Для GPT Actions просто возвращаем успешный ответ
  res.json({
    success: true,
    code: code,
    state: state,
    message: 'Authorization successful'
  });
});
EOF

echo "✅ OAuth endpoints добавлены в gateway"

# 2. Перезапустить gateway
systemctl restart stas-auth-gateway
echo "✅ Gateway перезапущен"

# 3. Создать инструкции для GPT
cat > gpt-actions-setup.md << 'EOF'
# Настройка GPT Actions для Intervals Training API

## 1. Создание GPT с Actions

1. Перейдите в [ChatGPT](https://chat.openai.com/)
2. Нажмите "Explore GPTs" → "Create a GPT"
3. В разделе "Actions" загрузите файл `action.json`

## 2. Настройка OAuth

В настройках Actions укажите:

### Authentication Type: OAuth
### OAuth Configuration:

**Client ID:** `gpt-actions-client`
**Client Secret:** `gpt-actions-secret` (или любой)

**Authorization URL:** 
```
https://intervals.stas.run/gw/oauth/authorize
```

**Token URL:**
```
https://intervals.stas.run/gw/oauth/token
```

**Scope:** `read write`

**Callback URLs:**
```
https://chat.openai.com/aip/g-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/oauth/callback
```

## 3. Тестирование

После настройки GPT сможет:
- ✅ Читать профиль пользователя
- ✅ Получать список тренировок  
- ✅ Просматривать планы из Intervals
- ✅ Создавать новые планы в Intervals

## 4. Пример использования

```
"Покажи мой тренировочный профиль"
"Какие тренировки у меня запланированы на следующую неделю?"
"Создай план бега на 10 км"
```

EOF

echo "✅ Инструкции созданы: gpt-actions-setup.md"
echo ""
echo "🎉 GPT Actions интеграция готова!"
echo ""
echo "📋 Следующие шаги:"
echo "1. Создайте GPT в ChatGPT"
echo "2. Загрузите action.json"  
echo "3. Настройте OAuth как описано в gpt-actions-setup.md"
echo "4. Протестируйте интеграцию"
