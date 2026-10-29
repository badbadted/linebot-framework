/**
 * LINE 推播額度警示測試（假資料，不連 LINE）
 * 執行：node tests/test-quota-alert.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseProvider } from '../src/core/database.js';
import { createQuotaAlert, monthKey, quotaMessage } from '../src/core/quota-alert.js';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`✓ ${name}`); };

const dir = mkdtempSync(join(tmpdir(), 'quota-test-'));
const provider = createDatabaseProvider(dir);
const db = provider.getDatabase('_system');
const pushed = [];
const alert = createQuotaAlert({ getQuota: async () => { throw new Error('測試不該連 LINE'); }, push: async t => pushed.push(t), db });
const oct = new Date('2026-10-29T12:00:00+08:00');

await test('79% 不推', async () => {
  const r = await alert.check({ now: oct, quota: { limit: 200, used: 158 } });
  assert.equal(r.sent, false); assert.equal(r.reason, 'below'); assert.equal(pushed.length, 0);
});

await test('80% 推一則，內容正確', async () => {
  const r = await alert.check({ now: oct, quota: { limit: 200, used: 160 } });
  assert.equal(r.sent, true); assert.equal(pushed.length, 1);
  assert.equal(pushed[0], '⚠️ LINE 推播額度這個月已用 160／200 則，剩 40 則，下個月 1 號重算');
});

await test('同月第二次不推（狀態存 DB）', async () => {
  const again = createQuotaAlert({ getQuota: async () => ({}), push: async t => pushed.push(t), db }); // 模擬重啟
  const r = await again.check({ now: new Date('2026-10-30T12:00:00+08:00'), quota: { limit: 200, used: 190 } });
  assert.equal(r.sent, false); assert.equal(r.reason, 'already-sent'); assert.equal(pushed.length, 1);
});

await test('下個月再達標會再推', async () => {
  const r = await alert.check({ now: new Date('2026-11-25T12:00:00+08:00'), quota: { limit: 200, used: 170 } });
  assert.equal(r.sent, true); assert.equal(pushed.length, 2);
});

await test('推播失敗不記錄，明天再試', async () => {
  const failing = createQuotaAlert({ getQuota: async () => ({}), push: async () => { throw new Error('push 500'); }, db });
  const dec = new Date('2026-12-20T12:00:00+08:00');
  await assert.rejects(() => failing.check({ now: dec, quota: { limit: 200, used: 180 } }));
  const r = await alert.check({ now: dec, quota: { limit: 200, used: 181 } });
  assert.equal(r.sent, true);
});

await test('沒有上限不推', async () => {
  const r = await alert.check({ now: new Date('2027-01-10T12:00:00+08:00'), quota: { limit: null, used: 999 } });
  assert.equal(r.sent, false); assert.equal(r.reason, 'no-limit');
});

await test('月份用台灣時間、剩餘不為負', () => {
  assert.equal(monthKey(new Date('2026-10-31T16:30:00Z')), '2026-11'); // 台灣 11/1 00:30
  assert.match(quotaMessage({ limit: 200, used: 205 }), /剩 0 則/);
});

provider.closeAll();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed`);
