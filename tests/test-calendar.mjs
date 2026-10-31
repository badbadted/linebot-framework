/**
 * 小帥行事曆測試（不打 AI、不連 LINE；月曆網頁寫到暫存目錄）
 * 執行：node tests/test-calendar.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_DIR = mkdtempSync(join(tmpdir(), 'xs-cal-'));
process.env.XIAOSHUAI_CAL_DIR = PAGE_DIR;

const cal = await import('../plugins/xiaoshuai/calendar.js');
const polls = await import('../plugins/xiaoshuai/polls.js');
const claims = await import('../plugins/xiaoshuai/claims.js');
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
  assert.equal(cal.getEvent(r.event.id), null);
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
  assert.match(url, /^https:\/\/bot\.example\.test\/public\/cal\/[0-9a-f]{32}\.html\?v=\d+$/);
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
    assert.ok(html.includes(`'../xiaoshuai/${f}'`), f);
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
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events').n, 0);
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
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events').n, 1);
  const before = asked.length;
  await say('U1', '小帥 東京明天會下雪嗎');
  assert.equal(asked.length, before);               // 問句不問 AI
  // 沒叫小帥不處理
  assert.equal(await say('U1', `記一下 ${md(D4)} 烤肉`), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events').n, 1);
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

await test('綁了旅遊行程的群：「明天行程」交給行程，要講「行事曆」才算', async () => {
  const { db, say } = await calBot();
  const r = await say('U1', '小帥 明天行程', 'GTRIP');
  assert.ok(!r || !/沒有排事情|有 \d+ 件事/.test(r[0]?.text || ''));
  await say('U1', `小帥 行事曆加 ${md(D3)} 滑雪課`, 'GTRIP');
  assert.equal(db.get("SELECT title FROM cal_events WHERE chat_id = 'GTRIP'").title, '滑雪課');
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
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events').n, 1);
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
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events').n, 3);
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
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events').n, 2);
});

await test('多筆：AI 沒回應 → 照規則拆著記（問句跳過）；一筆的就不硬記', async () => {
  const { db, say } = await calBot({ intent: () => { throw new Error('timeout'); } });
  const r = await say('U1', `小帥 ${md(D3)} 晚上七點 家長會\n${md(D4)} 校外教學 在動物園\n明天會下雨嗎？`);
  assert.match(r[0].text, /記好了 2 筆/);
  assert.deepEqual(db.all('SELECT title, place FROM cal_events ORDER BY day').map(e => [e.title, e.place]), [['家長會', ''], ['校外教學', '動物園']]);
  await say('U1', `小帥 ${md(D5)} 牙醫`);
  assert.equal(db.get('SELECT COUNT(*) n FROM cal_events').n, 2);
});

await test('單筆沒明講「記」：AI 判斷是記事就直接記，不問使用者', async () => {
  const { db, say } = await calBot({ intent: multiAi([{ title: '看牙醫', when: `${md(D3)} 下午三點` }]) });
  const r = await say('U1', `小帥 ${md(D3)} 下午三點 看牙醫`);
  assert.equal(r[0].text, '記好了 📅');
  assert.equal(r[1].contents.type, 'bubble');
  assert.equal(db.get('SELECT time FROM cal_events').time, '15:00');
});

console.log(`\n${pass} 項全部通過`);
