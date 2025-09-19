'use strict';
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// OpenAPI specification for GPT Actions
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
        "operationId": "getUserSummary",
        "summary": "Get user training summary",
        "security": [{ "oauth2": [] }],
        "responses": {
          "200": {
            "description": "User summary data",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserSummary"
                }
              }
            }
          }
        }
      }
    },
    "/api/db/activities": {
      "get": {
        "operationId": "getActivities",
        "summary": "Get training activities",
        "security": [{ "oauth2": [] }],
        "parameters": [
          { "name": "days", "in": "query", "schema": { "type": "integer" }, "description": "Number of days to look back" },
          { "name": "from", "in": "query", "schema": { "type": "string", "format": "date" }, "description": "Start date (YYYY-MM-DD)" },
          { "name": "to", "in": "query", "schema": { "type": "string", "format": "date" }, "description": "End date (YYYY-MM-DD)" }
        ],
        "responses": {
          "200": {
            "description": "List of activities",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ActivitiesResponse"
                }
              }
            }
          }
        }
      }
    },
    "/icu/events": {
      "get": {
        "operationId": "getCalendarEvents",
        "summary": "Get training calendar events",
        "security": [{ "oauth2": [] }],
        "parameters": [
          { "name": "oldest", "in": "query", "schema": { "type": "string", "format": "date" }, "description": "Oldest date to include (YYYY-MM-DD)" },
          { "name": "newest", "in": "query", "schema": { "type": "string", "format": "date" }, "description": "Newest date to include (YYYY-MM-DD)" }
        ],
        "responses": {
          "200": {
            "description": "List of calendar events",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CalendarEventsResponse"
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "UserSummary": {
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
      },
      "ActivitiesResponse": {
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
                "pace": { "type": "string" },
                "type": { "type": "string" }
              }
            }
          }
        }
      },
      "CalendarEventsResponse": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "name": { "type": "string" },
            "start_date": { "type": "string", "format": "date-time" },
            "planned_distance": { "type": "number" },
            "planned_duration": { "type": "integer" }
          }
        }
      }
    },
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

// Routes
app.get('/.well-known/openapi.json', (req, res) => {
  res.json(openapiSpec);
});

app.get('/openapi.json', (req, res) => {
  res.json(openapiSpec);
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

const port = process.env.PORT || 3339;
console.log(`Starting server on port ${port}...`);
app.listen(port, '127.0.0.1', () => {
  console.log(`STAS/ICU server listening on http://127.0.0.1:${port}`);
});
