/**
 * 小帥主動提議接上小帥的完整流程（假 LINE、假 AI、假 router；時間固定在台北 2026-11-17 10:00）
 * 執行：node tests/test-nudge-flow.mjs
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.UTC(2026, 10, 17, 2, 0, 0); // 台北 10:00（週二）
mock.timers.enable({ apis: ['Date'], now: NOW });
const tick = (ms) => mock.timers.tick(ms);

process.env.XIAOSHUAI_CAL_DIR = mkdtempSync(join(tmpdir(), 'xs-nudge-'));
process.env.XIAOSHUAI_CAL_NO_ENRICH = '1';
process.env.BOT_PUBLIC_URL = 'https://bot.example.test';
process.env.XIAOSHUAI_LIFF_FILE = join(process.env.XIAOSHUAI_CAL_DIR, 'none.json');

const { default: xiaoshuai } = await import('../plugins/xiaoshuai/index.js');
const nudge = await import('../plugins/xiaoshuai/nudge.js');
const cal = await import('../plugins/xiaoshuai/calendar.js');

let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log(`✓ ${name}`); }

async function memDb() {
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(':memory:');
  return { run: (q, ...a) => raw.prepare(q).run(...a), get: (q, ...a) => raw.prepare(q).get(...a), all: (q, ...a) => raw.prepare(q).all(...a), exec: (q) => raw.exec(q) };
}

const NAMES = { U1: '恩爸', U2: '妞媽', U3: '淇媽' };
async function bot({ calIntent = null, vote = null } = {}) {
  const db = await memDb();
  const replies = [];
  const llmCalls = [];
  const foodCalls = [];
  const lineApi = { reply: async (_t, m) => { replies.push(Array.isArray(m) ? m : [{ type: 'text', text: m }]); return {}; }, push: async () => { throw new Error('不該推播'); },
    getGroupMemberProfile: async (_g, u) => ({ displayName: NAMES[u] || '某人' }), getProfile: async (u) => ({ displayName: NAMES[u] || '某人' }) };
  const router = {
    match: (text, { groupId }) => (/^\/美食 /.test(text) ? { matched: true, groupBlocked: groupId === 'GNOFOOD', route: { name: 'food' }, text } : { matched: false }),
    execute: async (m, ctx) => { foodCalls.push({ text: m.text, userId: ctx.userId }); return { type: 'query', result: '✅ 已新增：XX 牛肉湯' }; },
  };
  const ctx = { db, lineApi, router, isAdmin: (u) => u === 'UADMIN', providers: { llm: { generate: async ({ messages, system }) => {
    const c = messages[0].content;
    llmCalls.push(c);
    if (!system && c.includes('要處理行事曆')) return (typeof calIntent === 'function' ? calIntent(c) : calIntent) || '{"action":"none"}';
    if (!system && c.includes('開個投票有幫助')) return vote || '{"ask":false}';
    return { text: '{"reply":""}' };
  } } } };
  await xiaoshuai.init(ctx);
  for (const g of ['GC', 'GNOFOOD']) db.run('INSERT INTO groups (chat_id, enabled) VALUES (?, 1)', g);
  await xiaoshuai.init(ctx);
  let seq = 100;
  const say = async (userId, text, chatId = 'GC') => {
    const id = String(++seq);
    const event = { message: { type: 'text', id, text } };
    xiaoshuai.onGroupText({ chatId, userId, text, event });
    const n = replies.length;
    await xiaoshuai.onUnmatched({ chatId, userId, text, replyToken: `rt${id}`, event });
    return replies.length > n ? replies.at(-1) : null;
  };
  return { db, replies, llmCalls, foodCalls, say };
}

await test('記事：講到某天某時 → 一句話問；有人回好 → 記好＋行事曆卡', async () => {
  const b = await bot({ calIntent: '{"action":"add","items":[{"title":"練球","when":"週六早上九點","place":"河濱球場"}]}' });
  const q = await b.say('U1', '週六早上九點練球 在河濱球場');
  assert.equal(q.length, 1);
  assert.equal(q[0].type, 'text');
  assert.equal(q[0].text, '要幫大家記到行事曆嗎？11/21（六） 09:00 練球 📍河濱球場');
  const r = await b.say('U2', '好啊');
  assert.equal(r[0].text, '記好了 📅');
  assert.equal(r[1].type, 'flex');
  const ev = cal.futureEvents('GC').find(e => e.title === '練球');
  assert.equal(ev.day, '2026-11-21');
  assert.equal(ev.time, '09:00');
  // 同一件事再講一次：不再問
  assert.equal(await b.say('U1', '週六早上九點練球 在河濱球場'), null);
});

await test('記事：30 分鐘沒人說不要 → 安靜記好，不發訊息', async () => {
  const b = await bot({ calIntent: '{"action":"add","items":[{"title":"家長會","when":"11/25 晚上七點","place":""}]}' });
  assert.match((await b.say('U1', '11/25 晚上七點 家長會'))[0].text, /^要幫大家記到行事曆嗎？11\/25（三） 19:00 家長會$/);
  const n = b.replies.length;
  tick(nudge.ASK_TTL_MS + 1000);
  xiaoshuai._nudgeSweep(); // 每分鐘那次
  await new Promise(r => setImmediate(r));
  assert.ok(cal.futureEvents('GC').some(e => e.title === '家長會' && e.day === '2026-11-25'));
  assert.equal(b.replies.length, n);
});

await test('記事：有人說不要 → 回「好 👌」、不記；今天不再問記事', async () => {
  const b = await bot({ calIntent: '{"action":"add","items":[{"title":"聚餐","when":"11/28 晚上六點","place":""}]}' });
  await b.say('U1', '11/28 晚上六點 聚餐');
  assert.equal((await b.say('U2', '不用'))[0].text, '好 👌');
  assert.ok(!cal.futureEvents('GC').some(e => e.title === '聚餐'));
  assert.equal(nudge.canAsk('GC', 'calendar').why, 'declined');
});

await test('投票：兩個人在選 → 問；有人回好 → 投票卡', async () => {
  const b = await bot({ vote: '{"ask":true,"title":"晚餐吃什麼","options":["燒肉","拉麵"]}' });
  assert.equal(await b.say('U2', '晚上吃什麼啦'), null); // 只有一個人在問，不問
  const q = await b.say('U1', '燒肉？還是拉麵');
  assert.equal(q[0].text, '要不要開個投票？燒肉、拉麵');
  const r = await b.say('U2', '+1');
  assert.equal(r[0].text, '開好了，按下面投 👇');
  assert.equal(r[1].type, 'flex');
  assert.match(JSON.stringify(r[1]), /燒肉/);
});

await test('上限：一天最多主動問 2 次', async () => {
  // 假 AI：照那句話抄出日期與事情（「12/5 晚上七點 尾牙」）
  const b = await bot({ calIntent: (c) => {
    const m = /「(\d{1,2}\/\d{1,2} \S+) (\S+)」/.exec(c);
    return m ? JSON.stringify({ action: 'add', items: [{ title: m[2], when: m[1], place: '' }] }) : '{"action":"none"}';
  } });
  // 前兩個測試同一群已問過；新的一天重新算
  tick(24 * 3600_000);
  assert.ok(await b.say('U1', '11/29 下午三點 打球'));
  await b.say('U2', '好');
  b.llmCalls.length = 0;
  const b2 = await b.say('U1', '12/5 晚上七點 尾牙');
  assert.ok(b2); await b.say('U2', '好');
  assert.equal(await b.say('U1', '12/6 晚上七點 生日會'), null); // 第 3 次：不問、也不花 AI
  assert.equal(b.llmCalls.filter(c => c.includes('12/6')).length, 0);
});

await test('美食：貼地圖連結 → 只問貼的人；別人回好不算；本人回好走 /美食', async () => {
  const b = await bot();
  // 不碰真的妞揪：這個測試只驗「這群沒開美食就不問」與回答的歸屬（有開的群需要 Firestore，部署後實測）
  assert.equal(await b.say('U1', '這家超讚 https://maps.app.goo.gl/abc', 'GNOFOOD'), null);
  tick(24 * 3600_000);
  nudge.open('GC', { kind: 'food', key: 'food:https://maps.app.goo.gl/xyz', payload: { url: 'https://maps.app.goo.gl/xyz' }, onlyUser: 'U2', question: '妞媽，要把這家收進我們的美食嗎？' });
  assert.equal(await b.say('U1', '好'), null);
  const r = await b.say('U2', '好');
  assert.equal(r[0].text, '✅ 已新增：XX 牛肉湯');
  assert.deepEqual(b.foodCalls, [{ text: '/美食 https://maps.app.goo.gl/xyz', userId: 'U2' }]);
});

await test('/小帥 主動：顯示狀態、可以關', async () => {
  const b = await bot();
  const route = xiaoshuai.commands.find(c => c.name === 'xiaoshuai-nudge');
  const m = (t) => route.pattern.exec(t);
  assert.match(await route.handler(m('/小帥 主動'), { groupId: 'GC', userId: 'U1' }), /小帥主動提議：少/);
  assert.match(await route.handler(m('/小帥 主動 關'), { groupId: 'GC', userId: 'U1' }), /關/);
  assert.equal(nudge.canAsk('GC', 'vote').why, 'off');
});

mock.timers.reset();
console.log(`\n${pass} 項通過`);
process.exit(0);
