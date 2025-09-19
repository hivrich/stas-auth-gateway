'use strict';
const express = require('express');
const bodyParser = require('body-parser');

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
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const token = auth.slice(7);

  // Если токен выглядит как JWT (содержит точки), парсим как JWT
  if (token.includes('.')) {
    const payload = decodeJWT(token);
    if (!payload || !payload.sub) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    req.auth = {
      user_id: payload.sub,
      athlete_id: payload.athlete_id || null,
      api_key: payload.api_key || null
    };
    return next();
  }

  // Для простых токенов (начинающихся с "access_") используем hardcoded данные
  if (token.startsWith('access_')) {
    req.auth = {
      user_id: null, // Убрал хардкод - user_id должен приходить из токена
      athlete_id: 'i297087',
      api_key: null
    };
    return next();
  }

  res.status(401).json({ error: 'unauthorized' });
}

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// Health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Existing OAuth routes (keeping them intact)
app.get('/gw/oauth/authorize', (req, res) => {
  // Your existing authorize logic here
  res.status(200).send('OAuth authorize page');
});

app.post('/gw/oauth/token', (req, res) => {
  // Your existing token logic here
  res.status(200).json({ access_token: 'token', token_type: 'Bearer' });
});

app.get('/gw/api/me', requireAuth, (req, res) => {
  res.json({
    user_id: req.auth.user_id,
    athlete_id: req.auth.athlete_id || 'i297087'
  });
});

// Existing user_summary (keeping mock data for now)
app.get('/gw/api/db/user_summary', requireAuth, (req, res) => {
  res.json({
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
  });
});

// Existing trainings (keeping empty data for now)
app.get('/gw/api/db/trainings', requireAuth, (req, res) => {
  res.json({
    ok: true,
    trainings: [],
    message: 'STAS API not configured - showing empty data'
  });
});

// Existing ICU events (keeping empty data for now)
app.get('/gw/icu/events', requireAuth, (req, res) => {
  res.json([]);
});

// New routes (when STAS/ICU are ready)
// app.use('/gw/api', require('./routes/stas'));
// app.use('/gw/icu', require('./routes/icu'));

const port = process.env.PORT || 3338;
app.listen(port, '127.0.0.1', () => {
  console.log(`stas-auth-gateway listening on http://127.0.0.1:${port}`);
});
