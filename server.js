const express    = require("express");
const bodyParser = require("body-parser");

const bearerUid      = require("./routes/_bearer_uid");
const legacyAliases  = require("./routes/legacy_aliases");
const trainingsRouter= require("./routes/trainings");

// из Bearer → req.query.user_id
const uidInjectDb = require("./routes/_uid_inject_db");  // совместимость для DB-прокси
const dbProxy     = require("./routes/db_proxy");        // прокси к stas-db-bridge
const stas        = require("./routes/stas");            // алиасы DB API
const icu         = require("./routes/icu");             // ICU proxy (GET /gw/icu/*)
const openapi     = require("./routes/openapi");
const oauth       = require("./routes/oauth");

const PORT = process.env.PORT || 3337;
const app  = express();

const oauthPage = require("./middleware/oauth_page");
const cookieParser = require("cookie-parser");

app.set("trust proxy", 1);
app.use(cookieParser());

app.use(bodyParser.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));

// OAuth page
app.use("/gw/oauth", oauthPage());

// Health
app.get("/gw/healthz", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// 1) Bearer → req.query.user_id
app.use("/gw", bearerUid());

// 2) ICU write/delete routes (важно: после bearerUid, до /gw/icu router)
try { require("./routes/icu_post_passthru_gw")(app); } catch(e) { console.error("[icu][passthru] attach failed:", e && e.message); }
try { require("./routes/icu_post_real_gw")(app);     } catch(e) { console.error("[icu][POST] attach failed:", e && e.message); }
try { require("./routes/icu_delete_exact_gw")(app);  } catch(e) { console.error("[icu][DELETE] attach failed:", e && e.message); }

// Trainings
app.use("/gw", trainingsRouter);

// OAuth API
app.use("/gw", oauth);

// Aliases / legacy
app.use("/gw", legacyAliases);

// DB API
app.use("/gw/api/db", uidInjectDb);
app.use("/gw/api/db", dbProxy);
app.use("/gw/api",    stas);

// ICU proxy (read)
app.use("/gw/icu", icu);

// OpenAPI & errors
app.use("/gw", openapi);
app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));
app.use((err, _req, res, _next) => {
  console.error("[ERR]", err && err.stack || err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
