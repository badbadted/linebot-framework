/**
 * 提醒改用回覆送（2026-11-19）測試：不連 LINE（假 lineApi）、資料庫用暫存目錄
 * 執行：node tests/test-remind-reply.mjs
 *
 * ① 口語「11/25 提醒日本行前待辦」→ 11/25 09:00
 * ② 到期前回覆不夾提醒、到期後下一次回覆會夾、送過不重送；多筆合併；很久才送標「原定」；5 則上限
 * ③ 重啟：已到期的只標 due、不推播；狀態留在 db
 * ④ 模擬 webhook 事件（真的簽章）→ 指令回覆帶上到期提醒
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createDatabaseProvider } from '../src/core/database.js';
import { attachReplyExtras, combine } from '../src/core/reply-extras.js';
import { createWebhookHandler } from '../src/core/webhook.js';
import { createRouter } from '../src/core/router.js';
import remindPlugin, * as remind from '../plugins/remind/index.js';
const { remindSpecOf } = remind;
import * as cal from '../plugins/xiaoshuai/calendar.js';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ✓ ${name}`); };

// ── 假 LINE：記下每次 reply，push 一律算失敗 ──
function fakeLine() {
  const replies = [];
  const used = new Set();
  const api = {
    replies,
    async reply(token, msgs) {
      if (used.has(token)) throw new Error('LINE reply failed: 400 Invalid reply token');
      used.add(token);
      const arr = typeof msgs === 'string' ? [{ type: 'text', text: msgs }] : Array.isArray(msgs) ? msgs : [msgs];
      replies.push({ token, msgs: arr });
      return { sentMessages: arr.map((_, i) => ({ id: `${token}-${i}` })) };
    },
    async push() { throw new Error('不該推播'); },
    async getGroupMemberProfile() { return { displayName: '測試' }; },
  };
  return attachReplyExtras(api);
}
const fakeScheduler = () => {
  const once = new Map();
  return { once, addOnce: (name, at, fn) => once.set(name, { at, fn }), stop: (name) => once.delete(name) };
};

const dir = mkdtempSync(join(tmpdir(), 'remind-test-'));
let provider = createDatabaseProvider(dir);
let db = provider.getDatabase('remind');
let line = fakeLine();
let sched = fakeScheduler();
remind._setDeps({ db, scheduler: sched, lineApi: line });
remind._ensureSchema();
line.addReplyExtra('remind', remind.replyProvider);

const G = 'C' + '1'.repeat(32);
const G2 = 'C' + '2'.repeat(32);
let tk = 0;
const event = (scope = G) => ({ replyToken: `tok${++tk}`, source: { type: 'group', groupId: scope, userId: 'Uabc' } });
const sendReply = async (payload, scope = G) => { const ev = event(scope); line.noteReplyEvent(ev); return { res: await line.reply(ev.replyToken, payload), token: ev.replyToken }; };
const lastMsgs = () => line.replies.at(-1).msgs;
const setAt = (id, ms) => db.run('UPDATE reminders SET remind_at = ? WHERE id = ?', new Date(ms).toISOString(), id);

console.log('① 口語解析');
await test('「11/25 提醒日本行前待辦」→ 11/25 09:00（沒講幾點排 9:00）', () => {
  const spec = remindSpecOf('小帥 11/25 提醒日本行前待辦');
  assert.equal(spec, '11/25 日本行前待辦');
  const now = new Date(2026, 10, 19, 14, 0);
  const p = remind.parseReminder(spec, { defaultTime: true, now });
  assert.ok(p, 'parse 失敗');
  assert.equal(p.remindAt.getFullYear(), 2026);
  assert.equal(p.remindAt.getMonth() + 1, 11);
  assert.equal(p.remindAt.getDate(), 25);
  assert.equal(p.remindAt.getHours(), 9);
  assert.equal(p.remindAt.getMinutes(), 0);
  assert.equal(p.content, '日本行前待辦');
  assert.equal(p.defaultedTime, true);
  const r = remind.createReminderFromText({ userId: 'Uabc', scopeId: G2, text: spec, now });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'exact', '只給日期的用準時模式');
  const row = db.get('SELECT * FROM reminders WHERE id = ?', r.id);
  assert.equal(row.scope_id, G2);
  assert.equal(new Date(row.remind_at).getHours(), 9);
  db.run('DELETE FROM reminders WHERE id = ?', r.id);
});
await test('「明天 9 點提醒大家交報告」→ 明天 09:00 交報告', () => {
  const spec = remindSpecOf('小帥 明天 9 點提醒大家交報告');
  const now = new Date(2026, 10, 19, 14, 0);
  const p = remind.parseReminder(spec, { defaultTime: true, now });
  assert.equal(p.remindAt.getDate(), 20);
  assert.equal(p.remindAt.getHours(), 9);
  assert.equal(p.content, '交報告');
  assert.equal(p.defaultedTime, false);
});
await test('「提醒我 11/25 ○○」、問句與道謝不算', () => {
  assert.equal(remindSpecOf('小帥 提醒我 11/25 繳學費'), '11/25 繳學費');
  assert.equal(remindSpecOf('謝謝小帥提醒'), null);
  assert.equal(remindSpecOf('小帥你會提醒我嗎？'), null);
  assert.equal(remindSpecOf('今天天氣很好'), null);
  assert.equal(remind.parseReminder('交報告', { defaultTime: true }), null, '沒日期沒時間不設');
});
await test('小帥「提醒我…」→ 行事曆的日期／時間／標題（不建 remind）', () => {
  const now = Date.UTC(2026, 10, 19, 6, 0); // 台北 11/19 14:00
  const cases = [
    ['小帥 11/25 提醒日本行前待辦', '2026-11-25', null, '日本行前待辦'],
    ['小帥 提醒我 11/29 買機場巴士', '2026-11-29', null, '買機場巴士'],
    ['小帥 明天 9 點提醒大家交報告', '2026-11-20', '09:00', '交報告'],
    ['小帥 提醒我下週三晚上七點家長會', '2026-11-25', '19:00', '家長會'],
  ];
  for (const [text, day, time, title] of cases) {
    const spec = remindSpecOf(text);
    const w = cal.parseWhen(spec, now);
    assert.equal(cal.resolveDay(w, now), day, text);
    assert.equal(w.time, time, text);
    assert.equal(cal.titleOf(spec, w).title, title, text);
  }
  assert.equal(cal.parseWhen(remindSpecOf('小帥 30分鐘後提醒我倒垃圾') || '', now)?.day ?? null, null, '沒講哪天不記');
});
await test('原本 /提醒 格式照舊', () => {
  const now = new Date(2026, 10, 19, 14, 0);
  const a = remind.parseReminder('7/1（三）下午5:15維鈞牙醫', { now });
  assert.equal(a.remindAt.getHours(), 17); assert.equal(a.remindAt.getMinutes(), 15); assert.equal(a.content, '維鈞牙醫');
  const b = remind.parseReminder('18:00 開會', { now });
  assert.equal(b.remindAt.getDate(), 19); assert.equal(b.remindAt.getHours(), 18);
  const c = remind.parseReminder('30分鐘後 倒垃圾', { now });
  assert.equal(c.remindAt.getTime() - now.getTime(), 30 * 60000);
});

console.log('② 回覆時夾帶');
await test('到期前：回覆不夾提醒', async () => {
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '倒垃圾' }, '阿庭', { mode: 'exact' });
  assert.ok(sched.once.has(`remind-${r.id}`), '有排程（到時只標 due）');
  await sendReply('pong');
  assert.deepEqual(lastMsgs(), [{ type: 'text', text: 'pong' }]);
  globalThis.__r1 = r.id;
});
await test('時間到：排程只標 due，不推播', async () => {
  const id = globalThis.__r1;
  setAt(id, Date.now() - 60_000);
  await sched.once.get(`remind-${id}`).fn();
  const row = db.get('SELECT due, fired FROM reminders WHERE id = ?', id);
  assert.equal(row.due, 1); assert.equal(row.fired, 0);
});
await test('到期後：下一次回覆會夾在原本回覆後面', async () => {
  await sendReply('pong');
  const m = lastMsgs();
  assert.equal(m.length, 2);
  assert.equal(m[0].text, 'pong');
  assert.equal(m[1].type, 'flex');
  assert.match(m[1].altText, /倒垃圾/);
  assert.match(m[1].altText, /阿庭/);
  const row = db.get('SELECT fired, delivered_at FROM reminders WHERE id = ?', globalThis.__r1);
  assert.equal(row.fired, 1); assert.ok(row.delivered_at);
});
await test('送過不重送', async () => {
  await sendReply('pong');
  assert.equal(lastMsgs().length, 1);
});
await test('別的聊天的到期提醒不會夾進來', async () => {
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G2 }, { remindAt: new Date(Date.now() + 3600_000), content: '別群的事' }, '', { mode: 'exact' });
  setAt(r.id, Date.now() - 60_000);
  await sendReply('pong', G);
  assert.equal(lastMsgs().length, 1);
  await sendReply('pong', G2);
  assert.equal(lastMsgs().length, 2);
});
await test('多筆合併成一張；很久沒人說話標「原定 MM/DD HH:mm」', async () => {
  const a = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '日本行前待辦' }, '', { mode: 'exact' });
  const b = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '買機場巴士' }, '', { mode: 'exact' });
  setAt(a.id, Date.now() - 3 * 3600_000);
  setAt(b.id, Date.now() - 2 * 60_000);
  await sendReply('pong');
  const m = lastMsgs();
  assert.equal(m.length, 2, '兩筆合成一則');
  assert.match(m[1].altText, /日本行前待辦（原定 \d\d\/\d\d \d\d:\d\d）/);
  assert.doesNotMatch(m[1].altText, /買機場巴士（原定/, '剛到期的不標原定');
  assert.match(JSON.stringify(m[1].contents), /2 件/);
});
await test('只送附帶的：reply(token, []) 沒東西就不送', async () => {
  const { res } = await sendReply([]);
  assert.equal(res.skipped, true);
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '閒置時送' }, '', { mode: 'exact' });
  setAt(r.id, Date.now() - 60_000);
  const before = line.replies.length;
  const ok = await remindPlugin.onIdleReply({ chatId: G, replyToken: (() => { const ev = event(G); line.noteReplyEvent(ev); return ev.replyToken; })() });
  assert.equal(ok, true);
  assert.equal(line.replies.length, before + 1);
  assert.equal(lastMsgs().length, 1); assert.match(lastMsgs()[0].altText, /閒置時送/);
});
await test('5 則上限：原本 4 則→放第 5 則；原本 5 則→接在最後一則文字後面', async () => {
  const t = (x) => ({ type: 'text', text: x });
  const extra = [{ type: 'flex', altText: '⏰ 提醒：A', contents: {} }, t('B')];
  assert.equal(combine([t(1), t(2), t(3), t(4)], extra).messages.length, 5);
  assert.equal(combine([t(1), t(2), t(3), t(4)], extra).messages[4].text, '⏰ 提醒：A\n\nB');
  const full = combine([t(1), t(2), t(3), t(4), t(5)], extra);
  assert.equal(full.used, true); assert.equal(full.messages.length, 5); assert.match(full.messages[4].text, /^5\n\n⏰ 提醒：A/);
  const noText = combine(Array(5).fill({ type: 'image' }), extra);
  assert.equal(noText.used, false, '沒地方放就留著');
  // 實際走一次：原本 5 則
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '滿了也要送' }, '', { mode: 'exact' });
  setAt(r.id, Date.now() - 60_000);
  await sendReply([t(1), t(2), t(3), t(4), t(5)]);
  assert.equal(lastMsgs().length, 5); assert.match(lastMsgs()[4].text, /滿了也要送/);
});
await test('回覆失敗：提醒留著，下次再送', async () => {
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '失敗重試' }, '', { mode: 'exact' });
  setAt(r.id, Date.now() - 60_000);
  const ev = event(G); line.noteReplyEvent(ev);
  await line.reply(ev.replyToken, 'first');                     // 先用掉
  db.run('UPDATE reminders SET fired = 0 WHERE id = ?', r.id);  // （上一行已帶走，改回未送來測失敗）
  await assert.rejects(line.reply(ev.replyToken, 'again'));     // 同 token 第二次 → 失敗
  assert.equal(db.get('SELECT fired FROM reminders WHERE id = ?', r.id).fired, 0, '失敗不標已送');
  await sendReply('pong');
  assert.match(lastMsgs()[1].altText, /失敗重試/);
});

await test('對齊小帥 held_answers：小帥要用這則回覆時 remind 讓位，提醒併進小帥那次回覆', async () => {
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '跟今日行程一起' }, '', { mode: 'exact' });
  setAt(r.id, Date.now() - 60_000);
  let held = true;
  line.addIdleOwner('xiaoshuai', (id) => id === G && held);
  const ev = event(G); line.noteReplyEvent(ev);
  const before = line.replies.length;
  assert.equal(await remindPlugin.onIdleReply({ chatId: G, replyToken: ev.replyToken }), false, 'remind 不搶');
  assert.equal(line.replies.length, before);
  // 小帥用同一個 token 貼 held（例：☀️ 今天行程）→ 提醒併在同一次回覆
  await line.reply(ev.replyToken, [{ type: 'text', text: '☀️ 今天的行程' }]);
  assert.equal(lastMsgs()[0].text, '☀️ 今天的行程');
  assert.match(lastMsgs()[1].altText, /跟今日行程一起/);
  held = false;
});

await test('同一次回覆已經講到（今日行程有同一件事）→ 不再講一次，但算送過', async () => {
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '日本行前：旅平險、不便險' }, '', { mode: 'exact' });
  setAt(r.id, Date.now() - 60_000);
  await sendReply([{ type: 'text', text: '☀️ 早，今天有 1 件事' }, { type: 'flex', altText: '☀️ 今天 11/25\n09:00 日本行前：旅平險、不便險、網路', contents: {} }]);
  assert.equal(lastMsgs().length, 2, '沒有多附提醒卡');
  assert.equal(db.get('SELECT fired FROM reminders WHERE id = ?', r.id).fired, 1, '算送過');
  assert.equal(remind.coveredBy('今天 09:00 買機場巴士（葶提醒）', '日本行機場巴士今天要買'), false, '不同的事不算');
});

console.log('③ 重啟');
await test('重啟：已到期的只標 due 不推播、未到期重排、送過的不動', async () => {
  const fut = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '還沒到' }, '', { mode: 'exact' });
  const past = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '關機時到期' }, '', { mode: 'exact' });
  setAt(past.id, Date.now() - 10 * 60_000);
  provider.closeAll?.();
  provider = createDatabaseProvider(dir);
  db = provider.getDatabase('remind');
  line = fakeLine();
  sched = fakeScheduler();
  await remindPlugin.init({ db, scheduler: sched, lineApi: line }); // push 被叫到會 throw
  assert.ok(sched.once.has(`remind-${fut.id}`));
  assert.ok(!sched.once.has(`remind-${past.id}`));
  assert.equal(db.get('SELECT due FROM reminders WHERE id = ?', past.id).due, 1);
  assert.equal(db.get('SELECT fired FROM reminders WHERE id = ?', globalThis.__r1).fired, 1);
  await sendReply('pong');
  assert.match(lastMsgs()[1].altText, /關機時到期/);
});

console.log('④ 模擬 webhook 事件');
await test('簽章過的文字事件 → 指令回覆帶上到期提醒；push 沒被叫', async () => {
  const r = remind.createReminder({ userId: 'Uabc', scopeId: G }, { remindAt: new Date(Date.now() + 3600_000), content: '從 webhook 帶出' }, '', { mode: 'exact' });
  setAt(r.id, Date.now() - 60_000);
  const router = createRouter();
  router.add(/^\/ping$/, async () => 'pong', { type: 'query', name: 'ping', plugin: 'remind', scope: 'all' });
  router.setGroupPermissions({ [G]: ['remind'] });
  const secret = 'test-secret';
  const handler = createWebhookHandler({ channelSecret: secret, router, lineApi: line });
  const body = Buffer.from(JSON.stringify({ events: [{ type: 'message', webhookEventId: 'ev1', timestamp: Date.now(), replyToken: 'wtok1', source: { type: 'group', groupId: G, userId: 'Uabc' }, message: { type: 'text', text: '/ping' } }] }));
  const sig = createHmac('sha256', secret).update(body).digest('base64');
  await handler({ rawBody: body, headers: { 'x-line-signature': sig } }, { status: () => ({ end: () => {} }) });
  const last = line.replies.at(-1);
  assert.equal(last.token, 'wtok1');
  assert.equal(last.msgs[0].text, 'pong');
  assert.match(last.msgs[1].altText, /從 webhook 帶出/);
});

console.log('⑤ remind 不再推播');
await test('plugins/remind/index.js 沒有 push 呼叫', () => {
  const src = readFileSync(new URL('../plugins/remind/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.push\s*\(\s*(?:r\.)?scope|lineApi\.push|multicast/);
});

console.log(`\n全部通過：${pass} 項`);
process.exit(0);
