/**
 * 小帥主動提議（nudge.js）測試：回答判斷、每天上限、同一件事只問一次、沒人理就停、行事曆沒人反對就記
 * 不打 AI、不連 LINE。執行：node tests/test-nudge.mjs
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const nudge = await import('../plugins/xiaoshuai/nudge.js');

function memDb() {
  const d = new Database(':memory:');
  return {
    exec: (s) => d.exec(s),
    get: (s, ...a) => d.prepare(s).get(...a),
    all: (s, ...a) => d.prepare(s).all(...a),
    run: (s, ...a) => d.prepare(s).run(...a),
  };
}

let pass = 0;
function test(name, fn) { fn(); pass++; console.log(`✓ ${name}`); }

// 台北 2026-11-17 10:00
const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const MIN = 60_000;
const G = 'Cgroup1';

nudge.initNudge(memDb());

test('回答：短句才算，好／+1／不要', () => {
  for (const t of ['好', '好啊', '好喔～', '+1', 'OK', '可以', '小帥 好', '好啊謝謝', '要']) assert.equal(nudge.parseAnswer(t), 'yes', t);
  for (const t of ['不要', '不用了', '算了', '先不要啦', '免']) assert.equal(nudge.parseAnswer(t), 'no', t);
  for (const t of ['好想吃燒肉喔真的', '好累', '不要再遲到了啦大家都在等', '那個好不好吃', '']) assert.equal(nudge.parseAnswer(t), null, t);
});

test('粗篩：地圖連結→food、兩人在選→vote、一人自言自語不算', () => {
  const buf2 = [{ userId: 'a', ts: NOW - MIN }, { userId: 'b', ts: NOW - 30_000 }];
  const buf1 = [{ userId: 'a', ts: NOW - MIN }];
  assert.equal(nudge.prefilter('這家超好吃 https://maps.app.goo.gl/abc123', [], { now: NOW }), 'food');
  assert.equal(nudge.prefilter('晚上吃什麼啦', buf2, { now: NOW }), 'vote');
  assert.equal(nudge.prefilter('晚上吃什麼啦', buf1, { now: NOW }), null);
  assert.equal(nudge.prefilter('週六九點練球', [], { now: NOW, looksLikeCalendar: () => true }), 'calendar');
  assert.equal(nudge.prefilter('/小帥 狀態', buf2, { now: NOW }), null);
  assert.equal(nudge.prefilter('哈哈哈', buf2, { now: NOW }), null);
});

test('熱聊不插嘴：1 分鐘內別人 5 則以上', () => {
  const hot = Array.from({ length: 5 }, (_, i) => ({ userId: 'u' + i, ts: NOW - i * 5000 }));
  assert.equal(nudge.busy(hot, NOW), true);
  assert.equal(nudge.canAsk(G, 'vote', { buf: hot, now: NOW }).why, 'busy');
  assert.equal(nudge.busy(hot.slice(0, 4), NOW), false);
});

test('問過一次：等回答時不問別的，同一件事不再問', () => {
  assert.equal(nudge.canAsk(G, 'calendar', { key: 'cal:2026-11-21:練球', now: NOW }).ok, true);
  nudge.open(G, { kind: 'calendar', key: 'cal:2026-11-21:練球', payload: { day: '2026-11-21', time: '09:00', title: '練球' }, question: 'q' }, NOW);
  assert.equal(nudge.canAsk(G, 'vote', { now: NOW + MIN }).why, 'pending');
  assert.equal(nudge.answer(G, 'x', '好啊', NOW + 2 * MIN).answer, 'yes');
  assert.equal(nudge.pendingOf(G, NOW + 2 * MIN), null);
  assert.equal(nudge.canAsk(G, 'calendar', { key: 'cal:2026-11-21:練球', now: NOW + 3 * MIN }).why, 'asked');
});

test('每天上限：少＝2 次，換日歸零；關掉就不問', () => {
  nudge.open(G, { kind: 'vote', key: 'vote:1', payload: {}, question: 'q' }, NOW + 4 * MIN);
  nudge.answer(G, 'x', '好', NOW + 5 * MIN);
  assert.equal(nudge.canAsk(G, 'vote', { key: 'vote:2', now: NOW + 6 * MIN }).why, 'cap');
  const tomorrow = NOW + 24 * 3600_000;
  assert.equal(nudge.canAsk(G, 'vote', { key: 'vote:2', now: tomorrow }).ok, true);
  nudge.setMode(G, 'off', tomorrow);
  assert.equal(nudge.canAsk(G, 'vote', { key: 'vote:2', now: tomorrow }).why, 'off');
  nudge.setMode(G, 'on', tomorrow);
  assert.equal(nudge.canAsk(G, 'vote', { key: 'vote:2', now: tomorrow }).ok, true);
});

test('被說不要：這一類今天不再問，別類照常', () => {
  const g = 'Cgroup2';
  nudge.open(g, { kind: 'vote', key: 'v1', payload: {}, question: 'q' }, NOW);
  assert.equal(nudge.answer(g, 'x', '不用', NOW + MIN).answer, 'no');
  assert.equal(nudge.canAsk(g, 'vote', { key: 'v2', now: NOW + 2 * MIN }).why, 'declined');
  assert.equal(nudge.canAsk(g, 'calendar', { key: 'c1', now: NOW + 2 * MIN }).ok, true);
});

test('收美食只認貼的人回', () => {
  const g = 'Cgroup3';
  nudge.open(g, { kind: 'food', key: 'food:u', payload: { url: 'u' }, onlyUser: 'poster', question: 'q' }, NOW);
  assert.equal(nudge.answer(g, 'other', '好', NOW + MIN), null);
  assert.ok(nudge.pendingOf(g, NOW + MIN));
  assert.equal(nudge.answer(g, 'poster', '好', NOW + 2 * MIN).answer, 'yes');
});

test('過期：行事曆沒人反對就記，其他算沒人理；連續 2 次沒人理今天停', () => {
  const g = 'Cgroup4';
  nudge.setMode(g, 'on', NOW);
  nudge.open(g, { kind: 'calendar', key: 'cal:x', payload: { day: '2026-11-21', title: '練球' }, question: 'q' }, NOW);
  const due = nudge.sweep(NOW + nudge.ASK_TTL_MS + 1);
  assert.equal(due.filter(p => p.chatId === g).length, 1);
  assert.equal(due.find(p => p.chatId === g).payload.title, '練球');
  let t = NOW + nudge.ASK_TTL_MS + 2;
  for (const k of ['v1', 'v2']) {
    nudge.open(g, { kind: 'vote', key: k, payload: {}, question: 'q' }, t);
    t += nudge.ASK_TTL_MS + 1;
    assert.equal(nudge.sweep(t).filter(p => p.chatId === g).length, 0);
  }
  assert.equal(nudge.canAsk(g, 'calendar', { key: 'c9', now: t }).why, 'ignored');
  const st = nudge.stats(g, t);
  assert.equal(st.silent, 1);
  assert.equal(st.ignored, 2);
});

test('問句是一句話', () => {
  assert.equal(nudge.calendarQuestion({ label: '11/21（六） 09:00', title: '練球', place: '河濱球場' }), '要幫大家記到行事曆嗎？11/21（六） 09:00 練球 📍河濱球場');
  assert.equal(nudge.voteQuestion(['燒肉', '拉麵']), '要不要開個投票？燒肉、拉麵');
  assert.equal(nudge.foodQuestion('妞媽'), '妞媽，要把這家收進我們的美食嗎？');
});

console.log(`\n${pass} 項通過`);
