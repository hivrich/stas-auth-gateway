const { getRequestSource } = require('./request-source');

// Кто сделал правку плана: значение поля actor в журнале изменений STAS.
// 'you'      - сам пользователь с сайта STAS (источник site, проверен по STAS_KEY);
// 'chatgpt'  - ChatGPT (MCP-клиент на chatgpt.com / openai.com или GPT Actions);
// 'claude'   - Claude (MCP-клиент на claude.ai / claude.com / anthropic.com или Claude OAuth);
// 'ai_chat'  - любой другой ИИ-чат (неизвестный MCP-клиент).
const CHATGPT_DOMAINS = ['chatgpt.com', 'openai.com'];
const CLAUDE_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com'];

function hostMatches(host, domains) {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function actorFromMcpHost(clientHost) {
  const host = String(clientHost || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return 'ai_chat';
  if (hostMatches(host, CHATGPT_DOMAINS)) return 'chatgpt';
  if (hostMatches(host, CLAUDE_DOMAINS)) return 'claude';
  return 'ai_chat';
}

// Чистая функция: источник запроса, режим входа и хост MCP-клиента -> actor.
function resolvePlanChangeActor({ source, authMode, clientHost } = {}) {
  if (source === 'site') return 'you';
  if (authMode === 'mcp') return actorFromMcpHost(clientHost);
  if (source === 'claude') return 'claude';
  if (source === 'gpt') return 'chatgpt';
  return 'ai_chat';
}

function getPlanChangeActor(req) {
  return resolvePlanChangeActor({
    source: getRequestSource(req),
    authMode: req?.auth?.authMode,
    clientHost: req?.auth?.clientHost,
  });
}

module.exports = { getPlanChangeActor, resolvePlanChangeActor };
