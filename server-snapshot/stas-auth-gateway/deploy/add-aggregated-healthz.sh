#!/usr/bin/env bash
# Агрегированный healthz эндпоинт
# Добавляет проверку всех сервисов в gateway

echo "🏥 ДОБАВЛЯЕМ АГРЕГИРОВАННЫЙ /healthz..."

# 1. Обновляем код gateway
cat > /tmp/gateway-healthz.js << 'EOF'
const express = require('express');
const axios = require('axios');

async function checkService(name, url, headers = {}) {
  try {
    const response = await axios.get(url, { headers, timeout: 5000 });
    return { name, status: 'ok', code: response.status };
  } catch (error) {
    return {
      name,
      status: 'error',
      code: error.response?.status || 'timeout',
      message: error.message
    };
  }
}

async function aggregatedHealthz(req, res) {
  const checks = await Promise.all([
    // Gateway self-check
    Promise.resolve({ name: 'gateway', status: 'ok', code: 200 }),

    // DB Bridge
    checkService('db-bridge', 'http://127.0.0.1:3336/healthz'),

    // MCP Bridge
    checkService('mcp-bridge', 'http://127.0.0.1:3334/healthz'),

    // External APIs
    checkService('intervals-api', 'https://intervals.icu/api/v1/athlete', {
      'Authorization': `Bearer ${process.env.INTERVALS_ACCESS_TOKEN || 'dummy'}`
    })
  ]);

  const allOk = checks.every(check => check.status === 'ok');
  const statusCode = allOk ? 200 : 503;

  res.status(statusCode).json({
    status: allOk ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    services: checks,
    version: '1.0.0'
  });
}

module.exports = aggregatedHealthz;
EOF

# 2. Обновляем основной файл gateway
echo "Обновляю server.js gateway..."

# Создаем backup
cp /opt/stas-auth-gateway/server.js /opt/stas-auth-gateway/server.js.backup

# Добавляем агрегированный healthz
sed -i '/const express = require('\''express'\'');/a const aggregatedHealthz = require('\''./gateway-healthz'\'');' /opt/stas-auth-gateway/server.js

# Добавляем маршрут
sed -i '/app.get('\''\/gw\/healthz'\'', (req, res) => {/a app.get('\''\/healthz'\'', aggregatedHealthz);' /opt/stas-auth-gateway/server.js

# 3. Копируем файл healthz
cp /tmp/gateway-healthz.js /opt/stas-auth-gateway/gateway-healthz.js

# 4. Перезапускаем gateway
echo "Перезапускаю stas-auth-gateway..."
systemctl restart stas-auth-gateway

# 5. Проверяем
echo "Проверяю новый /healthz..."
sleep 2
curl -s http://127.0.0.1:3337/healthz | head -20

echo "✅ Агрегированный /healthz добавлен!"
echo "Теперь https://intervals.stas.run/healthz покажет статус всех сервисов"
