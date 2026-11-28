/**
 * 擋掉不是自己畫面發出的請求（其他網頁打 localhost、DNS rebinding、CSRF）
 *  - Host 只認 127.0.0.1:<port> 或 localhost:<port>
 *  - /api 的 Sec-Fetch-Site 有帶就只能是 same-origin 或 none
 *  - 會改狀態或花額度的請求（POST／DELETE）：Origin 有帶就要同源、一定要帶 X-Sop-Desk、POST 要 JSON
 *  - 不送任何 CORS 標頭
 * @returns {string|null} 擋下的原因，null = 放行
 */
export function checkRequest(req, port) {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts.includes(host)) return 'bad host';

  const url = req.url || '/';
  if (!url.startsWith('/api/')) return null;

  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site';

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  const origin = req.headers.origin;
  if (origin && !allowedHosts.map(h => `http://${h}`).includes(origin.toLowerCase())) return 'bad origin';
  if (req.headers['x-sop-desk'] !== '1') return 'missing header';
  if (method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return 'not json';
  return null;
}

/** 每分鐘最多 n 次（花額度的請求用） */
export function createRateLimit(perMinute, now = () => Date.now()) {
  const stamps = [];
  return () => {
    const t = now();
    while (stamps.length && t - stamps[0] > 60_000) stamps.shift();
    if (stamps.length >= perMinute) return false;
    stamps.push(t);
    return true;
  };
}
