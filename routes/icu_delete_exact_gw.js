// Restored: DELETE /gw/icu/events window-delete shim
// server.js expects: require("./routes/icu_delete_exact_gw")(app)

module.exports = function(app){
  require("../lib/attach_delete")(app);
  console.log("[icu][DELETE] /gw/icu/events attached (window shim via lib/attach_delete.js)");
};
