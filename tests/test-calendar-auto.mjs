/**
 * 小帥從群組對話自動記行事曆（2026-11-19）測試：不打 AI、不連 LINE，資料庫用暫存目錄
 * 執行：node tests/test-calendar-auto.mjs
 * 模擬 AI 在 JSON 裡給的 calendar 欄位 → parseCalendar → cal.autoAdd，列出哪些會記、哪些不會
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseProvider } from '../src/core/database.js';
import * as cal from '../plugins/xiaoshuai/calendar.js';
import { parseReply } from '../plugins/xiaoshuai/index.js';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ✓ ${name}`); };

const dir = mkdtempSync(join(tmpdir(), 'cal-auto-'));
const db = createDatabaseProvider(dir).getDatabase('xiaoshuai');
cal.initCalendar(db, { dir });
const G = 'C' + 'a'.repeat(32);
const NOW = Date.UTC(2026, 10, 19, 6, 0); // 台北 2026-11-19（四）14:00

// AI 回的 JSON（一般聊天那一輪順便給的）
const raw = JSON.stringify({
  reply: '',
  remember: [],
  calendar: [
    { title: '家長會', when: '11/27 晚上七點', place: '學校' },     // 定案、有時間
    { title: '繳團費', when: '11/30' },                              // 只有日期 → 全天
    { title: '要不要去烤肉', when: '下週六' },                        // 猶豫
    { title: '尾牙', when: '11/10 晚上' },                           // 過去
    { title: '亂寫', when: '改天' },                                 // 沒日期
  ],
});

await test('parseReply 收 calendar 欄位（最多 3 筆）', () => {
  const p = parseReply(raw, 'idle');
  assert.equal(p.calendar.length, 3);
  assert.equal(parseReply('{"reply":"嗨","remember":[]}', 'mention').calendar, null);
});

const results = [];
const run = (items, opts = {}) => {
  const r = cal.autoAdd(G, items, { now: NOW, ...opts });
  for (const e of r.added) results.push(['會記', `${e.day} ${e.time || '全天'} ${e.title}`]);
  for (const s of r.skipped) results.push(['不記', `${s.title}：${s.why}`]);
  return r;
};

await test('定案的記、只有日期的記成全天', () => {
  const r = run([{ title: '家長會', when: '11/27 晚上七點', place: '學校' }, { title: '繳團費', when: '11/30' }]);
  assert.equal(r.added.length, 2);
  assert.equal(r.added[0].day, '2026-11-27'); assert.equal(r.added[0].time, '19:00'); assert.equal(r.added[0].created_by, cal.AUTO_BY);
  assert.equal(r.added[1].day, '2026-11-30'); assert.equal(r.added[1].time, null);
});
await test('猶豫的、問句不記', () => {
  const r = run([{ title: '要不要去烤肉', when: '下週六' }, { title: '聚餐', when: '12/6 可能中午' }, { title: '看電影', when: '週日嗎' }]);
  assert.equal(r.added.length, 0);
  assert.ok(r.skipped.every(s => s.why === '還沒定案'));
});
await test('重複（同一天標題相近）不記', () => {
  const r = run([{ title: '家長會（學校）', when: '11/27 19:00' }, { title: '繳團費給小美', when: '11/30' }]);
  assert.equal(r.added.length, 0);
  assert.ok(r.skipped.every(s => /同一天已經有/.test(s.why)));
});
await test('過去日期、沒日期不記', () => {
  const r = run([{ title: '尾牙', when: '11/10 晚上' }, { title: '亂寫', when: '改天' }]);
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.skipped.map(s => s.why), ['日期已經過了', '沒有明確日期']);
});
await test('綁了旅遊行程的那幾天不記（交給行程）', () => {
  const r = run([{ title: '燒肉', when: '12/26 晚上六點' }], { skipDays: new Set(['2026-12-26']) });
  assert.equal(r.added.length, 0);
});
await test('被刪掉的不會再被記回來', () => {
  const ev = cal.futureEvents(G, NOW).find(e => e.title === '繳團費');
  assert.equal(cal.remove(G, ev.id, 'U-someone', false, '某人').ok !== false, true, '群組成員可以刪小帥記的');
  const r = run([{ title: '繳團費', when: '11/30' }]);
  assert.equal(r.added.length, 0);
});
await test('每天自動記上限 5 件', () => {
  const items = ['A聚會', 'B聚會', 'C聚會', 'D聚會', 'E聚會'].map((x, i) => ({ title: x, when: `12/${10 + i}` }));
  run(items.slice(0, 3)); run(items.slice(3, 5));
  const n = db.get('SELECT COUNT(*) n FROM cal_events WHERE chat_id = ? AND created_by = ?', G, cal.AUTO_BY).n;
  assert.equal(n, 5, '家長會、繳團費（已刪）＋3 件 = 5');
  const r = run([{ title: 'F聚會', when: '12/20' }]);
  assert.equal(r.added.length, 0); assert.equal(r.skipped[0].why, '今天自動記滿了');
});
await test('查詢時第一次標「小帥從對話記的」，之後不標', () => {
  const range = { from: '2026-11-27', to: '2026-11-27', label: '11/27', single: true };
  const m1 = cal.queryMessages(range, cal.itemsBetween([{ chatId: G, label: '' }], range.from, range.to, NOW), { now: NOW });
  assert.match(m1[1].altText, /家長會（學校）（小帥從對話記的）|家長會.*小帥從對話記的/);
  assert.match(JSON.stringify(m1[1].contents), /cal:del:/, '卡片上有刪掉');
  const m2 = cal.queryMessages(range, cal.itemsBetween([{ chatId: G, label: '' }], range.from, range.to, NOW), { now: NOW });
  assert.doesNotMatch(m2[1].altText, /小帥從對話記的/);
});

console.log('\n── 範例對話會不會記 ──');
for (const [k, v] of results) console.log(`  ${k}｜${v}`);
console.log(`\n全部通過：${pass} 項`);
process.exit(0);
