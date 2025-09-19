'use strict';
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// OpenAPI specification for GPT Actions (corrected and complete)
const openapiSpec = {
  "openapi": "3.1.0",
  "info": {
    "title": "STAS Training Gateway API",
    "description": "Unified gateway for accessing training data from STAS database and Intervals.icu",
    "version": "1.0.3",
    "contact": {
      "name": "STAS Support",
      "url": "https://intervals.stas.run"
    }
  },
  "servers": [
    {
      "url": "https://intervals.stas.run",
      "description": "Production server"
    }
  ],
  "security": [
    {
      "oauth2": ["read:me", "icu", "workouts:write"]
    }
  ],
  "paths": {
    "/gw/api/db/user_summary": {
      "get": {
        "operationId": "getUserTrainingSummary",
        "summary": "Get comprehensive training summary for the authenticated user",
        "description": "Retrieves aggregated training statistics including total workouts, distance, time, pace metrics, and goals",
        "security": [
          {
            "oauth2": ["read:me"]
          }
        ],
        "responses": {
          "200": {
            "description": "Training summary data retrieved successfully",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserSummaryResponse"
                }
              }
            }
          },
          "401": {
            "description": "Unauthorized - invalid or missing access token",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "403": {
            "description": "Forbidden - insufficient permissions",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/gw/api/db/activities": {
      "get": {
        "operationId": "getTrainingActivities",
        "summary": "Get list of training activities",
        "description": "Retrieves training activities within specified date range or number of days",
        "security": [
          {
            "oauth2": ["icu"]
          }
        ],
        "parameters": [
          {
            "name": "days",
            "in": "query",
            "description": "Number of recent days to look back (alternative to from/to dates)",
            "required": false,
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 365,
              "default": 30
            }
          },
          {
            "name": "from",
            "in": "query",
            "description": "Start date in YYYY-MM-DD format",
            "required": false,
            "schema": {
              "type": "string",
              "format": "date"
            }
          },
          {
            "name": "to",
            "in": "query",
            "description": "End date in YYYY-MM-DD format",
            "required": false,
            "schema": {
              "type": "string",
              "format": "date"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Training activities retrieved successfully",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ActivitiesResponse"
                }
              }
            }
          },
          "401": {
            "description": "Unauthorized - invalid or missing access token",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "403": {
            "description": "Forbidden - insufficient permissions",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/gw/icu/events": {
      "get": {
        "operationId": "getCalendarEvents",
        "summary": "Get training calendar events and planned workouts",
        "description": "Retrieves scheduled training events and planned workouts from the calendar",
        "security": [
          {
            "oauth2": ["icu"]
          }
        ],
        "parameters": [
          {
            "name": "oldest",
            "in": "query",
            "description": "Oldest date to include in YYYY-MM-DD format",
            "required": false,
            "schema": {
              "type": "string",
              "format": "date"
            }
          },
          {
            "name": "newest",
            "in": "query",
            "description": "Newest date to include in YYYY-MM-DD format",
            "required": false,
            "schema": {
              "type": "string",
              "format": "date"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Calendar events retrieved successfully",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CalendarEventsResponse"
                }
              }
            }
          },
          "401": {
            "description": "Unauthorized - invalid or missing access token",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "403": {
            "description": "Forbidden - insufficient permissions",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
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
      "UserSummaryResponse": {
        "type": "object",
        "required": ["ok", "user_summary"],
        "properties": {
          "ok": {
            "type": "boolean",
            "description": "Success indicator"
          },
          "user_summary": {
            "type": "object",
            "required": ["total_workouts", "total_distance", "total_time"],
            "properties": {
              "total_workouts": {
                "type": "integer",
                "description": "Total number of completed workouts",
                "minimum": 0
              },
              "total_distance": {
                "type": "number",
                "description": "Total distance in kilometers",
                "minimum": 0
              },
              "total_time": {
                "type": "integer",
                "description": "Total training time in seconds",
                "minimum": 0
              },
              "avg_pace": {
                "type": "string",
                "description": "Average pace in min/km format",
                "example": "5:30/km"
              },
              "weekly_average": {
                "type": "number",
                "description": "Average weekly distance in kilometers",
                "minimum": 0
              },
              "monthly_goal": {
                "type": "number",
                "description": "Current monthly distance goal in kilometers",
                "minimum": 0
              },
              "goals": {
                "type": "string",
                "description": "Text description of training goals"
              },
              "recent_achievements": {
                "type": "array",
                "description": "List of recent training achievements",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          "user_summary_updated_at": {
            "type": "string",
            "format": "date-time",
            "description": "Timestamp of last summary update"
          }
        }
      },
      "ActivitiesResponse": {
        "type": "object",
        "required": ["ok", "trainings"],
        "properties": {
          "ok": {
            "type": "boolean",
            "description": "Success indicator"
          },
          "trainings": {
            "type": "array",
            "description": "List of training activities",
            "items": {
              "type": "object",
              "required": ["id", "name", "date"],
              "properties": {
                "id": {
                  "type": "string",
                  "description": "Unique activity identifier"
                },
                "name": {
                  "type": "string",
                  "description": "Activity name/description"
                },
                "date": {
                  "type": "string",
                  "format": "date",
                  "description": "Activity date in YYYY-MM-DD format"
                },
                "distance": {
                  "type": "number",
                  "description": "Distance in kilometers",
                  "minimum": 0
                },
                "duration": {
                  "type": "integer",
                  "description": "Duration in seconds",
                  "minimum": 0
                },
                "pace": {
                  "type": "string",
                  "description": "Average pace in min/km format",
                  "example": "4:45/km"
                },
                "type": {
                  "type": "string",
                  "description": "Activity type (run, bike, swim, etc.)",
                  "enum": ["run", "bike", "swim", "strength", "other"]
                },
                "notes": {
                  "type": "string",
                  "description": "Additional notes about the activity"
                }
              }
            }
          }
        }
      },
      "CalendarEventsResponse": {
        "type": "array",
        "description": "List of calendar events and planned workouts",
        "items": {
          "type": "object",
          "required": ["id", "name", "start_date"],
          "properties": {
            "id": {
              "type": "string",
              "description": "Unique event identifier"
            },
            "name": {
              "type": "string",
              "description": "Event name/description"
            },
            "start_date": {
              "type": "string",
              "format": "date-time",
              "description": "Event start date and time in ISO format"
            },
            "planned_distance": {
              "type": "number",
              "description": "Planned distance in kilometers",
              "minimum": 0
            },
            "planned_duration": {
              "type": "integer",
              "description": "Planned duration in seconds",
              "minimum": 0
            },
            "type": {
              "type": "string",
              "description": "Event type",
              "enum": ["workout", "race", "long_run", "tempo", "interval", "easy"]
            },
            "description": {
              "type": "string",
              "description": "Detailed event description"
            }
          }
        }
      },
      "ErrorResponse": {
        "type": "object",
        "required": ["error"],
        "properties": {
          "error": {
            "type": "string",
            "description": "Error type identifier"
          },
          "detail": {
            "type": "string",
            "description": "Detailed error description"
          },
          "code": {
            "type": "integer",
            "description": "HTTP status code",
            "minimum": 100,
            "maximum": 599
          }
        }
      }
    },
    "securitySchemes": {
      "oauth2": {
        "type": "oauth2",
        "description": "OAuth 2.0 authorization for accessing training data",
        "flows": {
          "authorizationCode": {
            "authorizationUrl": "https://intervals.stas.run/gw/oauth/authorize",
            "tokenUrl": "https://intervals.stas.run/gw/oauth/token",
            "refreshUrl": "https://intervals.stas.run/gw/oauth/token",
            "scopes": {
              "read:me": "Read user profile and training summary",
              "icu": "Read detailed training activities and calendar",
              "workouts:write": "Create and modify workouts and events"
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
console.log(`Starting STAS/ICU server on port ${port}...`);
app.listen(port, '127.0.0.1', () => {
  console.log(`STAS/ICU server listening on http://127.0.0.1:${port}`);
});
