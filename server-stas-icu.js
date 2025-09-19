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

const openapiSpec = {
  "openapi": "3.1.0",
  "info": {
    "title": "Intervals/STAS Gateway API",
    "version": "1.0.2",
    "description": "OAuth-protected unified gateway for STAS DB and Intervals.icu API"
  },
  "servers": [
    { "url": "https://intervals.stas.run/gw" }
  ],
  "security": [
    { "oauth2": ["read:me", "icu", "workouts:write"] }
  ],
  "paths": {
    "/api/db/user_summary": {
      "get": {
        "summary": "Get user training summary",
        "security": [{ "oauth2": [] }],
        "responses": {
          "200": {
            "description": "User summary data",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": { "type": "boolean" },
                    "user_summary": {
                      "type": "object",
                      "properties": {
                        "total_workouts": { "type": "integer" },
                        "total_distance": { "type": "number" },
                        "total_time": { "type": "integer" },
                        "avg_pace": { "type": "string" },
                        "weekly_average": { "type": "number" },
                        "monthly_goal": { "type": "number" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/db/activities": {
      "get": {
        "summary": "Get training activities",
        "security": [{ "oauth2": [] }],
        "parameters": [
          { "name": "days", "in": "query", "schema": { "type": "integer" }, "description": "Number of days to look back" },
          { "name": "from", "in": "query", "schema": { "type": "string", "format": "date" } },
          { "name": "to", "in": "query", "schema": { "type": "string", "format": "date" } }
        ],
        "responses": {
          "200": {
            "description": "List of activities",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": { "type": "boolean" },
                    "trainings": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": { "type": "string" },
                          "name": { "type": "string" },
                          "date": { "type": "string", "format": "date" },
                          "distance": { "type": "number" },
                          "duration": { "type": "integer" },
                          "pace": { "type": "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/icu/events": {
      "get": {
        "summary": "Get training calendar events",
        "security": [{ "oauth2": [] }],
        "parameters": [
          { "name": "oldest", "in": "query", "schema": { "type": "string", "format": "date" } },
          { "name": "newest", "in": "query", "schema": { "type": "string", "format": "date" } }
        ],
        "responses": {
          "200": {
            "description": "List of calendar events",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": { "type": "string" },
                      "name": { "type": "string" },
                      "start_date": { "type": "string", "format": "date-time" },
                      "planned_distance": { "type": "number" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "oauth2": {
        "type": "oauth2",
        "flows": {
          "authorizationCode": {
            "authorizationUrl": "https://intervals.stas.run/gw/oauth/authorize",
            "tokenUrl": "https://intervals.stas.run/gw/oauth/token",
            "scopes": {
              "read:me": "Read user profile",
              "icu": "Read ICU training data",
              "workouts:write": "Write workouts/events to ICU"
            }
          }
        }
      }
    }
  }
};

// Health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Test route
app.get('/test', (req, res) => {
  res.json({ message: 'STAS/ICU server is running!' });
});

// OpenAPI specification for GPT Actions
app.get('/.well-known/openapi.json', (req, res) => {
  res.json(openapiSpec);
});
app.get('/openapi.json', (req, res) => {
  res.json(openapiSpec);
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

// New routes (strict: user in token required)
app.use('/gw/api', require('./routes/stas'));
app.use('/gw/icu', require('./routes/icu'));

// Legacy routes (keeping for compatibility)
app.get('/gw/api/db/trainings', requireAuth, (req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</gw/api/db/activities>; rel="successor-version"');
  res.setHeader('Sunset', 'Tue, 31 Dec 2025 23:59:59 GMT');
  res.json({
    ok: true,
    trainings: [],
    message: 'STAS API not configured - showing empty data'
  });
});

app.get('/gw/icu/events', requireAuth, (req, res) => {
  res.json([]);
});

const port = process.env.PORT || 3339;
app.listen(port, '127.0.0.1', () => {
  console.log(`stas-auth-gateway listening on http://127.0.0.1:${port}`);
});
