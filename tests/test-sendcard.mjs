/**
 * 用 TED 自己的 LINE 帳號發卡片（2026-11-02）測試：轉發前清理、私訊入口、/x/xiaoshuai/share/*、妞揪分享改用自己的帳號發
 * 不打 AI、不連 LINE（ID token 驗證換成假的）
 * 執行：node tests/test-sendcard.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_DIR = mkdtempSync(join(tmpdir(), 'xs-send-'));
process.env.XIAOSHUAI_CAL_DIR = PAGE_DIR;
const TRIP_DIR = mkdtempSync(join(tmpdir(), 'xs-send-trip-'));
mkdirSync(join(TRIP_DIR, 'trips'));
process.env.TRIP_REPO_DIR = TRIP_DIR;
process.env.XIAOSHUAI_CAL_NO_ENRICH = '1';
process.env.BOT_PUBLIC_URL = 'https://bot.example.test';
process.env.XIAOSHUAI_LIFF_FILE = join(PAGE_DIR, 'no-such-liff.json');
delete process.env.XIAOSHUAI_LIFF_ID; delete process.env.XIAOSHUAI_LIFF_CHANNEL_ID;

const sc = await import('../plugins/xiaoshuai/sendcard.js');
const cal = await import('../plugins/xiaoshuai/calendar.js');
const share = await import('../plugins/xiaoshuai/share.js');
const kb = await import('../plugins/xiaoshuai/kb.js');
const caledit = await import('../plugins/xiaoshuai/caledit.js');
const { default: xiaoshuai } = await import('../plugins/xiaoshuai/index.js');

let pass = 0;
async function test(name, fn) {
  await fn();
  pass++;
  console.log(`✓ ${name}`);
}

const LIFF = '1234567890-AbCdEfGh';
const liffOn = () => { process.env.XIAOSHUAI_LIFF_ID = LIFF; process.env.XIAOSHUAI_LIFF_CHANNEL_ID = '2000000000'; };
const liffOff = () => { delete process.env.XIAOSHUAI_LIFF_ID; delete process.env.XIAOSHUAI_LIFF_CHANNEL_ID; };
const ADMIN = 'U' + 'a'.repeat(32);
const OTHER = 'U' + 'b'.repeat(32);
const flexOf = (msgs) => msgs.find(m => m.type === 'flex');
const allActions = (o, out = []) => { if (o && typeof o === 'object') { if (o.action) out.push(o.action); for (const v of Object.values(o)) allActions(v, out); } return out; };
const tomorrow = () => cal.addDays(cal.todayKey(), 1);

// ── 純函式 ─────────────────────────────────────────

await test('清理：postback／message 按鈕拿掉、空的 footer 拿掉；網址只留 https 且不是小帥的行事曆／LIFF', () => {
  const card = cal.eventFlex({ id: 1, day: '2026-11-05', time: '19:00', title: '家長會', place: '學校', created_by_name: '葶' }, { url: 'https://bot.example.test/public/cal/' + 'f'.repeat(32) + '.html#k=SECRET' });
  assert.ok(allActions(card).some(a => a.type === 'postback'));
  const r = sc.sanitize([{ type: 'text', text: '看一下' }, card], { host: 'bot.example.test', liffId: LIFF });
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[1].contents.footer, undefined);          // 刪掉、這週行程（postback）、看整個月（帶編輯碼）都拿掉 → footer 空了整個拿掉
  assert.ok(r.dropped >= 2);
  assert.ok(!JSON.stringify(r.messages).includes('#k='));
  // 各種網址
  const btn = (uri) => ({ type: 'button', action: { type: 'uri', label: 'x', uri } });
  const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [
    { type: 'text', text: 'hi' }, btn('https://niujiu.vercel.app/event/ev1'), btn('http://plain.example'), btn('javascript:alert(1)'),
    btn(`https://liff.line.me/${LIFF}?p=share`), btn('https://bot.example.test/x/xiaoshuai/share/list'), btn('https://other.example/a?t=' + 'a'.repeat(32)),
    { type: 'button', action: { type: 'message', label: 'm', text: '小帥 刪掉' } }, { type: 'video', url: 'https://v.example/a.mp4' },
    { type: 'image', url: 'https://img.example/a.png' }, { type: 'image', url: 'http://img.example/a.png' },
  ] } };
  const out = sc.sanitize({ type: 'flex', altText: 'a', contents: bubble }, { host: 'bot.example.test', liffId: LIFF }).messages[0].contents.body.contents;
  assert.deepEqual(out.map(c => c.type), ['text', 'button', 'image']);
  assert.equal(out[1].action.uri, 'https://niujiu.vercel.app/event/ev1');
});

await test('清理：編碼、大小寫、結尾點、雙斜線、line.me 其他 LIFF 網址都擋；文字裡的這類連結也拿掉', () => {
  const o = { host: 'bot.example.test', liffId: LIFF };
  const bad = ['https://bot.example.test/%78/xiaoshuai/share/list', 'https://BOT.example.test./x/a', 'https://bot.example.test/public//cal/a.html',
    'https://a.example/?T=' + 'A'.repeat(32), 'https://a.example/%23k=abc', `https://line.me/R/app/${LIFF}`, `https://miniapp.line.me/${LIFF}`];
  for (const u of bad) {
    const r = sc.sanitize({ type: 'flex', altText: 'a', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x' }, { type: 'button', action: { type: 'uri', label: 'x', uri: u } }] } } }, o);
    assert.equal(r.messages[0].contents.body.contents.length, 1, u);
  }
  const t = sc.sanitize([{ type: 'text', text: `看這個 https://bot.example.test/public/cal/${'a'.repeat(32)}.html#k=SECRET 跟 https://niujiu.vercel.app/event/ev1` }], o).messages[0].text;
  assert.ok(!t.includes('SECRET') && !t.includes('/public/cal/'));
  assert.match(t, /（連結已拿掉）.*https:\/\/niujiu\.vercel\.app\/event\/ev1/);
  const f = sc.sanitize({ type: 'flex', altText: `https://liff.line.me/${LIFF}?p=share`, contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: `https://line.me/R/app/${LIFF}` }] } } }, o).messages[0];
  assert.ok(!JSON.stringify(f).includes(LIFF));
});

await test('清理：只收文字／圖片／Flex；最多 5 則；太深太多擋；文字限長、控制字元拿掉', () => {
  assert.match(sc.sanitize([{ type: 'template', altText: 'a', template: {} }]).error, /沒有能轉發/);
  assert.match(sc.sanitize(Array.from({ length: 6 }, (_, i) => ({ type: 'text', text: `t${i}` }))).error, /最多 5 則/);
  let deep = { type: 'text', text: 'x' };
  for (let i = 0; i < 20; i++) deep = { type: 'box', layout: 'vertical', contents: [deep] };
  assert.match(sc.sanitize({ type: 'flex', altText: 'a', contents: { type: 'bubble', body: deep } }).error, /太複雜/);
  const many = { type: 'box', layout: 'vertical', contents: Array.from({ length: 500 }, () => ({ type: 'text', text: 'x' })) };
  assert.match(sc.sanitize({ type: 'flex', altText: 'a', contents: { type: 'bubble', body: many } }).error, /太複雜/);
  const t = sc.sanitize({ type: 'text', text: `a\u0007b${'c'.repeat(3000)}`, quickReply: { items: [] }, sender: { name: '假冒' } }).messages[0];
  assert.deepEqual(Object.keys(t), ['type', 'text']);
  assert.equal(t.text.length, 2000);
  assert.ok(!t.text.includes('\u0007'));
  const f = sc.sanitize({ type: 'flex', altText: '', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x' }] } } }).messages[0];
  assert.equal(f.altText, '小帥的卡片');
});

await test('貼上的 JSON：單則、陣列、{messages}、光 bubble／carousel 都收；壞的、太長的講清楚', () => {
  assert.equal(sc.parsePasted('{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}').messages[0].type, 'flex');
  assert.equal(sc.parsePasted('[{"type":"text","text":"a"},{"type":"text","text":"b"}]').messages.length, 2);
  assert.equal(sc.parsePasted('{"messages":[{"type":"text","text":"a"}]}').messages.length, 1);
  assert.match(sc.parsePasted('{bad').error, /JSON/);
  assert.match(sc.parsePasted('').error, /還沒貼/);
  assert.match(sc.parsePasted('x'.repeat(13000)).error, /太長/);
});

await test('開頭那句：換掉第一則文字、沒有就補上、空白就拿掉', () => {
  const card = { type: 'flex', altText: 'a', contents: {} };
  assert.deepEqual(sc.withIntro([{ type: 'text', text: '舊' }, card], '新的'), [{ type: 'text', text: '新的' }, card]);
  assert.deepEqual(sc.withIntro([card], '補一句'), [{ type: 'text', text: '補一句' }, card]);
  assert.deepEqual(sc.withIntro([{ type: 'text', text: '舊' }, card], '  '), [card]);
  assert.equal(sc.withIntro([card], 'x'.repeat(400))[0].text.length, 300);
});

await test('私訊卡片的按鈕：每張卡都加、橫排 footer 包起來、沒有 footer 就補；網址帶卡片代號', () => {
  const uri = sc.shareUrl(LIFF, 'cal:week');
  assert.equal(uri, `https://liff.line.me/${LIFF}?p=share&c=cal%3Aweek`);
  assert.equal(sc.shareUrl(LIFF, 'bad key'), `https://liff.line.me/${LIFF}?p=share`);
  const ev = cal.eventFlex({ id: 1, day: '2026-11-05', time: null, title: '家長會' });
  const out = sc.addShareButton([{ type: 'text', text: 'a' }, ev], uri);
  assert.equal(out[0].text, 'a');
  const f = out[1].contents.footer;
  assert.equal(f.contents.at(-1).action.uri, uri);
  const two = { type: 'bubble', footer: { type: 'box', layout: 'horizontal', contents: [{ type: 'button', action: { type: 'uri', label: 'a', uri: 'https://a.example' } }] } };
  const car = sc.addShareButton([{ type: 'flex', altText: 'a', contents: { type: 'carousel', contents: [two, { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } }] } }], uri)[0].contents.contents;
  assert.equal(car[0].footer.layout, 'vertical');
  assert.equal(car[0].footer.contents[0].layout, 'horizontal');
  assert.equal(car[1].footer.contents[0].action.label, '📤 用我的帳號發');
  assert.ok(sc.keyOk('cal:2026-11-01~2026-11-30') && sc.keyOk('nj:ev1abcdef') && sc.keyOk('kb:12') && sc.keyOk('cal:e5'));
  assert.ok(!sc.keyOk('cal:del:5') && !sc.keyOk('nj:../x') && !sc.keyOk('kb:abc') && !sc.keyOk(null));
});

// ── 接上小帥 ───────────────────────────────────────

const NJ_EVENTS = {
  ev1abcdef: { title: '大安森林公園野餐', startDate: '2099-11-08', startTime: '10:00', location: '大安森林公園', hostName: '妞媽', feeMode: 'free' },
  ev2abcdef: { title: '陽明山親子健行', startDate: '2099-11-15', startTime: '09:00', location: '陽明山', hostName: '多媽', feeMode: 'free' },
};
let njDown = false;
const fakeNjFs = async () => {
  if (njDown) throw new Error('firestore down');
  return { collection: () => ({
    doc: (id) => ({ get: async () => ({ exists: !!NJ_EVENTS[id], data: () => NJ_EVENTS[id] }) }),
    where: () => ({ limit: () => ({ get: async () => ({ docs: Object.entries(NJ_EVENTS).map(([id, d]) => ({ id, data: () => d })).reverse() }) }) }),
  }) };
};
const GROUPS = [{ id: 'GSRC', name: '滑雪群' }, { id: 'C_NJ', name: '妞揪親子團' }];

async function bot() {
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(':memory:');
  const db = { run: (q, ...a) => raw.prepare(q).run(...a), get: (q, ...a) => raw.prepare(q).get(...a), all: (q, ...a) => raw.prepare(q).all(...a), exec: (q) => raw.exec(q) };
  const replies = []; const pushes = [];
  const lineApi = { reply: async (_t, m) => { replies.push(Array.isArray(m) ? m : [{ type: 'text', text: m }]); return {}; }, push: async (to, m) => { pushes.push({ to, m }); },
    getGroupMemberProfile: async () => null, getProfile: async () => ({ displayName: 'TED' }), getGroupMemberCount: async (id) => (id === 'C_NJ' ? 25 : 2), getQuota: async () => ({ limit: 200, used: 150 }) };
  const ctx = { db, lineApi, isAdmin: (u) => u === ADMIN, providers: { llm: { generate: async () => ({ text: '{"reply":"在喔"}' }) } } };
  await xiaoshuai.init(ctx);
  db.run("INSERT INTO groups (chat_id, enabled) VALUES ('GSRC', 1)");
  await xiaoshuai.init(ctx);
  share.initShare(db, { firestore: fakeNjFs, groups: async () => GROUPS, members: async (id) => (id === 'C_NJ' ? 25 : 2), quota: async () => ({ limit: 200, used: 150 }) });
  xiaoshuai._calResetRate();
  const routes = {};
  xiaoshuai.http({ get: (p, fn) => { routes[`GET ${p}`] = fn; }, post: (p, fn) => { routes[`POST ${p}`] = fn; } });
  caledit.setVerifier(async (tok) => ({ 'tok-ted': { userId: ADMIN, name: 'TED' }, 'tok-other': { userId: OTHER, name: '路人' } })[tok] || null);
  const api = async (name, body = {}, { idt = 'tok-ted', origin = 'https://bot.example.test', client = '1', json = true, ip = '203.0.113.7' } = {}) => {
    let status = 200; let out = null;
    const headers = { origin, 'x-cal-client': client, 'cf-connecting-ip': ip, 'content-length': '0' };
    const req = { body: { id: idt, ...body }, is: (t) => json && t === 'application/json', get: (h) => headers[h.toLowerCase()], ip: '127.0.0.1' };
    const res = { status(s) { status = s; return this; }, set() { return this; }, json(j) { out = j; return this; } };
    await routes[`POST /share/${name}`](req, res);
    return { status, ...out };
  };
  let seq = 5000;
  const dm = async (text) => { const n = replies.length; const id = String(++seq); await xiaoshuai.onPrivateText({ userId: ADMIN, text, replyToken: `d${id}`, event: { message: { type: 'text', id, text } } }); return replies.length > n ? replies.at(-1) : null; };
  return { db, replies, pushes, routes, api, dm };
}

await test('私訊「發卡片」：LIFF 沒設定 → 講清楚還沒開通、照舊可叫小帥代貼；設定後 → 打開發卡片頁的按鈕', async () => {
  liffOff();
  const { dm } = await bot();
  const r = await dm('發卡片');
  assert.match(r[0].text, /還沒開通.*LIFF ID 和 Channel ID/s);
  assert.match(r[0].text, /小帥代貼/);
  liffOn();
  const r2 = await dm('小帥 發卡片');
  assert.equal(r2[0].type, 'flex');
  assert.equal(r2[0].contents.footer.contents[0].action.uri, `https://liff.line.me/${LIFF}?p=share`);
  liffOff();
});

await test('私訊 TED 的行事曆卡加「📤 用我的帳號發」（LIFF 有設定才加）；群組卡片不加', async () => {
  liffOff();
  const { dm, db } = await bot();
  const r0 = await dm(`小帥 記一下 ${tomorrow().slice(5).replace('-', '/')} 晚上七點 家長會`);
  assert.equal(r0[0].text, '記好了 📅');
  assert.ok(!JSON.stringify(r0).includes('liff.line.me'));
  liffOn();
  const r = await dm(`小帥 記一下 ${tomorrow().slice(5).replace('-', '/')} 早上九點 牙醫`);
  const id = db.get("SELECT id FROM cal_events WHERE title = '牙醫'").id;
  assert.ok(allActions(flexOf(r)).some(a => a.uri === sc.shareUrl(LIFF, `cal:e${id}`)));
  const q = await dm('小帥 這週有什麼事');
  assert.ok(allActions(flexOf(q)).some(a => /p=share&c=cal%3A\d{4}-\d{2}-\d{2}~/.test(a.uri || '')));
  // 群組的卡片沒有
  const ev = cal.add('GSRC', { day: tomorrow(), title: '群組的事' }).event;
  const groupCard = cal.eventFlex(ev);
  assert.ok(!allActions(groupCard).some(a => /liff\.line\.me/.test(a.uri || '')));
  liffOff();
});

await test('/x/xiaoshuai/share/*：LIFF 沒設定 503；同源＋JSON＋自訂標頭；LINE 驗過、是 TED 才給；頻率限制', async () => {
  liffOff();
  const { api, db } = await bot();
  assert.equal((await api('list')).status, 503);
  liffOn();
  assert.equal((await api('list', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('list', {}, { client: null })).status, 400);
  assert.equal((await api('list', {}, { json: false })).status, 400);
  assert.equal((await api('list', {}, { idt: 'fake' })).status, 401);
  const other = await api('list', {}, { idt: 'tok-other' });
  assert.equal(other.status, 403);
  assert.match(other.error, /只有 TED/);
  assert.equal(db.get("SELECT COUNT(*) n FROM cal_anomaly WHERE kind = 'share'").n, 1);
  assert.equal((await api('list', { pad: 'x'.repeat(17000) })).status, 413);
  // 同一個 IP 一分鐘 30 次
  let last = null;
  for (let i = 0; i < 31; i++) last = await api('build', { key: 'kb:999' }, { ip: '198.51.100.1' });
  assert.equal(last.status, 429);
  assert.equal((await api('list', {}, { ip: '198.51.100.2' })).ok, true);   // 別的 IP 不受影響
  liffOff();
});

await test('清單：行事曆（這週、下週、還沒過的事）、妞揪活動（日期近的在前）、小卡；妞揪掛了只說拿不到', async () => {
  liffOn();
  const { api } = await bot();
  const ev = cal.add(ADMIN, { day: tomorrow(), time: '19:00', title: '家長會' }).event;
  kb.save({ title: '日本退稅新制', keywords: ['退稅'], cards: [{ title: '重點', lines: ['海關確認'] }] }, '原文');
  const r = await api('list');
  assert.equal(r.ok, true);
  assert.deepEqual(r.cal.slice(0, 2).map(x => x.key), ['cal:week', 'cal:next_week']);
  assert.ok(r.cal.some(x => x.key === `cal:e${ev.id}` && x.label === '家長會'));
  assert.deepEqual(r.nj.map(x => x.key), ['nj:ev1abcdef', 'nj:ev2abcdef']);
  assert.match(r.nj[0].sub, /11\/8/);
  assert.equal(r.kb[0].label, '日本退稅新制');
  assert.match(r.kb[0].key, /^kb:\d+$/);
  njDown = true;
  const r2 = await api('list');
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.nj, []);
  assert.match(r2.njError, /拿不到/);
  njDown = false;
  liffOff();
});

await test('組卡片：行事曆沒有小帥專用按鈕、沒有帶編輯碼的網址；別人的事拿不到；妞揪有報名；小卡；開頭那句可換', async () => {
  liffOn();
  const { api } = await bot();
  const mine = cal.add(ADMIN, { day: tomorrow(), time: '19:00', title: '家長會', place: '學校' }).event;
  const others = cal.add(OTHER, { day: tomorrow(), title: '別人的私事' }).event;
  const w = await api('build', { key: 'cal:week' });
  assert.equal(w.ok, true);
  const acts = allActions(w.messages);
  assert.ok(acts.every(a => a.type === 'uri'));
  assert.ok(!JSON.stringify(w.messages).includes('/public/cal/'));
  assert.ok(!JSON.stringify(w.messages).includes('別人的私事'));
  const e = await api('build', { key: `cal:e${mine.id}` });
  assert.match(e.messages[0].text, /家長會/);
  assert.equal(e.messages[1].contents.footer, undefined);
  assert.ok(!JSON.stringify(e.messages).includes('提醒'));                          // 小帥的早報提醒不轉給別人
  assert.ok(e.dropped >= 2);
  assert.equal((await api('build', { key: `cal:e${others.id}` })).status, 404);
  assert.equal((await api('build', { key: 'cal:2026-01-01~2026-12-31' })).status, 404);   // 範圍太長
  const n = await api('build', { key: 'nj:ev1abcdef', intro: '週末來野餐 🧺' });
  assert.equal(n.messages[0].text, '週末來野餐 🧺');
  assert.equal(allActions(n.messages)[0].uri, 'https://niujiu.vercel.app/event/ev1abcdef');
  assert.equal((await api('build', { key: 'nj:nosuchevt' })).status, 404);
  const row = kb.save({ title: '日本退稅新制', keywords: ['退稅'], cards: [{ title: '重點', lines: ['海關確認'] }] }, '原文');
  const k = await api('build', { key: `kb:${row.id}`, intro: '' });
  assert.equal(k.messages[0].type, 'flex');
  assert.equal((await api('build', { key: 'cal:del:1' })).status, 400);
  liffOff();
});

await test('組卡片：貼上的 JSON 一樣清理（postback 拿掉、壞網址拿掉）；格式錯講清楚', async () => {
  liffOn();
  const { api } = await bot();
  const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '自己做的卡' }] },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'button', action: { type: 'postback', label: '偷按', data: 'cal:del:1' } },
      { type: 'button', action: { type: 'uri', label: '官網', uri: 'https://example.com/' } },
      { type: 'button', action: { type: 'uri', label: '壞', uri: 'javascript:alert(1)' } },
    ] } });
  const r = await api('build', { json });
  assert.equal(r.ok, true);
  assert.equal(r.dropped, 2);
  assert.deepEqual(allActions(r.messages), [{ type: 'uri', label: '官網', uri: 'https://example.com/' }]);
  assert.match((await api('build', { json: '{oops' })).error, /JSON/);
  assert.match((await api('build', { json: '[{"type":"sticker"}]' })).error, /沒有能轉發/);
  liffOff();
});

await test('妞揪活動分享（LIFF 有設定）：預設給「📤 用我的帳號發」，認得出群組就附好／推當備用；沒講群組就不卡住下一句', async () => {
  liffOn();
  const { dm, pushes, db } = await bot();
  const r = await dm('小帥 把 https://niujiu.vercel.app/event/ev2abcdef 貼到妞揪親子團');
  assert.match(r[0].text, /^「陽明山親子健行」點下面「📤 用我的帳號發」，選「妞揪親子團」送出就好（用你自己的帳號發，不扣小帥的推播額度）。/);
  assert.match(r[0].text, /回「推」＝馬上推播（會扣 25 則，本月剩 50 則）/);
  const acts = allActions(r[1]);
  assert.ok(acts.some(a => a.uri === 'https://niujiu.vercel.app/event/ev2abcdef'));
  assert.ok(acts.some(a => a.uri === sc.shareUrl(LIFF, 'nj:ev2abcdef')));
  assert.equal(pushes.length, 0);
  assert.match((await dm('推'))[0].text, /推播出去了/);             // 備用照舊
  assert.equal(pushes.length, 1);
  // 群組對不到：只給按鈕，不問「是哪個群」（下一句不會被當成群組名稱）
  const r2 = await dm('小帥 把 https://niujiu.vercel.app/event/ev1abcdef 分享到不存在群組');
  assert.match(r2[0].text, /選群組或好友送出就好[\s\S]*把剛剛那團貼到○○群/);
  assert.equal(share.pendingOf(ADMIN), null);
  // 之後要小帥代貼：「把剛剛那團貼到…」接得上
  assert.match((await dm('小帥 把剛剛那團貼到妞揪親子團'))[0].text, /「大安森林公園野餐」.*選「妞揪親子團」/);
  assert.match((await dm('好'))[0].text, /排好了 👍「大安森林公園野餐」/);
  assert.equal(db.get("SELECT COUNT(*) n FROM share_jobs WHERE mode = 'reply'").n, 1);
  liffOff();
});

await test('妞揪活動分享（LIFF 沒設定）：照舊問好／推，不出現 LIFF 連結', async () => {
  liffOff();
  const { dm } = await bot();
  const r = await dm('小帥 把 https://niujiu.vercel.app/event/ev2abcdef 貼到妞揪親子團');
  assert.match(r[0].text, /^要把「陽明山親子健行」貼到「妞揪親子團」嗎？/);
  assert.ok(!JSON.stringify(r).includes('liff.line.me'));
});

caledit.setVerifier(null);
console.log(`\n${pass} 項全過`);
process.exit(0);
