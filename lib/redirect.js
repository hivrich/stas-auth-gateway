// Redirect whitelist utility
// Allows only ChatGPT Actions callback URLs
// Hosts: chat.openai.com, chatgpt.com
// Paths:
//  - /aip/api/callback
//  - /aip/g-<group>/oauth/callback
function isAllowedRedirect(urlStr) {
  try {
    const u = new URL(urlStr);
    const hostOk = ['chat.openai.com', 'chatgpt.com'].includes(u.hostname);
    if (!hostOk) return false;
    const p = u.pathname;
    if (p === '/aip/api/callback') return true;
    if (/^\/aip\/g-[^/]+\/oauth\/callback$/.test(p)) return true;
    return false;
  } catch {
    return false;
  }
}

module.exports = { isAllowedRedirect };
