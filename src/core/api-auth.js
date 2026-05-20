/**
 * API Authentication Middleware
 *
 * 保護管理 API（/api/*）不被未授權存取。
 *
 * 支援兩種驗證方式（擇一）：
 * 1. API Key：Header `X-API-Key` 或 query `?apiKey=xxx`
 * 2. IP 白名單：只允許指定 IP（預設 localhost）
 *
 * 設定（config.server.apiAuth）：
 *   { "apiKey": "your-secret-key" }           // API Key 模式
 *   { "allowIPs": ["127.0.0.1", "::1"] }      // IP 白名單模式
 *   { "apiKey": "xxx", "allowIPs": ["..."] }   // 兩者皆可
 *
 * 未設定時：預設只允許 localhost 存取。
 */

export function createApiAuth(config = {}) {
  const apiKey = config.apiKey || process.env.API_KEY || null;
  const allowIPs = new Set(config.allowIPs || ['127.0.0.1', '::1', '::ffff:127.0.0.1']);

  return function apiAuth(req, res, next) {
    // 1. API Key 驗證
    if (apiKey) {
      const key = req.headers['x-api-key'] || req.query.apiKey;
      if (key === apiKey) return next();
    }

    // 2. IP 白名單
    const clientIP = req.ip || req.connection?.remoteAddress || '';
    if (allowIPs.has(clientIP)) return next();

    // 都不過 → 403
    console.log(`[api-auth] blocked: ${clientIP} → ${req.path}`);
    res.status(403).json({ error: 'Forbidden', message: 'API key or allowed IP required' });
  };
}

/**
 * 遮蔽 userId（保留前 8 碼 + 星號）
 * 用於 /api/logs 回傳時保護 PII
 */
export function maskUserId(userId) {
  if (!userId || userId.length <= 8) return userId;
  return userId.slice(0, 8) + '***';
}
