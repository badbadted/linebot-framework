/**
 * safeFetch 防 SSRF 測試（最後一項會連外網抓 example.com）
 * 執行：node tests/test-safe-fetch.mjs
 */
import assert from 'node:assert/strict';
import { isBlockedIp, safeFetch } from '../src/utils/safe-fetch.js';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`✓ ${name}`); };

await test('內網／本機／保留位址都擋', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.222', '172.20.0.1', '169.254.169.254', '100.64.1.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', 'not-an-ip']) {
    assert.ok(isBlockedIp(ip), ip);
  }
});

await test('公開位址放行', () => {
  for (const ip of ['8.8.8.8', '157.240.22.35', '172.32.0.1', '2606:4700:4700::1111']) assert.ok(!isBlockedIp(ip), ip);
});

await test('內網網址、本機、奇怪協定與埠都拒絕', async () => {
  for (const u of ['http://127.0.0.1:18797/api/health', 'http://localhost/', 'http://192.168.0.222/', 'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'ftp://example.com/', 'http://example.com:8080/',
    'http://user:pw@example.com/', 'not a url']) {
    await assert.rejects(() => safeFetch(u, { timeoutMs: 3000 }), undefined, u);
  }
});

await test('公開網站正常抓得到', async () => {
  const r = await safeFetch('https://example.com/', { timeoutMs: 8000 });
  assert.equal(r.status, 200);
  assert.match(r.text, /Example Domain/);
});

await test('回應大小有上限', async () => {
  const r = await safeFetch('https://example.com/', { timeoutMs: 8000, maxBytes: 100 });
  assert.ok(Buffer.byteLength(r.text) <= 100);
});

console.log(`\n${pass} 項全部通過`);
