const fs = require('fs');
let cached = null;
module.exports = function getStasKey(){
  if (cached) return cached;
  const fromEnv = process.env.STAS_KEY || process.env.DB_BRIDGE_API_KEY || '';
  if (fromEnv) return cached = fromEnv;
  try {
    const raw = fs.readFileSync('/opt/stas-db-bridge/.env','utf8');
    const line = (raw.split(/\r?\n/).find(x=>/^API_KEY=/.test(x))||'').split('=',2)[1]||'';
    return cached = String(line).trim();
  } catch { return ''; }
};
