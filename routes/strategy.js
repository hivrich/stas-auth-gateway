"use strict";

const express = require("express");
const fs = require("fs");

const router = express.Router();

// DB-bridge base (локальный)
const STAS_BASE =
  process.env.STAS_BASE ||
  process.env.STAS_INTERNAL_BASE_URL ||
  "http://127.0.0.1:3336";

function getDbBridgeApiKey() {
  if (process.env.DB_BRIDGE_API_KEY) return String(process.env.DB_BRIDGE_API_KEY);

  // fallback: читаем /opt/stas-db-bridge/.env (как уже делается в trainings.js / stas.js)
  try {
    const raw = fs.readFileSync("/opt/stas-db-bridge/.env", "utf8");
    const m = raw.match(/^\s*API_KEY\s*=\s*(.+?)\s*$/m);
    if (!m) return "";
    return String(m[1]).trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}

function bad(res, code, obj) {
  return res.status(code).json(obj);
}

// POST /gw/strategy
// Body: { strategy_text: string, reason?: string }
// ВАЖНО: user_id извне запрещён (ни query, ни body). UID берём только из Bearer (middleware _bearer_uid.js).
router.post("/strategy", async (req, res) => {
  // Явно ожидаем JSON
  if (!req.is("application/json")) {
    return bad(res, 415, { error: "content_type_must_be_application_json" });
  }

  // Запрещаем попытки подмены user_id из body
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, "user_id")) {
    return bad(res, 400, { error: "user_id_forbidden" });
  }

  // UID только из Bearer middleware (req.user_id проставляет routes/_bearer_uid.js)
  const uid = req.user_id ? String(req.user_id) : "";
  if (!uid || !/^[0-9]+$/.test(uid)) {
    return bad(res, 401, { error: "missing_or_invalid_token" });
  }

  const strategy_text = req.body ? req.body.strategy_text : undefined;
  if (typeof strategy_text !== "string") {
    return bad(res, 400, { error: "strategy_text_required" });
  }
  if (strategy_text.indexOf("\u0000") !== -1) {
    return bad(res, 400, { error: "strategy_text_invalid_null_byte" });
  }

  const bytes = Buffer.byteLength(strategy_text, "utf8");
  const maxBytes = 16 * 1024;
  if (bytes > maxBytes) {
    return bad(res, 400, { error: "strategy_text_too_large", bytes, maxBytes });
  }

  const apiKey = getDbBridgeApiKey();
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const payload = { user_id: Number(uid), strategy_text };

  const ts = new Date().toISOString();
  try {
    const r = await fetch(STAS_BASE + "/api/db/strategy", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}

    // Логи: только uid/bytes/status (без контента)
    console.log("[gw][strategy] " + ts + " uid=" + uid + " bytes=" + bytes + " status=" + r.status);

    if (!r.ok) {
      return res.status(r.status).json(j || { ok: false, status: r.status, error: "db_bridge_error" });
    }

    return res.json({
      ok: true,
      user_id: Number(uid),
      updated_at: (j && j.updated_at) ? j.updated_at : null,
      length: bytes,
    });
  } catch (e) {
    console.log("[gw][strategy] " + ts + " uid=" + uid + " bytes=" + bytes + " status=500 err=" + (e && e.message ? e.message : "unknown"));
    return bad(res, 500, { ok: false, error: "proxy_failed" });
  }
});

module.exports = router;
