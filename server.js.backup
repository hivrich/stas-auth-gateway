const http = require('http');

// JWT decode function
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload;
  } catch (e) {
    return null;
  }
}

// Auth middleware
function requireAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return null;
  }
  
  const token = auth.slice(7);
  
  // Если токен выглядит как JWT (содержит точки), парсим как JWT
  if (token.includes('.')) {
    const payload = decodeJWT(token);
    if (!payload || !payload.sub) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return null;
    }
    
    return { 
      user_id: payload.sub, 
      athlete_id: payload.athlete_id || null,
      api_key: payload.api_key || null 
    };
  }
  
  // Для простых токенов (начинающихся с "access_") используем hardcoded данные
  if (token.startsWith('access_')) {
    return { 
      user_id: null, // Убрал хардкод - user_id должен приходить из токена
      athlete_id: 'i297087',
      api_key: null 
    };
  }
  
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return null;
}

const server = http.createServer((req, res) => {
  console.log('Request:', req.method, req.url);
  res.setHeader('Content-Type', 'application/json');
  
  // /gw/api/me - диагностика токена
  if (req.url === '/gw/api/me') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    res.writeHead(200);
    res.end(JSON.stringify({ 
      user_id: auth.user_id, 
      athlete_id: auth.athlete_id || 'i297087' 
    }));
    return;
  }
  
  // /gw/oauth/authorize - OAuth authorization endpoint
  if (req.url.startsWith('/gw/oauth/authorize')) {
    console.log('OAuth authorize request');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>STAS Авторизация</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
            min-height: 100vh;
            background: #f8f9fa;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
          }
          
          .container {
            width: 100%;
            max-width: 24rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
          }
          
          .avatar {
            display: flex;
            justify-content: center;
          }
          
          .avatar img {
            width: 6rem;
            height: 6rem;
            border-radius: 50%;
            object-fit: cover;
          }
          
          .title {
            text-align: center;
          }
          
          .title h1 {
            color: #6b7280;
            font-size: 1rem;
            font-weight: 500;
            margin-bottom: 0.5rem;
          }
          
          .input-group {
            margin-bottom: -0.5rem;
          }
          
          .input {
            width: 100%;
            height: 3rem;
            background: #ffffff;
            border: 1px solid #e5e7eb;
            border-radius: 0.5rem;
            padding: 0 1rem;
            color: #003330;
            font-size: 1rem;
          }
          
          .input::placeholder {
            color: #b9bbbb;
          }
          
          .input:focus {
            outline: none;
            border-color: #00f9de;
            box-shadow: 0 0 0 3px rgba(0, 249, 222, 0.1);
          }
          
          .button {
            width: 100%;
            height: 3rem;
            background: #00f9de;
            border: none;
            border-radius: 0.5rem;
            color: #003330;
            font-weight: 500;
            font-size: 1rem;
            cursor: pointer;
            transition: background-color 0.2s;
          }
          
          .button:hover {
            background: #00e6cb;
          }
          
          .footer {
            text-align: center;
            padding-top: 0.5rem;
          }
          
          .footer p {
            color: #b9bbbb;
            font-size: 0.875rem;
          }
          
          .footer a {
            color: #00f9de;
            text-decoration: underline;
          }
          
          .footer a:hover {
            color: #00e6cb;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- Profile Avatar -->
          <div class="avatar">
            <img
              src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Frame%2056-GrnXAETxJu1Yb83h8yanH4qnZOTDp6.png"
              alt="STAS Profile"
            />
          </div>

          <!-- Title -->
          <div class="title">
            <h1>ВВЕДИТЕ ВАШ STAS ID</h1>
          </div>

          <!-- Input Field -->
          <div class="input-group">
            <input
              type="text"
              id="stasId"
              class="input"
              placeholder=""
              maxlength="20"
            />
          </div>

          <!-- Login Button -->
          <button id="loginBtn" class="button">
            Войти
          </button>

          <!-- Footer Link -->
          <div class="footer">
            <p>
              Подробнее:{" "}
              <a href="https://stas.run" target="_blank">
                stas.run
              </a>
            </p>
          </div>
        </div>

        <script>
          // Максимально простой и надежный код
          console.log('JavaScript loaded successfully');

          function handleLogin() {
            console.log('Button clicked!');

            var stasId = document.getElementById('stasId').value;
            console.log('STAS ID entered:', stasId);

            if (!stasId || stasId.trim() === '') {
              alert('Введите STAS ID!');
              return;
            }

            // Получаем redirect_uri из URL параметров страницы
            var urlParams = new URLSearchParams(window.location.search);
            var redirectUri = urlParams.get('redirect_uri');
            var state = urlParams.get('state');

            // Формируем URL для получения токена
            var tokenUrl = '/gw/oauth/token?user_id=' + encodeURIComponent(stasId.trim()) + '&client_id=chatgpt-actions';
            if (redirectUri) {
              tokenUrl += '&redirect_uri=' + encodeURIComponent(redirectUri);
            }
            if (state) {
              tokenUrl += '&state=' + encodeURIComponent(state);
            }

            console.log('Redirecting to:', tokenUrl);

            // Перенаправляем на получение токена
            window.location.href = tokenUrl;
          }

          // Привязка события к кнопке
          document.getElementById('loginBtn').onclick = handleLogin;

          // Enter в поле ввода
          document.getElementById('stasId').onkeypress = function(event) {
            if (event.key === 'Enter') {
              handleLogin();
            }
          };

          // Проверка загрузки
          window.onload = function() {
            console.log('Page fully loaded');
            console.log('Button element:', document.getElementById('loginBtn'));
            console.log('Input element:', document.getElementById('stasId'));
          };

          console.log('Script execution completed');
        </script>
      </body>
      </html>
    `);
    return;
  }
  
  // /gw/oauth/token - OAuth token endpoint
  if (req.url.startsWith('/gw/oauth/token')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const { user_id, client_id, redirect_uri, state, grant_type, code } = Object.fromEntries(params);

        console.log('OAuth token POST request:', {
          method: req.method,
          url: req.url,
          params: Object.fromEntries(params)
        });

        try {
          // Проверяем grant_type
          if (grant_type === 'refresh_token') {
            // Обработка refresh token
            const newAccessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              access_token: newAccessToken,
              token_type: 'Bearer',
              expires_in: 86400
            }));
            return;
          }

          // Если есть code - это exchange authorization code на token
          if (code) {
            const accessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: 86400,
              refresh_token: 'refresh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
            }));
            return;
          }

          // Если есть redirect_uri - делаем redirect с authorization code (для браузерных клиентов)
          if (redirect_uri) {
            const authCode = 'auth_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.set('code', authCode);
            if (state) {
              redirectUrl.searchParams.set('state', state);
            }
            
            console.log('OAuth redirect to:', redirectUrl.toString());
            
            res.writeHead(302, { 
              'Location': redirectUrl.toString(),
              'Cache-Control': 'no-cache'
            });
            res.end();
            return;
          }

          // Для других случаев (client_credentials, etc.) возвращаем access_token напрямую
          const accessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

          console.log('Returning token response');
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 86400,
            refresh_token: 'refresh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
          }));

        } catch (error) {
          console.error('OAuth token error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    } else if (req.method === 'GET') {
      // GET request - обработка user_id из query параметров (с страницы авторизации)
      const url = new URL(req.url, 'http://localhost');
      const user_id = url.searchParams.get('user_id');
      const client_id = url.searchParams.get('client_id');
      const redirect_uri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');

      console.log('OAuth token GET request:', {
        method: req.method,
        url: req.url,
        user_id,
        client_id,
        redirect_uri,
        state
      });

      try {
        // Если есть redirect_uri - делаем redirect с authorization code
        if (redirect_uri) {
          const authCode = 'auth_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
          const redirectUrl = new URL(redirect_uri);
          redirectUrl.searchParams.set('code', authCode);
          if (state) {
            redirectUrl.searchParams.set('state', state);
          }
          
          console.log('OAuth redirect to:', redirectUrl.toString());
          
          res.writeHead(302, { 
            'Location': redirectUrl.toString(),
            'Cache-Control': 'no-cache'
          });
          res.end();
          return;
        }

        // Специальная обработка для GPT Actions без redirect_uri
        if (client_id === 'chatgpt-actions') {
          const authCode = 'auth_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
          const redirectUrl = new URL('https://chat.openai.com/aip/g-0e683685e67e111ebd51aa7d6b2be34f380bb37f/oauth/callback');
          redirectUrl.searchParams.set('code', authCode);
          if (state) {
            redirectUrl.searchParams.set('state', state);
          }
          
          console.log('OAuth redirect to GPT Actions callback:', redirectUrl.toString());
          
          res.writeHead(302, { 
            'Location': redirectUrl.toString(),
            'Cache-Control': 'no-cache'
          });
          res.end();
          return;
        }

        // Возвращаем красивую страницу с токеном вместо JSON
        const accessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const refreshToken = 'refresh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        console.log('Returning token page for user_id:', user_id);
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html lang="ru">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>STAS Токен получен</title>
            <style>
              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
              }
              
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
                min-height: 100vh;
                background: #f8f9fa;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 1rem;
              }
              
              .container {
                width: 100%;
                max-width: 28rem;
                display: flex;
                flex-direction: column;
                gap: 1.5rem;
              }
              
              .success-icon {
                display: flex;
                justify-content: center;
              }
              
              .success-icon div {
                width: 4rem;
                height: 4rem;
                border-radius: 50%;
                background: #00f9de;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #003330;
                font-size: 2rem;
                font-weight: bold;
              }
              
              .title {
                text-align: center;
              }
              
              .title h1 {
                color: #003330;
                font-size: 1.5rem;
                font-weight: 600;
                margin-bottom: 0.5rem;
              }
              
              .title p {
                color: #6b7280;
                font-size: 1rem;
              }
              
              .token-section {
                background: #ffffff;
                border: 1px solid #e5e7eb;
                border-radius: 0.75rem;
                padding: 1.5rem;
              }
              
              .token-label {
                font-size: 0.875rem;
                font-weight: 500;
                color: #6b7280;
                margin-bottom: 0.5rem;
              }
              
              .token-input {
                width: 100%;
                padding: 0.75rem;
                border: 1px solid #e5e7eb;
                border-radius: 0.5rem;
                background: #f9fafb;
                color: #003330;
                font-family: monospace;
                font-size: 0.875rem;
                word-break: break-all;
                margin-bottom: 1rem;
              }
              
              .copy-button {
                width: 100%;
                height: 3rem;
                background: #00f9de;
                border: none;
                border-radius: 0.5rem;
                color: #003330;
                font-weight: 500;
                font-size: 1rem;
                cursor: pointer;
                transition: background-color 0.2s;
              }
              
              .copy-button:hover {
                background: #00e6cb;
              }
              
              .back-button {
                width: 100%;
                height: 3rem;
                background: #ffffff;
                border: 1px solid #e5e7eb;
                border-radius: 0.5rem;
                color: #6b7280;
                font-weight: 500;
                font-size: 1rem;
                cursor: pointer;
                transition: all 0.2s;
              }
              
              .back-button:hover {
                background: #f9fafb;
                border-color: #d1d5db;
              }
              
              .footer {
                text-align: center;
                padding-top: 1rem;
              }
              
              .footer p {
                color: #b9bbbb;
                font-size: 0.875rem;
              }
              
              .footer a {
                color: #00f9de;
                text-decoration: underline;
              }
              
              .footer a:hover {
                color: #00e6cb;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <!-- Success Icon -->
              <div class="success-icon">
                <div>✓</div>
              </div>

              <!-- Title -->
              <div class="title">
                <h1>Авторизация успешна!</h1>
                <p>Ваш токен готов к использованию</p>
              </div>

              <!-- Token Section -->
              <div class="token-section">
                <div class="token-label">Access Token:</div>
                <input
                  type="text"
                  id="accessToken"
                  class="token-input"
                  value="${accessToken}"
                  readonly
                />
                
                <button class="copy-button" onclick="copyToken()">
                  Копировать токен
                </button>
              </div>

              <!-- Back Button -->
              <button class="back-button" onclick="goBack()">
                ← Вернуться к авторизации
              </button>

              <!-- Footer Link -->
              <div class="footer">
                <p>
                  Подробнее:{" "}
                  <a href="https://stas.run" target="_blank">
                    stas.run
                  </a>
                </p>
              </div>
            </div>

            <script>
              function copyToken() {
                const tokenInput = document.getElementById('accessToken');
                tokenInput.select();
                document.execCommand('copy');
                
                const button = document.querySelector('.copy-button');
                const originalText = button.textContent;
                button.textContent = 'Скопировано!';
                button.style.background = '#10b981';
                
                setTimeout(() => {
                  button.textContent = originalText;
                  button.style.background = '#00f9de';
                }, 2000);
              }
              
              function goBack() {
                window.location.href = '/gw/oauth/authorize';
              }
              
              // Автовыделение токена при клике
              document.getElementById('accessToken').addEventListener('click', function() {
                this.select();
              });
            </script>
          </body>
          </html>
        `);

      } catch (error) {
        console.error('OAuth token GET error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    } else {
      // GET request - return simple token for testing
      console.log('OAuth token GET request (fallback)');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5NTE5MjAzOSIsImF0aGxldGVfaWQiOiJpMjk3MDg3Iiwic2NvcGUiOiJyZWFkIiwiaWF0IjoxNzU4MjQyNjMwLCJleHAiOjE3NTgyNDI2MzF9.test-signature',
        token_type: 'Bearer',
        expires_in: 3600
      }));
      return;
    }
  }
  
  // /gw/api/db/user_summary - STAS прокси
  if (req.url.startsWith('/gw/api/db/user_summary')) {
    console.log('Processing /api/db/user_summary request');
    const auth = requireAuth(req, res);
    console.log('Auth result:', auth ? 'success' : 'failed');
    if (!auth) return;
    
    console.log('User ID from token:', auth.user_id);
    
    // Всегда возвращаем mock данные (stas-db-bridge возвращает заглушку)
    console.log('Returning mock data for user_summary');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      user_summary: {
        total_workouts: 47,
        total_distance: 387.2,
        total_time: 126540,
        avg_pace: "5:27/km",
        avg_distance_per_workout: 8.2,
        longest_run: 21.1,
        fastest_pace: "4:15/km",
        weekly_average: 32.5,
        monthly_goal: 150,
        current_month_progress: 87.2,
        goals: "Increase weekly mileage to 40km, improve 10km time to under 45 minutes",
        recent_achievements: [
          "Completed 20km long run",
          "Improved 5km time by 2 minutes",
          "Consistent training for 8 weeks"
        ]
      },
      user_summary_updated_at: new Date().toISOString()
    }));
    return;
  }
  
  // /gw/api/db/trainings - STAS прокси
  if (req.url.startsWith('/gw/api/db/trainings')) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    console.log('Trainings request - STAS API not configured yet');
    
    // Пока STAS API не подключен - возвращаем пустые данные
    res.writeHead(200);
    res.end(JSON.stringify({ 
      ok: true,
      trainings: [],
      message: 'STAS API not configured - showing empty data'
    }));
    return;
  }
  
  // /gw/icu/events - ICU прокси
  if (req.url.startsWith('/gw/icu/events')) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    console.log('Events request - ICU API not configured yet');
    
    // Пока ICU API не подключен - возвращаем пустые данные
    res.writeHead(200);
    res.end(JSON.stringify([]));
    return;
  }
  
  // Default response
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, url: req.url }));
});

server.listen(3338, '127.0.0.1', () => {
  console.log('Server listening on 127.0.0.1:3338');
});
