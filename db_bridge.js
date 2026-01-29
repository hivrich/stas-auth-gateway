"use strict";

try { require("dotenv").config(); } catch (_) {/* no dotenv; env is provided by systemd EnvironmentFile */ }

const express = require("express");
const { Pool } = require("pg");

const PORT = parseInt(process.env.PORT || "3336", 10);
const HOST = process.env.HOST || "127.0.0.1";

// Если API_KEY задан — требуем X-API-Key. Если нет — считаем сервис внутренним (loopback) и пускаем без ключа.
const API_KEY = (process.env.API_KEY || "").trim();

const DB = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: (/^true$/i).test(String(process.env.DB_SSL || "")) ? { rejectUnauthorized: false } : false,
});

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const k = String(req.header("X-API-Key") || "");
  if (!k || k !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

function asInt(v, def, { min, max } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (min != null && i < min) return min;
  if (max != null && i > max) return max;
  return i;
}

function parseDateLike(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Ожидаем ISO/дату, Postgres сам распарсит корректные форматы через параметр
  return s;
}

function validateTextPayload(name, v, { maxBytes } = {}) {
  if (typeof v !== "string") return { ok: false, error: `${name}_required` };
  // Запрещаем нулевой байт (Postgres text его не принимает; плюс защита от мусора/бинарщины)
  if (v.includes("\u0000")) return { ok: false, error: `${name}_invalid_null_byte` };

  const bytes = Buffer.byteLength(v, "utf8");
  if (maxBytes != null && bytes > maxBytes) return { ok: false, error: `${name}_too_large`, bytes, maxBytes };

  return { ok: true, value: v, bytes };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", async (_req, res) => {
  try {
    await DB.query("SELECT 1");
    res.json({ ok: true, service: "stas-db-bridge", time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_down", detail: e.message });
  }
});

// Все /api/db/* — под (опциональным) X-API-Key
app.use("/api/db", requireApiKey);

// GET /api/db/trainings?user_id=...&limit=...&oldest=...&newest=...
app.get("/api/db/trainings", async (req, res) => {
  const user_id = asInt(req.query.user_id, null);
  if (!user_id) return res.status(400).json({ error: "user_id_required" });

  const wants_full = String(req.query.full || "") === "1";

  const limit  = asInt(req.query.limit, 30, { min: 1, max: wants_full ? 200 : 500 });
  const offset = asInt(req.query.offset, 0,  { min: 0, max: 100000 });

  const oldest = parseDateLike(req.query.oldest);
  const newest = parseDateLike(req.query.newest);

  const where = ["user_id = $1"];
  const params = [user_id];
  let p = 2;

  if (oldest) { where.push(`date >= $${p++}`); params.push(oldest); }
  if (newest) { where.push(`date <= $${p++}`); params.push(newest); }

  const sql = wants_full ? `
    SELECT
      id, date, workout_type, distance, user_report, ai_comment,
      training_load, fitness, fatigue, elevation_gain, intensity,
      icu_hr_zones, avg_heartrate, max_heartrate, lactate_threshold_hr,
      moving_time, form, user_id, pace, activity_name, activity_plan,
      hr_zone_times, interval_summary, splits_km,
      session_type
    FROM public.training
    WHERE ${where.join(" AND ")}
    ORDER BY date DESC, id DESC
    LIMIT $${p++} OFFSET $${p++}
  ` : `
    SELECT
      id, date, workout_type, distance, user_report, ai_comment,
      training_load, fitness, fatigue, elevation_gain, intensity,
      icu_hr_zones, avg_heartrate, max_heartrate, lactate_threshold_hr,
      moving_time, form, user_id, pace, activity_name,
      session_type
    FROM public.training
    WHERE ${where.join(" AND ")}
    ORDER BY date DESC, id DESC
    LIMIT $${p++} OFFSET $${p++}
  `;
  params.push(limit, offset);

  try {
    const r = await DB.query(sql, params);
    res.json({ trainings: r.rows, count: r.rows.length });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /api/db/activities_full?user_id=... (полная версия)
app.get("/api/db/activities_full", async (req, res) => {
  const user_id = asInt(req.query.user_id, null);
  if (!user_id) return res.status(400).json({ error: "user_id_required" });

  const limit = asInt(req.query.limit, 30, { min: 1, max: 200 });
  const offset = asInt(req.query.offset, 0, { min: 0, max: 100000 });

  const oldest = parseDateLike(req.query.oldest);
  const newest = parseDateLike(req.query.newest);

  const where = ["user_id = $1"];
  const params = [user_id];
  let p = 2;

  if (oldest) { where.push(`date >= $${p++}`); params.push(oldest); }
  if (newest) { where.push(`date <= $${p++}`); params.push(newest); }

  const sql = `
    SELECT
      id, date, workout_type, distance, user_report, ai_comment,
      training_load, fitness, fatigue, elevation_gain, intensity,
      icu_hr_zones, avg_heartrate, max_heartrate, lactate_threshold_hr,
      moving_time, form, user_id, pace, activity_name, activity_plan,
      hr_zone_times, interval_summary, splits_km,
      session_type
    FROM public.training
    WHERE ${where.join(" AND ")}
    ORDER BY date DESC, id DESC
    LIMIT $${p++} OFFSET $${p++}
  `;
  params.push(limit, offset);

  try {
    const r = await DB.query(sql, params);
    res.json({ trainings: r.rows, count: r.rows.length });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ICU creds (для mcp-bridge/icu): используем public.user (api_key, athlete_id) — это точно есть у тебя в коде mcp-bridge.
app.get("/api/db/icu_creds", async (req, res) => {
  const user_id = asInt(req.query.user_id, null);
  if (!user_id) return res.status(400).json({ error: "user_id_required" });
  try {
    const r = await DB.query("SELECT api_key, athlete_id FROM public.user WHERE id=$1", [user_id]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// user_summary: пробуем взять из public.user.user_summary (если колонки нет — вернём not_available, не падаем)
app.get("/api/db/user_summary", async (req, res) => {
  const user_id = asInt(req.query.user_id, null);
  if (!user_id) return res.status(400).json({ error: "user_id_required" });
  try {
    const r = await DB.query("SELECT user_summary FROM public.user WHERE id=$1", [user_id]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, user_summary: r.rows[0].user_summary ?? null });
  } catch (e) {
    // колонка/таблица может отличаться — это не критично для восстановления trainings
    res.status(501).json({ ok: false, error: "not_available", detail: e.message });
  }
});

// POST /api/db/strategy
// Body: { user_id: int, strategy_text: string }
// ВАЖНО: это внутренний endpoint, user_id сюда отдаёт gateway (внешний клиент до DB-bridge не должен добираться).
// Пишем ТОЛЬКО public.user.strategy (text). Никаких strategy_json/user_summary и т.п.
app.post("/api/db/strategy", async (req, res) => {
  // Явно ожидаем JSON
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "content_type_must_be_application_json" });
  }

  const user_id = asInt(req.body && req.body.user_id, null);
  if (!user_id) return res.status(400).json({ error: "user_id_required" });

  const v = validateTextPayload("strategy_text", req.body && req.body.strategy_text, { maxBytes: 16 * 1024 });
  if (!v.ok) return res.status(400).json(v);

  // Логи: только user_id и размер, без контента
  const ts = new Date().toISOString();
  console.log(`[strategy] ${ts} user_id=${user_id} bytes=${v.bytes}`);

  const sql = `
    UPDATE public.user
    SET strategy = $1
    WHERE id = $2
    RETURNING id AS user_id, now() AS updated_at, octet_length(strategy) AS bytes
  `;

  try {
    const r = await DB.query(sql, [v.value, user_id]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`stas-db-bridge (db_bridge.js) listening on http://${HOST}:${PORT}`);
});
