function base64urlDecode(s){
  s = s.replace(/-/g,'+').replace(/_/g,'/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  return Buffer.from(s + '='.repeat(pad), 'base64').toString('utf8');
}
function getUserIdFromBearer(req){
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if(!h || !/^Bearer\s+/.test(h)) return null;
  const token = h.replace(/^Bearer\s+/,'').trim();
  const parts = token.split('.');
  if(parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64urlDecode(parts[1]));
    // ожидаем user_id (строка/число) — не трогаем значение, просто приводим к строке
    if(payload && (payload.user_id !== undefined && payload.user_id !== null)) {
      return String(payload.user_id);
    }
    return null;
  } catch(e){ return null; }
}
module.exports = { getUserIdFromBearer };
