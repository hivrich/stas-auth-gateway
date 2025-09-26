// Специальный endpoint для GPT Actions - выдает токен для конкретного user_id
// Использование: POST /gpt/token?user_id=<user_id>&api_key=YOUR_SECRET_KEY

const jwt = require('jsonwebtoken');

function setupGPTTokenEndpoint(app) {
  app.post('/gpt/token', (req, res) => {
    const { user_id } = req.query;
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    // Проверка секретного ключа для безопасности
    const EXPECTED_API_KEY = process.env.GPT_API_KEY || 'your-secret-key-here';
    if (apiKey !== EXPECTED_API_KEY) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    
    if (!user_id || isNaN(Number(user_id))) {
      return res.status(400).json({ error: 'Valid user_id required' });
    }
    
    // Создаем токен с правильным user_id
    const token = jwt.sign({
      sub: String(user_id),
      scope: 'read:me icu workouts:write',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      typ: 'access'
    }, process.env.JWT_SECRET || 'your-jwt-secret');
    
    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      user_id: Number(user_id)
    });
  });
}

module.exports = { setupGPTTokenEndpoint };
