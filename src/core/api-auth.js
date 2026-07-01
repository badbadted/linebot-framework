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

  // 區網 CIDR 前綴（192.168.x.x / 10.x.x.x / 172.16-31.x.x）
  function isPrivateIP(ip) {
    const clean = ip.replace('::ffff:', '');
    return clean.startsWith('192.168.') || clean.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(clean);
  }

  return function apiAuth(req, res, next) {
    // 1. API Key 驗證
    if (apiKey) {
      const key = req.headers['x-api-key'] || req.query.apiKey;
      if (key === apiKey) return next();
    }

    // 2. IP 白名單 + 區網自動放行
    // ⚠️ Cloudflare Tunnel 會把外網請求轉發到 localhost，使 req.ip 變成 127.0.0.1，
    // 若直接用 IP 放行 = 對整個網路開放。凡帶 CF 邊緣標頭（cf-connecting-ip / cf-ray）
    // 者一律視為「外網來的」，不吃區網放行、只能靠金鑰；真本機/區網直連才免金鑰。
    const viaCloudflare = !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
    if (!viaCloudflare) {
      const clientIP = req.ip || req.connection?.remoteAddress || '';
      if (allowIPs.has(clientIP) || isPrivateIP(clientIP)) return next();
    }

    // 都不過 → 403
    const src = viaCloudflare ? `cf:${req.headers['cf-connecting-ip'] || '?'}` : (req.ip || '?');
    console.log(`[api-auth] blocked: ${src} → ${req.path}`);
    res.status(403).json({ error: 'Forbidden', message: 'API key required (external), or call from LAN' });
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
