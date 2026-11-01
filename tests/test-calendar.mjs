/**
 * 小帥行事曆測試（不打 AI、不連 LINE；月曆網頁寫到暫存目錄）
 * 執行：node tests/test-calendar.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_DIR = mkdtempSync(join(tmpdir(), 'xs-cal-'));
process.env.XIAOSHUAI_CAL_DIR = PAGE_DIR;
// 旅遊行程的 repo（行事曆直接讀行程每天的摘要）
const TRIP_DIR = mkdtempSync(join(tmpdir(), 'xs-trip-'));
mkdirSync(join(TRIP_DIR, 'trips'));
process.env.TRIP_REPO_DIR = TRIP_DIR;
process.env.XIAOSHUAI_CAL_NO_ENRICH = '1';
process.env.BOT_PUBLIC_URL = 'https://bot.example.test'; // 背景補短標籤／頭像另外測（calmeta），這裡不跑

const cal = await import('../plugins/xiaoshuai/calendar.js');
const polls = await import('../plugins/xiaoshuai/polls.js');
const claims = await import('../plugins/xiaoshuai/claims.js');
const trip = await import('../plugins/xiaoshuai/trip.js');
const { default: xiaoshuai } = await import('../plugins/xiaoshuai/index.js');

let pass = 0;
async function test(name, fn) {
  await fn();
  pass++;
  console.log(`✓ ${name}`);
}

// 台北 2026-10-31（六）12:00 = UTC 04:00
const NOW = Date.UTC(2026, 9, 31, 4, 0, 0);
const at = (h, mi = 0, day = 31, month = 10) => Date.UTC(2026, month - 1, day, h - 8, mi);

async function memDb() {
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(':memory:');
  return { run: (q, ...a) => raw.prepare(q).run(...a), get: (q, ...a) => raw.prepare(q).get(...a), all: (q, ...a) => raw.prepare(q).all(...a), exec: (q) => raw.exec(q) };
}
const when = (s, now = NOW) => { const w = cal.parseWhen(s, now); return w && (w.error ? { error: w.error } : { day: w.day, time: w.time }); };

await test('日期時間：月日、明天、週幾、下週、幾號、只有時間、全天、早晚', () => {
  assert.deepEqual(when('11/5 晚上七點 家長會'), { day: '2026-11-05', time: '19:00' });
  assert.deepEqual(when('11月5日 19:30'), { day: '2026-11-05', time: '19:30' });
  assert.deepEqual(when('明天下午3:30 牙醫'), { day: '2026-11-01', time: '15:30' });
  assert.deepEqual(when('後天 早上九點半'), { day: '2026-11-02', time: '09:30' });
  assert.deepEqual(when('週五下午三點 看牙醫'), { day: '2026-11-06', time: '15:00' });
  assert.deepEqual(when('週六 練球'), { day: '2026-10-31', time: null });            // 今天就是週六
  assert.deepEqual(when('下週六 全天 校外教學'), { day: '2026-11-07', time: null });
  assert.deepEqual(when('這週日 爬山'), { day: '2026-11-01', time: null });
  assert.deepEqual(when('下下週三 開會'), { day: '2026-11-11', time: null });
  assert.deepEqual(when('5號 繳費'), { day: '2026-11-05', time: null });              // 5 號過了 → 下個月
  assert.deepEqual(when('1/10 滑雪'), { day: '2027-01-10', time: null });             // 過了一個月以上 → 明年
  assert.deepEqual(when('10/30 補記'), { day: '2026-10-30', time: null });            // 剛過的還是今年
  assert.deepEqual(when('2027/2/6 青森'), { day: '2027-02-06', time: null });
  assert.deepEqual(when('今晚 9 點 開會'), { day: '2026-10-31', time: '21:00' });
  assert.deepEqual(when('中午一點 吃飯'), { day: null, time: '13:00' });
  assert.deepEqual(when('3點 開會'), { day: null, time: '15:00' });                  // 沒講早晚的 3 點是下午
  assert.deepEqual(when('早上 7:30 集合'), { day: null, time: '07:30' });
  assert.deepEqual(when('明天 多買一點牛奶'), { day: '2026-11-01', time: null });     // 「一點」不是時間
  assert.deepEqual(when('11/5 19:00 全天'), { day: '2026-11-05', time: null });
  assert.ok(when('13/40 亂打').error);
  assert.ok(when('2/30 亂打').error);
  assert.ok(when('明天 25:00').error);
  assert.deepEqual(when('今天好冷'), { day: '2026-10-31', time: null }); // 有日期，要不要記交給規則／AI 判斷
  assert.equal(cal.parseWhen('好冷喔', NOW), null);
  // 只有時間：新增時當今天，過了就明天
  assert.equal(cal.resolveDay({ day: null, time: '19:00' }, NOW), '2026-10-31');
  assert.equal(cal.resolveDay({ day: null, time: '08:00' }, NOW), '2026-11-01');
});

await test('標題與地點：拿掉日期時間、「記一下」「行事曆」，最後的「在○○」當地點', () => {
  const t = (s) => cal.titleOf(s, cal.parseWhen(s, NOW));
  assert.deepEqual(t('小帥 11/5 晚上七點 家長會 在學校禮堂'), { title: '家長會', place: '學校禮堂' });
  assert.deepEqual(t('小帥 記一下 明天下午三點 看牙醫'), { title: '看牙醫', place: '' });
  assert.deepEqual(t('行事曆加 週六 校外教學'), { title: '校外教學', place: '' });
  assert.deepEqual(t('幫我記到行事曆：11/8 棒球隊聚餐 地點 老地方'), { title: '棒球隊聚餐', place: '老地方' });
  assert.equal(t('記得 11/9 帶雨傘').title, '帶雨傘');
});

await test('規則：查詢、明講要記、刪除；其他回 null 交給 AI', () => {
  const r = (s) => cal.ruleIntent(s, NOW);
  assert.deepEqual(r('小帥 這週有什麼').range, { from: '2026-10-31', to: '2026-11-01', label: '這週' });
  assert.deepEqual(r('小帥 下週有哪些事').range, { from: '2026-11-02', to: '2026-11-08', label: '下週' });
  assert.equal(r('小帥 明天行程').range.from, '2026-11-01');
  assert.equal(r('明天有什麼').range.single, true);
  assert.equal(r('小帥 11/5 有什麼').range.from, '2026-11-05');
  assert.equal(r('週六有事嗎').range.from, '2026-10-31');
  assert.equal(r('小帥 這個月').range.month, true);
  assert.equal(r('下個月有什麼').range.from, '2026-11-01');
  assert.equal(r('小帥 行事曆').action, 'query');
  assert.equal(r('看一下行事曆').action, 'query');
  const add = r('小帥 記一下 11/5 晚上七點 家長會');
  assert.equal(add.action, 'add');
  assert.equal(add.title, '家長會');
  assert.equal(add.when.time, '19:00');
  assert.equal(r('小帥 行事曆加 下週六 校外教學').when.day, '2026-11-07');
  assert.ok(r('記一下 13/40 開會').error);
  assert.deepEqual(r('小帥 刪掉 家長會'), { action: 'delete', target: '家長會' });
  assert.equal(r('小帥 11/5 晚上七點 家長會'), null);       // 沒明講要記：交給 AI 確認
  assert.equal(r('小帥 今天好冷'), null);
  assert.equal(r('小帥 你好'), null);
  // 值不值得問 AI：一開頭是日期而且不是問句
  assert.equal(cal.looksLikeCalendar('小帥 11/5 晚上七點 家長會', NOW), true);
  assert.equal(cal.looksLikeCalendar('小帥 牙醫改到下午四點', NOW), true);
  assert.equal(cal.looksLikeCalendar('小帥 東京明天會下雪嗎', NOW), false);
  assert.equal(cal.looksLikeCalendar('小帥 明天會下雨嗎', NOW), false);
  assert.equal(cal.looksLikeCalendar('小帥 你好', NOW), false);
});

await test('資料：新增、重複、過去的日子、上限；改（只改有講的部分）、刪；只有加的人或 TED', async () => {
  cal.initCalendar(await memDb(), { dir: PAGE_DIR });
  const r = cal.add('G1', { day: '2026-11-05', time: '19:00', title: '家長會', place: '學校禮堂', by: 'U1', byName: '葶' }, NOW);
  assert.ok(r.ok);
  assert.equal(cal.whenLabel(r.event), '11/5（四） 19:00');
  assert.ok(cal.add('G1', { day: '2026-11-05', time: '19:00', title: '家長會', by: 'U2' }, NOW).dup);
  assert.match(cal.add('G1', { day: '2026-10-30', title: '過去', by: 'U1' }, NOW).error, /已經過了/);
  assert.match(cal.add('G1', { day: '2026-11-05', title: '', by: 'U1' }, NOW).error, /要記什麼/);
  assert.match(cal.add('G1', { day: 'xx', title: 'a', by: 'U1' }, NOW).error, /哪一天/);
  // 別人改不了、TED 可以
  assert.match(cal.edit('G1', r.event.id, 'U2', false, { w: cal.parseWhen('下午四點', NOW) }, NOW).error, /只有加的人（葶）或 TED/);
  // 只講時間：日期不變
  let e = cal.edit('G1', r.event.id, 'UADMIN', true, { w: cal.parseWhen('晚上八點', NOW) }, NOW);
  assert.equal(e.event.day, '2026-11-05');
  assert.equal(e.event.time, '20:00');
  // 只講日期：時間不變；明講全天才拿掉時間
  e = cal.edit('G1', r.event.id, 'U1', false, { w: cal.parseWhen('11/6', NOW) }, NOW);
  assert.deepEqual([e.event.day, e.event.time], ['2026-11-06', '20:00']);
  e = cal.edit('G1', r.event.id, 'U1', false, { w: cal.parseWhen('11/6 全天', NOW) }, NOW);
  assert.equal(e.event.time, null);
  assert.match(cal.edit('G1', r.event.id, 'U1', false, { w: cal.parseWhen('11/6 全天', NOW) }, NOW).error, /一樣/);
  // 別的聊天的 ID 動不了
  assert.match(cal.remove('G2', r.event.id, 'U1', true).error, /找不到/);
  assert.match(cal.remove('G1', r.event.id, 'U2', false).error, /只有加的人/);
  assert.ok(cal.remove('G1', r.event.id, 'U1', false).ok);
  assert.ok(cal.getEvent(r.event.id).deleted_at); // 軟刪除，可以還原
  // 每天最多加 30 件
  for (let i = 0; i < cal.MAX_ADD_PER_DAY; i++) cal.add('G3', { day: '2026-11-10', title: `事${i}`, by: 'U1' }, NOW);
  assert.match(cal.add('G3', { day: '2026-11-10', title: '再一件', by: 'U1' }, NOW).error, /今天已經加了/);
  // 一年前的會被清掉
  cal.add('G4', { day: '2026-11-01', title: '舊的', by: 'U1' }, NOW);
  cal.prune(NOW + 400 * 86400_000);
  assert.equal(cal.futureEvents('G4', NOW).length, 0);
});

await test('找是哪一件：標題、相同的詞、同名用日期挑；分不出來列出來問', async () => {
  cal.initCalendar(await memDb(), { dir: PAGE_DIR });
  cal.add('G', { day: '2026-11-05', time: '19:00', title: '家長會', by: 'U1' }, NOW);
  cal.add('G', { day: '2026-11-12', time: '19:00', title: '家長會', by: 'U1' }, NOW);
  cal.add('G', { day: '2026-11-06', time: '15:00', title: '看牙醫', by: 'U1' }, NOW);
  assert.equal(cal.pickEvent('G', '牙醫', NOW).event.title, '看牙醫');
  assert.equal(cal.pickEvent('G', '家長會', NOW).ask.length, 2);
  assert.equal(cal.pickEvent('G', '11/12 家長會', NOW).event.day, '2026-11-12');
  assert.deepEqual(cal.pickEvent('G', '烤肉', NOW), {});
});

await test('查詢：一天一張卡、今天標橘色、投票截止一起列、看整個月按鈕只連自己的網址', async () => {
  const db = await memDb();
  polls.initPolls(db);
  cal.initCalendar(db, { dir: PAGE_DIR, base: 'https://bot.example.test' });
  cal.add('G', { day: '2026-10-31', time: '20:00', title: '繳午餐費', by: 'U1', byName: '妞媽' }, NOW);
  cal.add('G', { day: '2026-11-01', title: '校外教學', place: '動物園', by: 'U1' }, NOW);
  cal.add('GX', { day: '2026-11-01', title: '別群的事', by: 'U1' }, NOW);
  polls.create('G', { kind: 'vote', title: '聖誕聚餐地點', options: ['A', 'B'], by: 'U1', closesAt: at(21, 0, 1, 11) }, NOW);
  const range = cal.rangeOf('week', NOW);
  const byDay = cal.itemsBetween([{ chatId: 'G', label: '' }], range.from, range.to, NOW);
  assert.deepEqual([...byDay.keys()], ['2026-10-31', '2026-11-01']);
  assert.deepEqual(byDay.get('2026-11-01').map(i => i.title), ['校外教學', '聖誕聚餐地點 投票截止']);
  const url = cal.writePage('G', [{ chatId: 'G', label: '' }], { title: '測試群 行事曆', now: NOW });
  assert.match(url, /^https:\/\/bot\.example\.test\/public\/cal\/[0-9a-f]{32}\.html\?v=\d+#k=[A-Za-z0-9_-]{32}$/); // 編輯碼放 fragment
  const msgs = cal.queryMessages(range, byDay, { url, now: NOW });
  assert.match(msgs[0].text, /這週 2 天有事（共 3 件），往右滑/);
  const bubbles = msgs[1].contents.contents;
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0].header.backgroundColor, cal.TODAY_COLOR);
  assert.match(JSON.stringify(bubbles[0].header), /10\/31（六）・今天/);
  assert.equal(bubbles[1].header.backgroundColor, cal.CAL_COLOR);
  assert.match(JSON.stringify(bubbles[1]), /🗳️ 聖誕聚餐地點 投票截止/);
  assert.match(JSON.stringify(bubbles[1]), /📍 動物園/);
  assert.equal(bubbles[0].footer.contents[0].action.uri, url);
  assert.ok(!JSON.stringify(msgs).includes('別群的事'));
  assert.match(msgs[1].altText, /20:00 繳午餐費/);
  // 別人的網址不放
  const evil = cal.queryMessages(range, byDay, { url: 'https://evil.example/x', now: NOW });
  assert.equal(evil[1].contents.contents[0].footer, undefined);
  // 沒事
  const none = cal.queryMessages(cal.rangeOf('明天', NOW), new Map(), { now: NOW });
  assert.equal(none[0].text, '明天 11/1（日）沒有排事情 🙌');
  assert.equal(cal.queryMessages(cal.dayRange('2026-11-09'), new Map(), { now: NOW })[0].text, '11/9（一）沒有排事情 🙌');
  // 私訊含群組：標出是哪裡的
  const both = cal.itemsBetween([{ chatId: 'G', label: '我的' }, { chatId: 'GX', label: '家長群' }], '2026-11-01', '2026-11-01', NOW);
  const card = JSON.stringify(cal.queryMessages(cal.dayRange('2026-11-01'), both, { showSrc: true, now: NOW }));
  assert.match(card, /👥 家長群/);
  assert.match(card, /🙋 我的/);
});

await test('月曆網頁：同一個聊天網址固定、資料當文字（標題有 HTML 也不會執行）', async () => {
  cal.initCalendar(await memDb(), { dir: PAGE_DIR, base: 'https://bot.example.test' });
  // 完整的標籤在 cards.clean 就拿掉了；沒收尾的「</script」會留下來，要靠 JSON 跳脫
  assert.ok(cal.add('GH', { day: '2026-11-05', time: '19:00', title: '<img src=x onerror=alert(1)>家長會', by: 'U1' }, NOW).event.title === '家長會');
  assert.ok(cal.add('GH', { day: '2026-11-06', time: '19:00', title: 'a</script b & c', by: 'U1' }, NOW).ok);
  const u1 = cal.writePage('GH', [{ chatId: 'GH', label: '' }], { now: NOW });
  const u2 = cal.writePage('GH', [{ chatId: 'GH', label: '' }], { now: NOW + 1000 });
  assert.equal(u1.split('?')[0], u2.split('?')[0]);
  const file = readdirSync(PAGE_DIR).find(f => u1.includes(f));
  const html = readFileSync(join(PAGE_DIR, file), 'utf8');
  assert.equal((html.match(/<\/script>/g) || []).length, 1);   // 只有頁面自己那個
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('a\\u003c/script b \\u0026 c'));
  assert.ok(html.includes('"n":"家長會"'));
  assert.match(html, /noindex/);
  assert.ok(!/src=["']https?:/.test(html));                    // 不連外部資源
  assert.ok(!html.includes('innerHTML'));
  // 小帥的週末手帳：頭像、空白狀態用同網域的圖（相對路徑、檔案要在 repo 裡），招呼與空白日的話
  for (const f of ['avatar.jpg', 'note.jpg']) {
    assert.ok(html.includes(`'../xiaoshuai/${f}?v=`), f);
    assert.ok(readFileSync(join(import.meta.dirname, '..', 'public', 'xiaoshuai', f)).length > 1000, f);
  }
  assert.ok(!/url\(\s*['"]?https?:/.test(html));
  for (const s of ['我幫大家記好了', '這天先留給自由發揮', '這個月，行程還很佛系', '更新好了，有事再叫我', '#FFF9EF', '#287C78']) assert.ok(html.includes(s), s);
});

await test('早報：7 點後第一次、今天有事才排；一天一次；今天內有效', async () => {
  cal.initCalendar(await memDb(), { dir: PAGE_DIR });
  cal.add('GD', { day: '2026-11-05', time: '19:00', title: '家長會', place: '學校禮堂', by: 'U1' }, NOW);
  const day5 = (h, mi = 0) => at(h, mi, 5, 11);
  assert.equal(cal.morningDigest('GD', { now: day5(6, 59) }), null);  // 還沒 7 點
  const d = cal.morningDigest('GD', { now: day5(7, 10) });
  assert.equal(d.text, '☀️ 早，今天有 1 件事 👇');
  assert.match(JSON.stringify(d.msgs[0]), /家長會/);
  assert.equal(d.msgs[0].contents.header.backgroundColor, cal.TODAY_COLOR);
  assert.equal(d.keepMs, day5(24) - day5(7, 10));                       // 到今天 24:00
  assert.equal(cal.morningDigest('GD', { now: day5(8) }), null);        // 今天排過了
  assert.equal(cal.morningDigest('GD', { now: at(8, 0, 6, 11) }), null); // 11/6 沒事
  assert.equal(cal.morningDigest('GEMPTY', { now: day5(9) }), null);
});

await test('完成宣稱：AI 自己說「記到行事曆了」會被拿掉', () => {
  const g = claims.guardClaims('好喔，我幫你記到行事曆了！', new Set());
  assert.ok(g.removed.includes('cal'));
  assert.match(g.reply, /行事曆還沒記/);
  assert.equal(claims.guardClaims('11/5 有家長會喔', new Set()).removed.length, 0);
});

// ── 接上小帥：群組、私訊、按鈕 ─────────────────────

const NAMES = { U1: '葶', U2: '妞媽', UADMIN: 'TED' };
const md = (k) => `${+k.slice(5, 7)}/${+k.slice(8)}`;
const D3 = cal.addDays(cal.todayKey(), 3);
const D4 = cal.addDays(cal.todayKey(), 4);

async function calBot({ intent = '{"action":"none"}' } = {}) {
  const db = await memDb();
  const replies = [];
  const asked = [];
  const lineApi = { reply: async (_t, m) => { replies.push(Array.isArray(m) ? m : [{ type: 'text', text: m }]); return {}; }, push: async () => { throw new Error('不該推播'); },
    getGroupMemberProfile: async (_g, u) => ({ displayName: NAMES[u] || '某人' }), getProfile: async (u) => ({ displayName: NAMES[u] || '某人' }) };
  const ctx = { db, lineApi, isAdmin: (u) => u === 'UADMIN', providers: { llm: { generate: async ({ messages, system }) => {
    const c = messages[0].content;
    if (!system && c.includes('要處理行事曆')) { asked.push(c); return typeof intent === 'function' ? intent(c) : intent; }
    return { text: '{"reply":"在喔"}' };
  } } } };
  await xiaoshuai.init(ctx);
  for (const g of ['GC', 'GTRIP']) db.run('INSERT INTO groups (chat_id, enabled) VALUES (?, 1)', g);
  db.run("INSERT INTO trip_binds (chat_id, name) VALUES ('GTRIP', 'ski-2026')");
  await xiaoshuai.init(ctx);
  let seq = 9000;
  const say = async (userId, text, chatId = 'GC') => {
    const id = String(++seq);
    const event = { message: { type: 'text', id, text } };
    xiaoshuai.onGroupText({ chatId, userId, text, event });
    const n = replies.length;
    await xiaoshuai.onUnmatched({ chatId, userId, text, replyToken: `rt${id}`, event });
    return replies.length > n ? replies.at(-1) : null;
  };
  const dm = async (userId, text) => {
    const id = String(++seq);
    const event = { message: { type: 'text', id, text } };
    xiaoshuai.onGroupText({ chatId: userId, userId, text, event });
    const n = replies.length;
    const handled = await xiaoshuai.onPrivateText({ userId, text, replyToken: `dm${id}`, event });
    return { handled, reply: replies.length > n ? replies.at(-1) : null };
  };
  const press = async (userId, data, chatId = 'GC') => {
    const n = replies.length;
    const handled = await xiaoshuai.onPostback({ chatId, userId, data, replyToken: `pb${++seq}` });
    return { handled, reply: replies.length > n ? replies.at(-1) : null };
  };
  return { db, replies, asked, say, dm, press };
}

await test('群組：明講要記 → 記好卡（刪掉／這週／整個月）；按刪掉只有加的人能刪', async () => {
  const { db, say, press, asked } = await calBot();
  const r = await say('U1', `小帥 記一下 ${md(D3)} 晚上七點 家長會 在學校禮堂`);
  assert.equal(r[0].text, '記好了 📅');
  const card = r[1].contents;
  assert.equal(card.header.backgroundColor, cal.CAL_COLOR);
  assert.match(JSON.stringify(card.header), /📅 行事曆・葶加的/);
  assert.match(JSON.stringify(card.body), /19:00/);
  assert.match(JSON.stringify(card.body), /學校禮堂/);
  const row = db.get('SELECT * FROM cal_events');
  assert.deepEqual([row.chat_id, row.day, row.time, row.title, row.place, row.created_by], ['GC', D3, '19:00', '家長會', '學校禮堂', 'U1']);
  const btns = card.footer.contents[0].contents.map(b => b.action);
  assert.deepEqual(btns[0], { type: 'postback', label: '🗑️ 刪掉', data: `cal:del:${row.id}`, displayText: '🗑️ 刪掉 家長會' });
  assert.equal(btns[1].data, 'cal:week');
  assert.match(card.footer.contents[1].action.uri, /\/public\/cal\/[0-9a-f]{32}\.html/);
  assert.equal(asked.length, 0);                                           // 明講要記不用問 AI
  // 重複記
  assert.match((await say('U2', `小帥 記一下 ${md(D3)} 晚上七點 家長會`))[0].text, /已經有了/);
  // 別人按刪掉
  assert.match((await press('U2', `cal:del:${row.id}`)).reply[0].text, /只有加的人（葶）或 TED/);
  // 別群按這個 ID
  const other = await press('U1', `cal:del:${row.id}`, 'GTRIP');
  assert.match(other.reply[0].text, /不在行事曆裡/);
  assert.ok(cal.getEvent(row.id));
  // 加的人按
  assert.match((await press('U1', `cal:del:${row.id}`)).reply[0].text, /刪掉了：.+ 19:00 家長會/);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE deleted_at IS NULL').n, 0);
});

await test('群組：沒明講要記 → 問 AI 確認是記事；AI 說 none 就照常聊天；問天氣不問 AI', async () => {
  const intent = (c) => (c.includes('家長會') ? `{"action":"add","title":"家長會","when":"${md(D3)} 晚上七點","place":""}` : '{"action":"none"}');
  const { db, say, asked } = await calBot({ intent });
  const r = await say('U1', `小帥 ${md(D3)} 晚上七點 家長會`);
  assert.equal(r[0].text, '記好了 📅');
  assert.equal(db.get('SELECT time FROM cal_events').time, '19:00');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /今天是 /);
  await say('U1', `小帥 ${md(D4)} 好冷`);          // AI 說不是記事 → 不記
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE deleted_at IS NULL').n, 1);
  const before = asked.length;
  await say('U1', '小帥 東京明天會下雪嗎');
  assert.equal(asked.length, before);               // 問句不問 AI
  // 沒叫小帥不處理
  assert.equal(await say('U1', `記一下 ${md(D4)} 烤肉`), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE deleted_at IS NULL').n, 1);
});

await test('群組：查詢、改時間、刪除（AI 認出要改哪一件）', async () => {
  const intent = (c) => (c.includes('改到') ? `{"action":"edit","target":"家長會","new_when":"八點"}` : '{"action":"none"}');
  const { say } = await calBot({ intent });
  await say('U1', `小帥 記一下 ${md(D3)} 晚上七點 家長會`);
  await say('U2', `小帥 記一下 ${md(D4)} 校外教學`);
  const q = await say('U2', `小帥 ${md(D3)} 有什麼`);
  assert.match(q[0].text, /有 1 件事/);
  assert.match(JSON.stringify(q[1]), /家長會/);
  const up = await say('U1', '小帥 最近有什麼');
  assert.match(up[0].text, /2 天有事（共 2 件）/);
  const e = await say('U1', '小帥 家長會改到八點');
  assert.match(e[0].text, /改好了：.+19:00 → .+20:00/);
  assert.match((await say('U2', '小帥 刪掉 家長會'))[0].text, /只有加的人（葶）或 TED/);
  assert.match((await say('UADMIN', '小帥 刪掉 家長會'))[0].text, /刪掉了/);
  assert.match((await say('U2', '小帥 刪掉 烤肉'))[0].text, /找不到「烤肉」/);
});

await test('綁了旅遊行程的群：行事曆帶出行程每天（附連到行程那天）；查詢照樣接，新增要講「行事曆」', async () => {
  const y = +D3.slice(0, 4);
  writeFileSync(join(TRIP_DIR, 'trips', 'ski-2026.json'), JSON.stringify({ meta: { title: `${y} 滑雪團` }, days: [
    { date: md(D3), glance: { d: md(D3), emoji: '⛷️', place: '神樂滑雪場（請教練）' } },
    { date: md(D4), glance: { d: md(D4), emoji: '💙', place: '🛍️ 三井 Outlet' } },
  ] }));
  const { db, say } = await calBot();
  const r = await say('U1', '小帥 最近有什麼', 'GTRIP');
  assert.match(r[0].text, /2 天有事（共 2 件）/);
  const bubbles = r[1].contents.contents;
  assert.match(JSON.stringify(bubbles[0].body), /⛷️ 神樂滑雪場（請教練）/);
  assert.match(JSON.stringify(bubbles[0].body), /🧳 旅遊行程/);
  assert.match(JSON.stringify(bubbles[1].body), /💙 三井 Outlet/);
  assert.deepEqual(bubbles[0].footer.contents[0].action, { type: 'uri', label: '🧳 看這天行程', uri: 'https://badbadted.github.io/temp-reports/ski-2026.html#d1' });
  assert.equal(bubbles[1].footer.contents[0].action.uri, 'https://badbadted.github.io/temp-reports/ski-2026.html#d2');
  assert.equal(db.get("SELECT COUNT(*) n FROM cal_events WHERE chat_id = 'GTRIP' AND deleted_at IS NULL").n, 0); // 只讀，不另存
  // 新增：沒講「行事曆」可能是在改旅遊行程，不接；講了才記
  await say('U1', `小帥 記一下 ${md(D3)} 晚上 燒肉`, 'GTRIP');
  assert.equal(db.get("SELECT COUNT(*) n FROM cal_events WHERE chat_id = 'GTRIP' AND deleted_at IS NULL").n, 0);
  await say('U1', `小帥 行事曆加 ${md(D3)} 滑雪課`, 'GTRIP');
  assert.equal(db.get("SELECT title FROM cal_events WHERE chat_id = 'GTRIP'").title, '滑雪課');
  // 行程那幾筆刪不掉（不在行事曆的資料裡）
  assert.match((await say('U1', '小帥 刪掉行事曆的 神樂滑雪場', 'GTRIP'))[0].text, /找不到/);
  // 沒綁行程的群不會出現
  const other = await say('U1', '小帥 最近有什麼', 'GC');
  assert.ok(!JSON.stringify(other).includes('神樂'));
});

await test('行程每天的摘要：標題年份、跨年、連到那一天、去掉重複 emoji；網址只收行程網頁', async () => {
  writeFileSync(join(TRIP_DIR, 'trips', 'newyear.json'), JSON.stringify({ meta: { title: '2026 跨年團' }, days: [
    { glance: { d: '12/31', emoji: '🎆', place: '倒數' } }, { glance: { d: '1/1', emoji: '⛩️', place: '⛩️ 初詣' } }, { date: '沒日期' }] }));
  assert.deepEqual(trip.daysOf('newyear', 2000, TRIP_DIR), [
    { day: '2026-12-31', n: 1, title: '🎆 倒數', url: 'https://badbadted.github.io/temp-reports/newyear.html#d1', name: 'newyear' },
    { day: '2027-01-01', n: 2, title: '⛩️ 初詣', url: 'https://badbadted.github.io/temp-reports/newyear.html#d2', name: 'newyear' },
  ]);
  assert.deepEqual(trip.daysOf('../etc', 2026, TRIP_DIR), []);
  assert.deepEqual(trip.daysOf('nope', 2026, TRIP_DIR), []);
  // 網址不是行程網頁的：不放連結
  cal.initCalendar(await memDb(), { dir: PAGE_DIR, trips: () => [{ day: '2026-11-05', title: '怪怪的', url: 'https://evil.example/x' }, { day: '2026-11-06', title: '正常', url: 'https://badbadted.github.io/temp-reports/a.html#d2' }] });
  const byDay = cal.itemsBetween([{ chatId: 'G', label: '' }], '2026-11-01', '2026-11-30', NOW);
  assert.equal(byDay.get('2026-11-05')[0].url, null);
  const msgs = cal.queryMessages(cal.rangeOf('next_week', NOW), byDay, { now: NOW });
  assert.equal(msgs[1].contents.contents[0].footer, undefined);
  assert.match(JSON.stringify(msgs[1].contents.contents[1].footer), /a.html#d2/);
  // 月曆網頁：行程那筆標「旅遊行程」、帶網址（前端再驗一次才給連結）
  cal.writePage('GT', [{ chatId: 'GT', label: '' }], { now: NOW });
  const html = readFileSync(join(PAGE_DIR, readdirSync(PAGE_DIR).filter(f => f.endsWith('.html')).map(f => [f, readFileSync(join(PAGE_DIR, f), 'utf8')]).find(([, h]) => h.includes('"n":"正常"'))[0]), 'utf8');
  assert.ok(html.includes('"k":1,"u":"https://badbadted.github.io/temp-reports/a.html#d2"'));
  assert.ok(html.includes("TRIP_RE.test(i.u || '')"));
  assert.ok(html.includes('看行程 ›'));
  cal.initCalendar(await memDb(), { dir: PAGE_DIR, trips: () => [] });
});

await test('私訊：只有 TED；跟群組分開存；含群組才一起列', async () => {
  const { db, say, dm, press } = await calBot();
  await say('U1', `小帥 記一下 ${md(D3)} 晚上七點 家長會`);
  const a = await dm('UADMIN', `記一下 ${md(D3)} 下午三點 看牙醫`);
  assert.ok(a.handled);
  assert.equal(a.reply[0].text, '記好了 📅');
  assert.equal(a.reply[1].contents.header.backgroundColor, cal.MINE_COLOR);
  assert.match(JSON.stringify(a.reply[1].contents.header), /我的行事曆/);
  assert.equal(db.get("SELECT chat_id FROM cal_events WHERE title = '看牙醫'").chat_id, 'UADMIN');
  // 只看自己的
  const mine = await dm('UADMIN', `${md(D3)} 有什麼`);
  assert.match(JSON.stringify(mine.reply), /看牙醫/);
  assert.ok(!JSON.stringify(mine.reply).includes('家長會'));
  // 含群組：TED 在的群一起列，標出是哪裡的
  const all = await dm('UADMIN', '最近有什麼（含群組）');
  const s = JSON.stringify(all.reply);
  assert.match(s, /看牙醫/);
  assert.match(s, /家長會/);
  assert.match(s, /👥/);
  // 群組的人按不到私訊的 ID
  const id = db.get("SELECT id FROM cal_events WHERE title = '看牙醫'").id;
  assert.match((await press('U1', `cal:del:${id}`)).reply[0].text, /不在行事曆裡/);
  // 私訊刪
  assert.match((await dm('UADMIN', '刪掉 看牙醫')).reply[0].text, /刪掉了/);
  // 不是 TED 的私訊：小帥不接
  assert.equal((await dm('U1', `記一下 ${md(D3)} 看牙醫`)).handled, false);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE deleted_at IS NULL').n, 1);
  // 按「這週行程」
  const wk = await press('UADMIN', 'cal:week', 'UADMIN');
  assert.ok(wk.handled && wk.reply);
});

await test('早報接上小帥：今天有事，7 點後第一則訊息排進免費回覆（不推播）', async () => {
  const { db } = await calBot();
  const today = cal.todayKey();
  db.run('INSERT INTO cal_events (chat_id, day, time, title, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'GC', today, '23:59', '今天的事', 'U1', Date.now());
  xiaoshuai.onGroupText({ chatId: 'GC', userId: 'U2', text: '早安', event: { message: { type: 'text', id: 'x1', text: '早安' } } });
  const held = db.all("SELECT text FROM held_answers WHERE chat_id = 'GC'");
  const hour = +new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 13);
  if (hour >= cal.DIGEST_HOUR) assert.deepEqual(held.map(h => h.text), ['☀️ 早，今天有 1 件事 👇']);
  else assert.equal(held.length, 0);
  xiaoshuai.onGroupText({ chatId: 'GC', userId: 'U2', text: '再一句', event: { message: { type: 'text', id: 'x2', text: '再一句' } } });
  assert.equal(db.all("SELECT text FROM held_answers WHERE chat_id = 'GC'").length, held.length); // 一天一次
});

await test('多筆拆句：換行、頓號、日期後的（四）、地點在○○；沒日期的段落接到前一筆；看不懂的日期留著標錯', () => {
  const paste = '小帥 幫我記：\n11/5（四）18:30 家長日\n11/7 校外教學 地點在動物園\n帶便當\n13/40 亂打\n11/12 運動會';
  assert.deepEqual(cal.splitItems(paste, NOW).map(i => i.text), ['11/5(四)18:30 家長日', '11/7 校外教學 地點在動物園 帶便當', '13/40 亂打', '11/12 運動會']);
  const items = cal.ruleItems(paste, NOW);
  assert.deepEqual(items.map(i => i.title || i.raw), ['家長日', '校外教學 地點在動物園 帶便當', '13/40 亂打', '運動會']);
  assert.equal(items[0].when.time, '18:30');
  assert.match(items[2].error, /不是正確的日期/);
  assert.deepEqual(cal.ruleItems('11/5 家長會、11/7 校外教學 在動物園', NOW).map(i => [i.title, i.place, i.when.day]),
    [['家長會', '', '2026-11-05'], ['校外教學', '動物園', '2026-11-07']]);
  // 混了問句：問句那段不算
  assert.deepEqual(cal.ruleItems('11/5 晚上七點 家長會，還有明天會下雨嗎？', NOW).map(i => i.title), ['家長會']);
  // 好幾筆一律交給 AI 整理（規則不搶）；一筆照舊
  assert.equal(cal.ruleIntent('小帥 記一下 11/5 家長會、11/7 校外教學', NOW), null);
  assert.equal(cal.looksLikeCalendar('小帥 11/5 家長會\n11/7 校外教學', NOW), true);
  assert.equal(cal.looksLikeCalendar('小帥 明天會下雨嗎', NOW), false);
  assert.equal(cal.ruleIntent('小帥 記一下 11/5 家長會', NOW).action, 'add');
});

const D5 = cal.addDays(cal.todayKey(), 5);
const multiAi = (items) => (c) => (c.includes('要處理行事曆') ? JSON.stringify({ action: 'add', items }) : '{"action":"none"}');

await test('多筆：貼一段 → AI 整理好直接全部記，回「記好了 N 筆」＋左右滑卡；看不懂日期的那筆列出來、其他照記', async () => {
  const intent = multiAi([
    { title: '家長日', when: `${md(D3)} 18:30`, place: '' },
    { title: '校外教學', when: `${md(D4)}`, place: '動物園' },
    { title: '運動會', when: `${md(D5)} 早上八點`, place: '' },
    { title: '戶外教學說明會', when: '下學期某天', place: '' },
  ]);
  const { db, say, asked } = await calBot({ intent });
  const r = await say('U1', `小帥 幫我記一下學校行事曆：\n${md(D3)}（四）18:30 家長日\n${md(D4)} 校外教學 地點在動物園\n${md(D5)} 早上八點 運動會\n下學期某天 戶外教學說明會`);
  assert.equal(asked.length, 1);
  assert.match(r[0].text, /^記好了 3 筆 📅，往右滑看 👉\n這幾筆沒記，日期看不懂：戶外教學說明會（日期看不懂）$/);
  assert.equal(r[1].contents.type, 'carousel');
  assert.equal(r[1].contents.contents.length, 3);
  assert.match(JSON.stringify(r[1].contents.contents[1]), /動物園/);
  assert.match(r[1].altText, /18:30 家長日/);
  assert.deepEqual(db.all('SELECT day, time, title FROM cal_events ORDER BY day').map(e => [e.day, e.time, e.title]),
    [[D3, '18:30', '家長日'], [D4, null, '校外教學'], [D5, '08:00', '運動會']]);
  // 再貼一次：重複的不再記
  const again = await say('U1', `小帥 ${md(D3)} 18:30 家長日\n${md(D4)} 校外教學`);
  assert.match(again[0].text, /已經有了，沒重複記/);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE deleted_at IS NULL').n, 3);
});

await test('多筆：一句講兩件事、混了問句（AI 只列真的事）；全部看不懂就說哪幾筆沒記', async () => {
  const { db, say } = await calBot({ intent: (c) => {
    if (!c.includes('要處理行事曆')) return '{"action":"none"}';
    if (c.includes('亂寫')) return JSON.stringify({ action: 'add', items: [{ title: '亂寫', when: '某天' }, { title: '亂寫二', when: '' }] });
    return JSON.stringify({ action: 'add', items: [{ title: '家長會', when: `${md(D3)} 晚上七點` }, { title: '繳費', when: `${md(D4)}` }] });
  } });
  const r = await say('U2', `小帥 ${md(D3)} 晚上七點 家長會，${md(D4)} 要繳費，還有明天會下雨嗎？`);
  assert.equal(r[0].text, '記好了 2 筆 📅，往右滑看 👉');
  assert.deepEqual(db.all('SELECT title FROM cal_events ORDER BY day').map(e => e.title), ['家長會', '繳費']);
  const bad = await say('U2', `小帥 ${md(D3)} 亂寫、${md(D4)} 亂寫`);
  assert.equal(bad[0].text, '這幾筆沒記，日期看不懂：亂寫（日期看不懂）、亂寫二（日期看不懂）');
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE deleted_at IS NULL').n, 2);
});

await test('多筆：AI 沒回應 → 照規則拆著記（問句跳過）；一筆的就不硬記', async () => {
  const { db, say } = await calBot({ intent: () => { throw new Error('timeout'); } });
  const r = await say('U1', `小帥 ${md(D3)} 晚上七點 家長會\n${md(D4)} 校外教學 在動物園\n明天會下雨嗎？`);
  assert.match(r[0].text, /記好了 2 筆/);
  assert.deepEqual(db.all('SELECT title, place FROM cal_events ORDER BY day').map(e => [e.title, e.place]), [['家長會', ''], ['校外教學', '動物園']]);
  await say('U1', `小帥 ${md(D5)} 牙醫`);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE deleted_at IS NULL').n, 2);
});

await test('單筆沒明講「記」：AI 判斷是記事就直接記，不問使用者', async () => {
  const { db, say } = await calBot({ intent: multiAi([{ title: '看牙醫', when: `${md(D3)} 下午三點` }]) });
  const r = await say('U1', `小帥 ${md(D3)} 下午三點 看牙醫`);
  assert.equal(r[0].text, '記好了 📅');
  assert.equal(r[1].contents.type, 'bubble');
  assert.equal(db.get('SELECT time FROM cal_events').time, '15:00');
});

// ── 格子放大版（2026-11-01）：短標籤、參加的人、頭像 ──
const meta = await import('../plugins/xiaoshuai/calmeta.js');
const uid = (n) => 'U' + String(n).repeat(32).slice(0, 32);
function seedMembers(db, chat, list) {
  list.forEach(([n, name, pic = '']) => db.run('INSERT INTO cal_members (chat_id, user_id, name, pic, fetched_at) VALUES (?, ?, ?, ?, ?)', chat, uid(n), name, pic, pic ? NOW : 0));
}
const SKI = [[1, '葶'], [2, '陳二銘（綸/鈞)'], [3, '🌟Ying.chen💎'], [4, 'Jasmine'], [5, '翁小娟💎'], [6, 'Bi Chan'], [7, '古嘉文（綸&鈞媽）']];

await test('短標籤備用：去 emoji 和符號、最多 6 個字', () => {
  assert.equal(meta.fallbackShort('⛷️ 神樂滑雪場 → 🌃 新宿'), '神樂滑雪場');
  assert.equal(meta.fallbackShort('家長會'), '家長會');
  assert.equal(meta.fallbackShort('🎆 跨年煙火晚會倒數活動'), '跨年煙火晚會');
});

await test('稱呼對到成員：暱稱、小孩名同一家、全員、記過的家庭；對不到不亂配', async () => {
  const db = await memDb();
  cal.initCalendar(db, { dir: PAGE_DIR });
  seedMembers(db, 'GS', SKI);
  const who = (t) => meta.resolveName('GS', t).map(u => SKI.find(([n]) => uid(n) === u)[1]);
  assert.deepEqual(who('葶家'), ['葶']);
  assert.deepEqual(who('葶'), ['葶']);
  assert.deepEqual(who('陳二銘家'), ['陳二銘（綸/鈞)', '古嘉文（綸&鈞媽）']);
  assert.deepEqual(who('綸家'), ['陳二銘（綸/鈞)', '古嘉文（綸&鈞媽）']);
  assert.deepEqual(who('Jasmine'), ['Jasmine']);
  assert.equal(who('全員').length, 7);
  assert.deepEqual(who('妞家'), []);          // 暱稱裡沒有：不顯示
  assert.deepEqual(who('恩爸'), []);
  // 記下來之後：妞家、妞媽、妞嬤都對到
  assert.ok(meta.setFamily('GS', '妞', '葶', NOW).ok);
  assert.deepEqual(who('妞家'), ['葶']);
  assert.deepEqual(who('妞嬤'), ['葶']);
  const r = meta.setFamily('GS', '恩家', 'Jasmine、bi chan 和 不認識的人', NOW);
  assert.deepEqual(r.names, ['Jasmine', 'Bi Chan']);
  assert.deepEqual(r.miss, ['不認識的人']);
  assert.deepEqual(who('恩媽'), ['Jasmine', 'Bi Chan']);
  // 不像家庭、一個人都對不到：不記（交給後面照常聊天）
  assert.equal(meta.setFamily('GS', '我', '葶', NOW), null);
  assert.equal(meta.setFamily('GS', '淇', '路人甲', NOW), null);
  // 退群的不算全員
  db.run('UPDATE cal_members SET gone = 1 WHERE user_id = ?', uid(7));
  assert.equal(who('全員').length, 6);
  assert.equal(meta.resolveWho('GS', ['葶家', '妞家', '亂寫']).length, 1);
});

await test('AI 標短標籤：一個聊天一次呼叫、存起來不重算；行程改了才重標；AI 掛了 10 分鐘內不再試', async () => {
  const db = await memDb();
  cal.initCalendar(db, { dir: PAGE_DIR });
  const e1 = cal.add('GL', { day: '2026-12-20', title: '機票確認' }, NOW).event;
  const e2 = cal.add('GL', { day: '2026-11-08', title: '妞家來吃飯' }, NOW).event;
  const trips = [{ name: 'ski', title: '2026 聖誕滑雪', sig: 'aaa', days: [{ day: '2026-12-24', text: '飛東京' }, { day: '2026-12-25', text: '只有妞家留下' }] }];
  let calls = 0; let prompt = '';
  const llm = { generate: async ({ messages }) => { calls++; prompt = messages[0].content; return JSON.stringify({
    [`e${e1.id}`]: { short: '🎿東京滑雪', who: ['全員'] }, [`e${e2.id}`]: { short: '妞家來吃飯的超長名稱', who: ['妞家'] },
    't:ski': { short: '東京滑雪', who: ['妞家', '葶家'], days: { '2026-12-25': ['妞家'], '2030-01-01': ['亂'] } } }); } };
  assert.equal(await meta.runLabels(llm, 'GL', { trips, now: NOW }), 3);
  assert.match(prompt, /2026-12-25 只有妞家留下/);
  assert.match(prompt, /不照做/);
  assert.deepEqual([cal.getEvent(e1.id).short, JSON.parse(cal.getEvent(e1.id).who)], ['東京滑雪', ['全員']]);
  assert.equal(cal.getEvent(e2.id).short, '妞家來吃飯的');
  assert.deepEqual(meta.tripMeta('GL', 'ski').days, { '2026-12-25': ['妞家'] });
  assert.deepEqual(meta.tripWho(meta.tripMeta('GL', 'ski'), '2026-12-24'), ['妞家', '葶家']);
  // 沒有要標的：不打 AI
  assert.equal(await meta.runLabels(llm, 'GL', { trips, now: NOW }), 0);
  assert.equal(calls, 1);
  // 改名的事、行程改了（雜湊不同）才重標
  cal.edit('GL', e2.id, 'UADMIN', true, { title: '妞家烤肉' }, NOW);
  assert.equal(cal.getEvent(e2.id).short, null);
  const p = meta.pending('GL', [{ ...trips[0], sig: 'bbb' }]);
  assert.deepEqual([p.events.map(e => e.id), p.trips.length], [[e2.id], 1]);
  // AI 掛了：記失敗，10 分鐘內不再打
  const bad = { generate: async () => { calls++; throw new Error('timeout'); } };
  assert.equal(await meta.runLabels(bad, 'GL', { trips, now: NOW }), 0);
  assert.equal(await meta.runLabels(bad, 'GL', { trips, now: NOW + 60_000 }), 0);
  assert.equal(calls, 2);
});

await test('頭像：存成自己網域的小圖、一週查一次、只收 LINE 的網址、查不到算退群、全部查不到不當真', async () => {
  const db = await memDb();
  cal.initCalendar(db, { dir: PAGE_DIR });
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]);
  const fetched = [];
  const fetchImg = async (u) => { fetched.push(u); return { status: 200, buffer: JPG }; };
  const profiles = { [uid(1)]: { displayName: '葶', pictureUrl: 'https://profile.line-scdn.net/abc' }, [uid(2)]: { displayName: '壞人', pictureUrl: 'http://192.168.0.1/x' }, [uid(3)]: null };
  const profile = async (u) => profiles[u];
  const sp = [{ user_id: uid(1), name: '葶' }, { user_id: uid(2), name: '壞人' }, { user_id: uid(3), name: '退了' }, { user_id: 'Ubad', name: '格式不對' }];
  assert.equal(await meta.syncMembers('GA', sp, { profile, fetchImg, now: NOW }), true);
  assert.deepEqual(fetched, ['https://profile.line-scdn.net/abc/small']);
  const m1 = meta.personOf('GA', uid(1));
  assert.match(m1.a, /^av\/[0-9a-f]{24}\.jpg\?v=[0-9a-z]+$/);
  assert.ok(readFileSync(join(PAGE_DIR, m1.a.split('?')[0])).equals(JPG));
  assert.equal(meta.personOf('GA', uid(2)).a, '');                 // 不是 LINE 的網址不下載
  assert.deepEqual(meta.members('GA').map(m => m.name), ['葶', '壞人']); // 查不到的算退群
  // 一週內不再查
  assert.equal(await meta.syncMembers('GA', sp, { profile, fetchImg, now: NOW + 86400_000 }), false);
  assert.equal(fetched.length, 1);
  // 一週後 LINE 全部查不到：比較像 LINE 出問題，不把大家當退群
  assert.equal(await meta.syncMembers('GA', sp, { profile: async () => null, fetchImg, now: NOW + 8 * 86400_000 }), false);
  assert.equal(meta.members('GA').length, 2);
});

await test('月曆網頁（格子放大版）：短標籤、參加的人只放名字和自己網域的頭像、連續幾天畫成長條', async () => {
  const db = await memDb();
  cal.initCalendar(db, { dir: PAGE_DIR, trips: () => [{ day: '2026-12-24', n: 1, title: '✈️ 飛東京', url: 'https://badbadted.github.io/temp-reports/ski.html#d1', name: 'ski' }, { day: '2026-12-25', n: 2, title: '👘 淺草', url: 'https://badbadted.github.io/temp-reports/ski.html#d2', name: 'ski' }] });
  seedMembers(db, 'GP', SKI.slice(0, 2).map(([n, name]) => [n, name, `${'a'.repeat(23)}${n}.jpg`]));
  db.run("INSERT INTO cal_trip_meta (chat_id, name, sig, short, who, days) VALUES ('GP', 'ski', 'x', '東京滑雪', ?, ?)", JSON.stringify(['葶家', '陳二銘家', '不認識家']), JSON.stringify({ '2026-12-25': ['葶家'] }));
  const ev = cal.add('GP', { day: '2026-12-24', time: '20:00', title: '機票確認' }, NOW).event;
  db.run('UPDATE cal_events SET short = ?, who = ?, title = ? WHERE id = ?', '東京滑雪', '["葶"]', '機票確認 a</script> b', ev.id); // 繞過 clean，測網頁跳脫
  cal.add('GP', { day: '2026-12-26', title: '⛷️ 還沒標的事' }, NOW);
  cal.writePage('GP', [{ chatId: 'GP', label: '' }], { title: '滑雪群', now: NOW });
  const html = readdirSync(PAGE_DIR).filter(f => f.endsWith('.html')).map(f => readFileSync(join(PAGE_DIR, f), 'utf8')).find(h => h.includes('還沒標的事'));
  const D = JSON.parse(/const D = (.*);\n/.exec(html.replace(/\r/g, ''))[1]);
  assert.deepEqual(D.people.map(p => p.n), ['葶', '陳二銘（綸/鈞)']);
  assert.ok(D.people.every(p => /^av\/[0-9a-f]{24}\.jpg\?v=/.test(p.a)));
  const of = (d, n) => D.items.find(i => i.d === d && i.n.includes(n));
  assert.deepEqual([of('2026-12-24', '飛東京').l, of('2026-12-24', '飛東京').w], ['東京滑雪', [0, 1]]);
  assert.deepEqual(of('2026-12-25', '淺草').w, [0]);                  // 當天有寫就照當天
  assert.deepEqual([of('2026-12-24', '機票').l, of('2026-12-24', '機票').w], ['東京滑雪', [0]]);
  assert.equal(of('2026-12-26', '還沒標').l, '還沒標的事');            // AI 還沒標：用標題
  assert.ok(!JSON.stringify(D).includes('line-scdn'));                // 不連 LINE 的網址
  assert.ok(!/(src|href)=["']https?:/.test(html) && !/url\(\s*['"]?https?:/.test(html));
  assert.ok(html.includes('AV_RE.test(p.a ||'));                      // 頭像路徑前端再驗一次
  assert.ok(html.includes("el('div', 'span'") && html.includes("'cnt'"));  // 長條＋「+N」
  assert.ok(!html.includes('innerHTML') && html.includes('a\\u003c/script\\u003e b'));
});

await test('給 AI 的行程內容：標題帶頁首日期說明、每天的項目、內容雜湊（改了才重標）', () => {
  writeFileSync(join(TRIP_DIR, 'trips', 'snow.json'), JSON.stringify({ meta: { title: '❄️ 2027 雪國之旅', dates: '大部分 2/6 回，妞家留到 2/9' }, days: [
    { date: '2/6（六）回程', place: '回高雄', items: [{ when: '8:45', title: '其他人回程', sub: '<b>12 位</b>' }] }, { date: '2/7（日）', items: [] }] }));
  const d = trip.detailOf('snow', 2026, TRIP_DIR);
  assert.equal(d.title, '❄️ 2027 雪國之旅（大部分 2/6 回，妞家留到 2/9）');
  assert.deepEqual(d.days, [{ day: '2027-02-06', text: '2/6（六）回程；回高雄；8:45 其他人回程 12 位' }, { day: '2027-02-07', text: '2/7（日）' }]);
  assert.match(d.sig, /^[0-9a-f]{16}$/);
  writeFileSync(join(TRIP_DIR, 'trips', 'snow.json'), JSON.stringify({ meta: { title: '❄️ 2027 雪國之旅' }, days: [{ date: '2/6' }] }));
  assert.notEqual(trip.detailOf('snow', 2026, TRIP_DIR).sig, d.sig);
  assert.equal(trip.detailOf('../x', 2026, TRIP_DIR), null);
});

await test('「小帥 妞家是 葶」：群裡記家庭對應；對不到任何成員就照常聊天', async () => {
  const { db, say } = await calBot();
  seedMembers(db, 'GC', SKI);
  const r = await say('U1', '小帥 妞家是 葶');
  assert.equal(r[0].text, '記好了：妞家＝葶，月曆上會顯示他們的頭像');
  assert.deepEqual(meta.families('GC'), [{ family: '妞', ids: [uid(1)] }]);
  // 綁了行程的群也能設
  seedMembers(db, 'GTRIP', SKI);
  assert.match((await say('U1', '小帥 品岑家是 翁小娟', 'GTRIP'))[0].text, /品岑家＝翁小娟💎/);
  // 對不到：不攔
  await say('U1', '小帥 我家是住高雄');
  assert.equal(meta.families('GC').length, 1);
});

// ── 網頁上直接改（2026-11-01）：LIFF 驗身分、修改紀錄、軟刪除、同時改、手動欄位不給 AI 蓋 ──
const caledit = await import('../plugins/xiaoshuai/caledit.js');
const GE = 'C' + 'e'.repeat(32);
const UA = uid(1), UB = uid(4), UOUT = uid(9);
async function editBot() {
  const db = await memDb();
  const pushed = [];
  const replies = [];
  const member = { [UA]: '葶', [UB]: 'Jasmine' };
  const lineApi = { reply: async (_t, m) => { replies.push(m); return {}; }, push: async (to, m) => { pushed.push([to, m]); },
    getGroupMemberProfile: async (_g, u) => (member[u] ? { displayName: member[u] } : null), getProfile: async () => null };
  const ctx = { db, lineApi, isAdmin: (u) => u === 'UADMIN', providers: { llm: { generate: async () => '{}' } } };
  await xiaoshuai.init(ctx);
  db.run('INSERT INTO groups (chat_id, enabled) VALUES (?, 1)', GE);
  await xiaoshuai.init(ctx);
  seedMembers(db, GE, SKI);
  db.run("INSERT INTO trip_binds (chat_id, name) VALUES (?, 'ski-2026')", GE);
  xiaoshuai._calResetRate();
  // 路由：照框架的 http hook 收起來
  const routes = {};
  xiaoshuai.http({ get: (p, fn) => { routes[`GET ${p}`] = fn; }, post: (p, fn) => { routes[`POST ${p}`] = fn; } });
  caledit.setVerifier(async (tok) => ({ 'tok-a': { userId: UA, name: 'A（LINE 名）' }, 'tok-b': { userId: UB, name: 'B' }, 'tok-out': { userId: UOUT, name: '路人' } })[tok] || null);
  const token = cal.tokenOf(GE);
  const key = caledit.editKey(GE);
  const kOf = (n) => db.get('SELECT rowid AS k FROM cal_members WHERE chat_id = ? AND name = ?', GE, n).k;
  const meK = kOf('葶');
  // 預設：編輯連結＋自報「葶」；idt 給了就走 LINE 登入
  const api = async (action, body, { idt = null, k = key, who = meK, origin = 'https://bot.example.test', json = true, client = '1', ip = '203.0.113.9', dev = 'dev-1', big = 0 } = {}) => {
    let status = 200; let out = null;
    const headers = { origin, 'x-cal-client': client, 'cf-connecting-ip': ip, 'user-agent': 'test-agent', 'content-length': String(big) };
    const req = { body: { t: token, ...(idt ? { id: idt } : { k }), who, dev, ...body }, is: (t) => json && t === 'application/json', get: (h) => headers[h.toLowerCase()], ip: '127.0.0.1' };
    const res = { status(s) { status = s; return this; }, set() { return this; }, json(j) { out = j; return this; } };
    await routes[`POST /cal/${action}`](req, res);
    return { status, ...out };
  };
  let seq = 7000;
  const say = async (userId, text, chatId = GE) => {
    const id = String(++seq); const event = { message: { type: 'text', id, text } };
    xiaoshuai.onGroupText({ chatId, userId, text, event });
    const n = replies.length;
    await xiaoshuai.onUnmatched({ chatId, userId, text, replyToken: `rt${id}`, event });
    return replies.length > n ? replies.at(-1) : null;
  };
  return { db, routes, api, token, key, kOf, meK, pushed, say };
}
const pageData = (token) => JSON.parse(/const D = (.*);\n/.exec(readFileSync(join(PAGE_DIR, `${token}.html`), 'utf8').replace(/\r/g, ''))[1]);

await test('編輯連結：卡片網址帶 #k=；沒帶碼、碼錯、別的群的碼都不能改；同源＋自訂標頭＋JSON＋16KB', async () => {
  delete process.env.XIAOSHUAI_LIFF_ID; delete process.env.XIAOSHUAI_LIFF_CHANNEL_ID;
  process.env.XIAOSHUAI_LIFF_FILE = join(PAGE_DIR, 'no-such-liff.json');
  const { db, api, token, key, routes } = await editBot();
  assert.match(key, /^[A-Za-z0-9_-]{32}$/);                                   // 24 bytes＝192 bit
  assert.equal(cal.pageUrl(GE).split('#k=')[1], key);
  assert.ok(!cal.pageUrl(GE, Date.now(), { readOnly: true }).includes('#k='));
  let code = 0; routes['GET /cal/config']({}, { status(s) { code = s; return this; }, set() { return this; }, json() { return this; } });
  assert.equal(code, 404);                                                    // LIFF 還沒設定
  assert.equal((await api('me', {}, { k: null })).status, 403);         // 沒帶碼
  assert.equal((await api('me', {}, { k: key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A') })).status, 403);   // 碼錯
  assert.equal((await api('me', {}, { origin: null })).status, 403);    // 沒有 Origin
  assert.equal((await api('me', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('me', {}, { client: null })).status, 400);    // 沒有自訂標頭（跨站表單送不出）
  assert.equal((await api('me', {}, { json: false })).status, 400);
  assert.equal((await api('me', {}, { big: 20000 })).status, 413);
  assert.equal((await api('me', { pad: 'x'.repeat(17000) })).status, 413);
  assert.equal((await api('me', { t: 'f'.repeat(32) })).status, 404);
  // 別的群的碼不能改這個群；這個群的碼也改不到別的群的事
  cal.tokenOf('C' + 'f'.repeat(32));
  const otherKey = caledit.editKey('C' + 'f'.repeat(32));
  assert.equal((await api('me', {}, { k: otherKey })).status, 403);
  const other = cal.add('C' + 'f'.repeat(32), { day: D3, title: '別群的事' }, Date.now()).event;
  assert.match((await api('edit', { ref: `e${other.id}`, ver: 0, changes: { l: '偷改' } })).error, /不在/);
  assert.equal(cal.getEvent(other.id).short, null);
  // 錯的都記異常，訊息不帶內部細節
  assert.ok(db.get("SELECT COUNT(*) n FROM cal_anomaly WHERE kind = 'key'").n >= 3);
  assert.ok(db.get("SELECT COUNT(*) n FROM cal_anomaly WHERE kind = 'origin'").n >= 2);
  const me = await api('me', {});
  assert.equal(me.ok, true);
  assert.equal(me.via, 'key');
  assert.equal(me.members.length, 7);
  assert.ok(me.members.every(m => Number.isInteger(m.k) && !('user_id' in m)));  // 不給 LINE userId
  // 沒選「我是誰」不能改
  const ev = cal.add(GE, { day: D3, title: '家長會' }, Date.now()).event;
  assert.match((await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { l: '親師' } }, { who: null })).error, /我是誰/);
  assert.match((await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { l: '親師' } }, { who: 99999 })).error, /我是誰/);
  cal.writePage(GE, [{ chatId: GE, label: '' }], { now: NOW });
  assert.equal(pageData(token).edit, false);
  assert.ok(readFileSync(join(PAGE_DIR, `${token}.html`), 'utf8').includes("'X-Cal-Client': '1'"));
});

await test('自報身分：紀錄寫名字＋「自報」、只存裝置指紋與 IP 的雜湊', async () => {
  const { db, api } = await editBot();
  const ev = cal.add(GE, { day: D3, title: '烤肉' }, Date.now()).event;
  assert.equal((await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { l: '烤肉趴' } }, { dev: 'device-xyz', ip: '198.51.100.7' })).ok, true);
  const h = db.get("SELECT * FROM cal_history WHERE ref = ? AND what LIKE '短名稱%'", `e${ev.id}`);
  assert.deepEqual([h.user_name, h.via], ['葶（自報）', 'key']);
  assert.match(h.fp, /^[0-9a-f]{16}$/);
  assert.match(h.iph, /^[0-9a-f]{16}$/);
  const all = JSON.stringify(db.all('SELECT * FROM cal_history')) + JSON.stringify(db.all('SELECT * FROM cal_anomaly'));
  assert.ok(!all.includes('198.51.100.7') && !all.includes('device-xyz'));   // 不存明文
  assert.equal((await api('history', { ref: `e${ev.id}` })).list[0].self, true);
});

await test('輸入驗證：長度上限、日期前後 2 年、不收 HTML、參加的人只能是這群的成員；網頁輸出一律跳脫', async () => {
  const { api, token, kOf } = await editBot();
  const ev = cal.add(GE, { day: D3, title: '聚會' }, Date.now()).event;
  const e = (changes) => { xiaoshuai._calResetRate(); return api('edit', { ref: `e${ev.id}`, ver: 0, changes }); };
  assert.match((await e({ n: '<script>alert(1)</script>' })).error, /< >/);
  assert.match((await e({ n: '<img src=x onerror=alert(1)>' })).error, /< >/);
  assert.match((await e({ p: 'a>b' })).error, /< >/);
  assert.match((await e({ l: '<b>' })).error, /< >/);
  assert.match((await e({ n: '字'.repeat(61) })).error, /60/);
  assert.match((await e({ l: '字'.repeat(9) })).error, /8/);
  assert.match((await e({ p: '字'.repeat(61) })).error, /60/);
  assert.match((await e({ d: cal.addDays(cal.todayKey(), 800) })).error, /2 年/);
  assert.match((await e({ d: cal.addDays(cal.todayKey(), -800) })).error, /2 年/);
  assert.match((await e({ who: [kOf('葶'), 424242] })).error, /成員/);
  assert.match((await e({ who: 'all' })).error, /格式/);
  assert.match((await e({ t: { x: 1 } })).error, /時間/);
  assert.match((await api('families', { families: [{ name: '<b>壞家', keys: [] }] })).error, /< >/);
  assert.equal(cal.getEvent(ev.id).version, 0);                              // 都沒寫進去
  // 剛好在上限：可以
  assert.equal((await e({ n: '字'.repeat(60), l: '字'.repeat(8), p: '字'.repeat(60) })).ok, true);
  // 聊天記進來的標題就算帶 HTML 字元，網頁也只當文字：JSON 跳脫、用 textContent 畫
  const bad = cal.add(GE, { day: D4, title: 'x' }, Date.now()).event;
  caledit.log; // 確保模組載入
  const html = readFileSync(join(PAGE_DIR, `${token}.html`), 'utf8');
  assert.ok(!html.includes('innerHTML') && !/(src|href)=["']https?:/.test(html));
  void bad;
});

await test('頻率限制：同一個編輯碼、同一個 IP 每分鐘 10 次修改，超過回 429 並記異常', async () => {
  const { db, api } = await editBot();
  const ev = cal.add(GE, { day: D3, title: '練習' }, Date.now()).event;
  let ok = 0; let last = null;
  for (let i = 0; i < 12; i++) { last = await api('edit', { ref: `e${ev.id}`, ver: i, changes: { l: `練${i}` } }, { ip: `192.0.2.${i}` }); if (last.ok) ok++; }
  assert.equal(ok, 10);                                // 換 IP 也一樣：編輯碼自己有上限
  assert.equal(last.status, 429);
  xiaoshuai._calResetRate();
  for (let i = 0; i < 10; i++) await api('me', {}, { ip: '192.0.2.200' });
  assert.equal((await api('edit', { ref: `e${ev.id}`, ver: 10, changes: { l: '練習' } }, { ip: '192.0.2.200' })).ok, true); // 讀跟寫分開算
  xiaoshuai._calResetRate();
  for (let i = 0; i < 10; i++) await api('edit', { ref: 'e0', ver: 0, changes: { l: 'x' } }, { ip: '192.0.2.99' });
  assert.equal((await api('me', {}, { ip: '192.0.2.99' })).ok, true);
  assert.equal((await api('edit', { ref: `e${ev.id}`, ver: 11, changes: { l: 'y' } }, { ip: '192.0.2.99' })).status, 429);  // 同一個 IP
  assert.ok(db.get("SELECT COUNT(*) n FROM cal_anomaly WHERE kind = 'rate'").n >= 2);
});

await test('大量刪除：10 分鐘內用編輯連結刪 5 筆 → 暫停網頁編輯 1 小時、推播通知 TED；可以一鍵還原', async () => {
  process.env.XIAOSHUAI_CAL_ALERT_TO = 'UADMIN';
  const { db, api, pushed, say, token } = await editBot();
  const t0 = Date.now() - 180_000;
  const evs = Array.from({ length: 6 }, (_, i) => cal.add(GE, { day: D3, title: `事${i}` }, t0).event);
  for (let i = 0; i < 4; i++) assert.equal((await api('delete', { ref: `e${evs[i].id}`, ver: 0 })).ok, true);
  assert.equal(pushed.length, 0);
  assert.equal((await api('delete', { ref: `e${evs[4].id}`, ver: 0 })).ok, true);   // 第 5 筆 → 觸發
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0][0], 'UADMIN');
  assert.match(pushed[0][1][0].text, /刪了 5 筆.*暫停 1 小時/s);
  assert.ok(caledit.suspendedUntil(GE) > Date.now() + 50 * 60_000);
  assert.equal((await api('delete', { ref: `e${evs[5].id}`, ver: 0 })).status, 423);
  assert.equal((await api('edit', { ref: `e${evs[5].id}`, ver: 0, changes: { l: 'x' } })).status, 423);
  assert.ok(db.get("SELECT COUNT(*) n FROM cal_anomaly WHERE kind = 'burst'").n === 1);
  // 不是 TED 不能整個還原
  assert.match((await say(UA, '小帥 行事曆 還原到 00:00'))[0].text, /只有 TED/);
  // TED 一鍵還原到刪之前
  const hm = new Date(Date.now() - 90_000 + 8 * 3600_000).toISOString().slice(11, 16); // 整分鐘：介於新增之後、刪除之前
  const r = await say('UADMIN', `小帥 行事曆 還原到 ${hm}`);
  assert.match(r[0].text, /還原好了.*5 筆/);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events WHERE chat_id = ? AND deleted_at IS NULL', GE).n, 6);
  assert.ok(pageData(token).items.filter(i => /^事\d$/.test(i.n)).length === 6);
  delete process.env.XIAOSHUAI_CAL_ALERT_TO;
});

await test('還原到某個時間點：改過的改回去、之後才新增的移掉、家庭對應也回去；還原本身也能再還原', async () => {
  const { db, api, kOf } = await editBot();
  const t0 = Date.now() - 120_000;
  const ev = cal.add(GE, { day: D3, title: '原本的標題' }, t0).event;
  meta.setFamily(GE, '妞', '葶', t0);
  const tMid = Date.now() - 60_000;
  await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { n: '被亂改', l: '亂改', who: [kOf('Jasmine')] } });
  const late = cal.add(GE, { day: D4, title: '後來加的' }, Date.now()).event;
  await api('families', { families: [{ name: '亂家', keys: [kOf('葶')] }] });
  await new Promise(res => setTimeout(res, 5));
  const tBefore = Date.now();                            // 還原之前
  await new Promise(res => setTimeout(res, 5));
  const r = caledit.restoreTo(GE, tMid, { id: 'UADMIN', name: 'TED', via: 'chat' });
  assert.equal(r.n, 3);
  const e2 = cal.getEvent(ev.id);
  assert.deepEqual([e2.title, e2.short, e2.who, e2.deleted_at], ['原本的標題', null, null, null]);
  assert.ok(cal.getEvent(late.id).deleted_at);
  assert.deepEqual(meta.families(GE).map(f => f.family), ['妞']);
  // 還原錯了：還原到「還原之前」就回到被改過的樣子
  await new Promise(res => setTimeout(res, 5));
  const r2 = caledit.restoreTo(GE, tBefore, { id: 'UADMIN', name: 'TED', via: 'chat' });
  assert.equal(r2.n, 3);
  assert.deepEqual([cal.getEvent(ev.id).title, cal.getEvent(ev.id).short], ['被亂改', '亂改']);
  assert.equal(cal.getEvent(late.id).deleted_at, null);
  assert.deepEqual(meta.families(GE).map(f => f.family), ['亂']);
});

await test('換網址：群組成員可以換、舊碼立刻失效、5 分鐘內不能連換；私訊只有 TED、可以指定群', async () => {
  const { api, say, key } = await editBot();
  const r = await say(UA, '小帥 行事曆 換網址');
  assert.match(r[0].text, /換好了/);
  const newKey = /#k=([A-Za-z0-9_-]+)/.exec(r[0].text)[1];
  assert.notEqual(newKey, key);
  assert.equal((await api('me', {}, { k: key })).status, 403);              // 舊的立刻不能用
  assert.equal((await api('me', {}, { k: newKey })).ok, true);
  assert.match((await say(UB, '小帥 行事曆換網址'))[0].text, /5 分鐘/);
  assert.equal(caledit.history(GE, 'sys')[0].what, '換了編輯連結（舊的失效）');
});

await test('LIFF 設定後：卡片連 LIFF；要 JSON、自己的網域、LINE 驗過的身分、群組成員才能改', async () => {
  process.env.XIAOSHUAI_LIFF_ID = '1234567890-AbCdEfGh'; process.env.XIAOSHUAI_LIFF_CHANNEL_ID = '2000000000';
  const { api, token, routes } = await editBot();
  assert.equal(cal.pageUrl(GE), `https://liff.line.me/1234567890-AbCdEfGh?t=${token}`);
  let cfg = null; routes['GET /cal/config']({}, { status() { return this; }, set() { return this; }, json(j) { cfg = j; return this; } });
  assert.deepEqual(cfg, { ok: true, liffId: '1234567890-AbCdEfGh' });
  assert.equal((await api('me', {}, { idt: 'tok-a', json: false })).status, 400);
  assert.equal((await api('me', {}, { idt: 'tok-a', origin: 'https://evil.example' })).status, 403);   // 擋 CSRF
  assert.equal((await api('me', {}, { idt: 'fake' })).status, 401);                       // LINE 沒驗過
  assert.equal((await api('me', {}, { idt: 'tok-out' })).status, 403);                    // 不是群組成員
  assert.equal((await api('me', { t: 'f'.repeat(32) })).status, 404);
  const me = await api('me', {}, { idt: 'tok-a' });
  assert.equal(me.ok, true);
  assert.equal(me.me.name, '葶');                    // 用群組裡的名字
  assert.equal(me.members.length, 7);
  assert.ok(me.members.every(m => Number.isInteger(m.k) && !('user_id' in m)));  // 不給 LINE userId
  cal.writePage(GE, [{ chatId: GE, label: '' }], { now: NOW });
  assert.equal(pageData(token).edit, true);
});

await test('改自己記的事：每個欄位都能改、記紀錄、手動標記；同時改要先看到「剛被誰改過」', async () => {
  const { db, api, token, kOf } = await editBot();
  const ev = cal.add(GE, { day: D3, time: '19:00', title: '家長會', by: UA, byName: '葶' }, Date.now()).event;
  const keys = (names) => names.map(n => db.get('SELECT rowid AS k FROM cal_members WHERE chat_id = ? AND name = ?', GE, n).k);
  const r = await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { n: '期末家長會', l: '親師會', d: D4, t: '', p: '禮堂', who: keys(['葶', 'Jasmine']) } });
  assert.equal(r.ok, true, r.error);
  const e2 = cal.getEvent(ev.id);
  assert.deepEqual([e2.title, e2.short, e2.day, e2.time, e2.place, e2.version], ['期末家長會', '親師會', D4, null, '禮堂', 1]);
  assert.deepEqual(JSON.parse(e2.who), [`@${UA}`, `@${UB}`]);
  assert.deepEqual(Object.keys(JSON.parse(e2.manual)).sort(), ['d', 'l', 'n', 'p', 't', 'who']);
  const h = (await api('history', { ref: `e${ev.id}` })).list;
  assert.equal(h.length, 7);                        // 6 欄＋新增
  assert.ok(h.every(x => x.by === '葶（自報）' || x.what.startsWith('新增')));
  assert.ok(h.some(x => x.what === '時間：19:00 → 全天'));
  assert.ok(h.some(x => x.what === '參加的人：沒有 → 葶、Jasmine'));
  // 網頁跟著重寫：短名稱、參加的人、版本
  const it = pageData(token).items.find(i => i.r === `e${ev.id}`);
  assert.deepEqual([it.l, it.ver, it.x, it.w.length], ['親師會', 1, 1, 2]);
  // B 拿舊版本（0）來改 → 409，看得到 A 剛改了什麼；選蓋掉才存
  const c = await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { l: '開會' } }, { who: kOf('Jasmine') });
  assert.equal(c.status, 409);
  assert.equal(c.by, '葶（自報）');
  assert.match(c.what, /新增|：/);
  assert.equal((await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { l: '開會' }, force: true }, { who: kOf('Jasmine') })).ok, true);
  assert.equal(cal.getEvent(ev.id).short, '開會');
  // 欄位不對
  assert.match((await api('edit', { ref: `e${ev.id}`, ver: 2, changes: { d: '2026-02-30' } })).error, /日期/);
  assert.match((await api('edit', { ref: `e${ev.id}`, ver: 2, changes: { t: '25:00' } })).error, /時間/);
  assert.match((await api('edit', { ref: `e${ev.id}`, ver: 2, changes: { n: '   ' } })).error, /標題/);
  // 別的聊天的事改不到
  const other = cal.add('GOTHER', { day: D3, title: '別群的事' }, Date.now()).event;
  assert.match((await api('edit', { ref: `e${other.id}`, ver: 0, changes: { l: '偷改' } })).error, /不在/);
  assert.equal(cal.getEvent(other.id).short, null);
});

await test('刪除是軟刪除：先記紀錄、列在最近刪除、可以還原；聊天裡刪也記是誰', async () => {
  const { api, token } = await editBot();
  const ev = cal.add(GE, { day: D3, title: '換日幣', by: UA, byName: '葶' }, Date.now()).event;
  assert.equal((await api('delete', { ref: `e${ev.id}`, ver: 0 })).ok, true);
  assert.ok(cal.getEvent(ev.id).deleted_at);
  assert.ok(!pageData(token).items.some(i => i.r === `e${ev.id}`));
  assert.deepEqual((await api('me', {})).deleted.map(d => d.title), ['換日幣']);
  assert.equal((await api('restore', { ref: `e${ev.id}` })).ok, true);
  assert.ok(pageData(token).items.some(i => i.r === `e${ev.id}`));
  assert.deepEqual((await api('history', { ref: `e${ev.id}` })).list.map(x => x.what), ['還原了「換日幣」', '刪除了「換日幣」', `新增了「換日幣」（${cal.dayLabel(D3)}）`]);
  // 旅遊行程不能刪
  assert.match((await api('delete', { ref: `t|ski-2026|${D3}`, ver: 0 })).error, /行程網頁/);
  // 聊天裡的刪除也是軟刪除＋記名字
  const r = cal.remove(GE, ev.id, UA, false, '葶');
  assert.equal(r.ok, true);
  assert.equal(caledit.history(GE, `e${ev.id}`)[0].user_name, '葶');
});

await test('旅遊行程那天：只能改短名稱和參加的人；手動改的 AI 重標不會蓋', async () => {
  const { db, api, token } = await editBot();
  const d1 = cal.addDays(cal.todayKey(), 10); const d2 = cal.addDays(d1, 1);
  writeFileSync(join(TRIP_DIR, 'trips', 'ski-2026.json'), JSON.stringify({ meta: { title: `${d1.slice(0, 4)} 滑雪` }, days: [
    { glance: { d: md(d1), emoji: '⛷️', place: '神樂' } }, { glance: { d: md(d2), emoji: '🏂', place: '苗場' } }] }));
  db.run("INSERT INTO cal_trip_meta (chat_id, name, sig, short, who, days) VALUES (?, 'ski-2026', 'x', '日本滑雪', '[\"全員\"]', '{}')", GE);
  const ref = `t|ski-2026|${d1}`;
  assert.match((await api('edit', { ref, ver: 0, changes: { n: '改標題' } })).error, /行程網頁/);
  const kB = db.get('SELECT rowid AS k FROM cal_members WHERE chat_id = ? AND user_id = ?', GE, UB).k;
  const r = await api('edit', { ref, ver: 0, changes: { l: '東京滑雪', who: [kB] } });
  assert.equal(r.ok, true, r.error);
  const D = pageData(token);
  const a = D.items.find(i => i.r === ref); const b = D.items.find(i => i.r === `t|ski-2026|${d2}`);
  assert.deepEqual([a.l, a.w.map(x => D.people[x].n), a.m], ['東京滑雪', ['Jasmine'], 'lwho']);
  assert.deepEqual([b.l, b.w.length], ['日本滑雪', 7]);       // 另一天沒動
  assert.deepEqual((await api('history', { ref })).list.map(x => x.what), ['參加的人：全員 → Jasmine', '短名稱：日本滑雪 → 東京滑雪']);
  // AI 重標行程：這天手動改的照舊
  db.run("UPDATE cal_trip_meta SET short = '冬季旅行', who = '[\"妞家\"]' WHERE chat_id = ?", GE);
  cal.writePage(GE, [{ chatId: GE, label: '' }], { now: Date.now() });
  const a2 = pageData(token).items.find(i => i.r === ref);
  assert.deepEqual([a2.l, a2.w.length], ['東京滑雪', 1]);
  // 改回自動
  assert.equal((await api('unpin', { ref, field: 'l' })).ok, true);
  assert.equal(pageData(token).items.find(i => i.r === ref).l, '冬季旅行');
  // 沒綁的行程、不存在的那天
  assert.equal((await api('edit', { ref: `t|nope|${d1}`, ver: 0, changes: { l: 'x' } })).status, 404);
  // 自己記的事：手動改的參加的人，AI 重標也不蓋
  const ev = cal.add(GE, { day: D3, title: '聚餐' }, Date.now()).event;
  await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { who: [kB] } });
  const llm = { generate: async () => JSON.stringify({ [`e${ev.id}`]: { short: '聚餐', who: ['全員'] } }) };
  assert.equal(await meta.runLabels(llm, GE, { now: Date.now() + 3600_000 }), 1);
  assert.deepEqual([cal.getEvent(ev.id).short, JSON.parse(cal.getEvent(ev.id).who)], ['聚餐', [`@${UB}`]]);
  cal.edit(GE, ev.id, UA, true, { title: '聚餐改名' }, Date.now());   // 聊天裡改名：只重標沒手動改的欄位
  assert.deepEqual([cal.getEvent(ev.id).short, JSON.parse(cal.getEvent(ev.id).who)], [null, [`@${UB}`]]);
});

await test('家庭對應、群組通知：網頁上改；預設不在群組說，打開才排進免費回覆', async () => {
  const { db, api, token } = await editBot();
  const k = (n) => db.get('SELECT rowid AS k FROM cal_members WHERE chat_id = ? AND name = ?', GE, n).k;
  const r = await api('families', { families: [{ name: '綸鈞家', keys: [k('陳二銘（綸/鈞)'), k('古嘉文（綸&鈞媽）')] }, { name: '多家', keys: [k('🌟Ying.chen💎')] }, { name: '妞家', keys: [k('葶')] }] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(meta.families(GE).map(f => [f.family, f.ids.length]), [['多', 1], ['妞', 1], ['綸鈞', 2]]);
  const D = pageData(token);
  const fam = D.groups[0].fam.find(f => f.n === '綸鈞家');
  assert.deepEqual(fam.m.map(x => D.people[x].n), ['陳二銘（綸/鈞)', '古嘉文（綸&鈞媽）']);  // 第一位是代表
  assert.equal(D.groups[0].all.length, 7);
  assert.match((await api('families', { families: [{ name: '妞家', keys: [] }, { name: '妞', keys: [] }] })).error, /重複/);
  assert.ok(caledit.history(GE, 'fam')[0].what.includes('綸鈞家＝陳二銘'));
  // 通知預設關
  const ev = cal.add(GE, { day: D3, title: '烤肉' }, Date.now()).event;
  await api('edit', { ref: `e${ev.id}`, ver: 0, changes: { l: '烤肉趴' } });
  assert.equal(db.get('SELECT COUNT(*) n FROM held_answers WHERE chat_id = ?', GE).n, 0);
  assert.equal((await api('settings', { notify: true })).ok, true);
  assert.equal((await api('me', {})).notify, true);
  await api('edit', { ref: `e${ev.id}`, ver: 1, changes: { l: '烤肉' } });
  assert.match(db.get('SELECT text FROM held_answers WHERE chat_id = ?', GE).text, /葶（自報） 改了行事曆：「烤肉」/);
  caledit.setVerifier(null);
  delete process.env.XIAOSHUAI_LIFF_ID; delete process.env.XIAOSHUAI_LIFF_CHANNEL_ID;
});

await test('網頁：預設兩週、整月可切；格子頭像規則的資料（全員、家庭代表）都在；只有這個聊天的才給改', async () => {
  const db = await memDb();
  cal.initCalendar(db, { dir: PAGE_DIR });
  seedMembers(db, 'GW', SKI);
  meta.setFamily('GW', '綸鈞', '陳二銘、古嘉文', NOW);
  const ev = cal.add('GW', { day: '2026-11-03', title: '大家聚餐' }, NOW).event;
  db.run("UPDATE cal_events SET who = '[\"全員\"]' WHERE id = ?", ev.id);
  cal.add('GX', { day: '2026-11-04', title: '別群' }, NOW);
  cal.writePage('GW', [{ chatId: 'GW', label: '我的' }, { chatId: 'GX', label: '別群' }], { now: NOW });
  const html = readdirSync(PAGE_DIR).filter(f => f.endsWith('.html')).map(f => readFileSync(join(PAGE_DIR, f), 'utf8')).find(h => h.includes('大家聚餐'));
  const D = JSON.parse(/const D = (.*);\n/.exec(html.replace(/\r/g, ''))[1]);
  assert.ok(html.includes("keep('xs-cal-mode') || 'two'"));            // 預設兩週
  assert.ok(html.includes('data-m="two">兩週') && html.includes('data-m="month">整月'));
  assert.ok(html.includes("el('span', 'all', '全員')"));
  const it = D.items.find(i => i.n === '大家聚餐');
  assert.equal(it.w.length, 7);
  assert.deepEqual(D.groups[0].all.sort(), it.w.slice().sort());
  assert.equal(D.items.find(i => i.n === '別群').x, undefined);         // 別的聊天的只能看
  assert.equal(it.x, 1);
  assert.ok(!/(src|href)=["']https?:/.test(html));
});

await test('向 LINE 驗 ID token：只信 LINE 回的 sub、channel 要對、過期不收、LINE 說不行就不行', async () => {
  const now = Date.now();
  const sent = [];
  const fetchFn = (body) => async (url, opt) => { sent.push([url, opt.body]); return { ok: body !== null, json: async () => body }; };
  const ok = { sub: UA, aud: '2000000000', exp: Math.floor(now / 1000) + 600, name: '葶' };
  assert.deepEqual(await caledit.verifyIdToken('t1', '2000000000', { fetchFn: fetchFn(ok), now }), { userId: UA, name: '葶' });
  assert.equal(sent[0][0], 'https://api.line.me/oauth2/v2.1/verify');
  assert.match(sent[0][1], /id_token=t1&client_id=2000000000/);
  assert.equal(await caledit.verifyIdToken('t2', '2000000000', { fetchFn: fetchFn({ ...ok, aud: '1999999999' }), now }), null);   // 別的 app 的 token
  assert.equal(await caledit.verifyIdToken('t3', '2000000000', { fetchFn: fetchFn({ ...ok, exp: Math.floor(now / 1000) - 1 }), now }), null);
  assert.equal(await caledit.verifyIdToken('t4', '2000000000', { fetchFn: fetchFn({ ...ok, sub: 'Uhacker' }), now }), null);
  assert.equal(await caledit.verifyIdToken('t5', '2000000000', { fetchFn: fetchFn(null), now }), null);
  assert.equal(await caledit.verifyIdToken('', '2000000000', { fetchFn: fetchFn(ok), now }), null);
  // LIFF 設定檔：格式不對當沒設定
  const f = join(PAGE_DIR, 'liff.json');
  writeFileSync(f, JSON.stringify({ liffId: '1234567890-AbCdEfGh', channelId: '2000000000' }));
  assert.deepEqual(caledit.liffConfig(f), { liffId: '1234567890-AbCdEfGh', channelId: '2000000000' });
  writeFileSync(f, JSON.stringify({ liffId: 'javascript:alert(1)', channelId: '2000000000' }));
  assert.equal(caledit.liffConfig(f), null);
});

console.log(`\n${pass} 項全部通過`);
