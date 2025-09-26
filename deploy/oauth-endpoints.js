// Исправленный OAuth flow для GPT Actions
app.get('/gw/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, scope, response_type } = req.query;

  // Поддержка только authorization_code flow
  if (response_type && response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }

  // Показать страницу авторизации
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
      <div class="info">
        <strong>OAuth Authorization</strong><br>
        Приложение запрашивает доступ к вашим тренировочным данным.
      </div>

      <form method="POST" action="/gw/oauth/token">
        <input type="hidden" name="client_id" value="${client_id || 'gpt-actions'}">
        <input type="hidden" name="redirect_uri" value="${redirect_uri || 'https://chat.openai.com/callback'}">
        <input type="hidden" name="state" value="${state || 'test'}">
        <input type="hidden" name="response_type" value="${response_type || 'code'}">

        <div class="form-group">
          <label for="user_id">Введите ваш User ID:</label>
          <input type="text" id="user_id" name="user_id" required placeholder="Например: 95192039">
        </div>

        <button type="submit">Авторизовать</button>
      </form>
    </body>
    </html>
  `);
});

// Исправленный OAuth token endpoint
app.post('/gw/oauth/token', async (req, res) => {
  const { user_id, client_id, redirect_uri, state, grant_type, code } = req.body;

  try {
    // Генерируем access token
    const accessToken = jwt.sign(
      {
        user_id: user_id || 95192039,
        client_id: client_id || 'gpt-actions',
        scope: 'read write'
      },
      process.env.JWT_SECRET || 'gpt-actions-secret',
      { expiresIn: '24h' }
    );

    // Возвращаем token response для GPT
    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 86400,
      scope: 'read write'
    });

  } catch (error) {
    console.error('OAuth token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GPT callback endpoint
app.get('/gw/oauth/callback', (req, res) => {
  res.json({
    success: true,
    message: 'GPT Actions OAuth callback successful'
  });
});
